/**
 * Provider-backed funding, refund and webhook processing (master §8.3–8.5).
 *
 * - Orders become FUNDED only from a verified provider webhook fact; there is no client markPaid.
 * - Every remote call has a durable `app.provider_operations` journal row with a stable operation id
 *   and request hash; an UNKNOWN outcome is retried with the same id.
 * - Webhooks: verify signature → persist inbox (unique provider+mode+event) → process under row
 *   locks → ledger + order transition + outbox in one transaction → processed marker.
 * - Platform fee stays 0; provider cost is recorded as a separate fact.
 *
 * Only the local MockPaymentProvider is wired. It is refused in production and when PAYMENT_MODE
 * is not `mock`.
 */
import type postgres from 'postgres';
import { sql } from '@/lib/db';
import { activateOrderClaim } from '@/modules/capacity';
import { recomputeWorkClock } from '@/modules/orders/lifecycle';
import { fulfillDigitalOrder } from '@/modules/digital';
import { isFlagEnabled } from '@/modules/admin/policy';
import { COST_POLICY_VERSION, lateCostCapBps, lateCostShares, type CostPhase } from './cost-policy';
import { enqueueChainPayout, registerPayoutEffects } from '@/modules/crypto/payouts';
import { atomicToUsdMinor, escrowReference, usdMinorToAtomic } from '@/modules/crypto/registry';
import {
  MockPaymentProvider,
  computeRequestHash,
  isProviderError,
  type FundingInput,
  type ReleaseInput,
  type RefundInput,
  type RefundReason,
  type ReversalInput,
  type VerifiedEvent,
} from './providers';

type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;

export const MOCK_PROVIDER = 'mock';
const MOCK_ACCOUNT_ID = 'acct_mock_local';
/** Public local-development fixture, like the `local_dev_only` DB password. Never used in production. */
const LOCAL_MOCK_WEBHOOK_SECRET = 'whsec_local_dev_only_fixture';

export type PaymentFlowErrorCode = 'FORBIDDEN' | 'INVALID_STATE' | 'IDEMPOTENCY_CONFLICT' | 'UNAVAILABLE';

export class PaymentFlowError extends Error {
  constructor(message: string, readonly code: PaymentFlowErrorCode) {
    super(message);
    this.name = 'PaymentFlowError';
  }
}

export function mockPaymentsEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    (process.env.PAYMENT_MODE ?? 'mock') === 'mock' &&
    process.env.LIVE_PAYMENTS_ENABLED !== 'true'
  );
}

const providerStore = globalThis as typeof globalThis & { __ccmMockPaymentProvider?: MockPaymentProvider };

export function getMockPaymentProvider(): MockPaymentProvider {
  if (!mockPaymentsEnabled()) throw new PaymentFlowError('Local mock payments are disabled in this environment', 'UNAVAILABLE');
  providerStore.__ccmMockPaymentProvider ??= new MockPaymentProvider({
    accountId: MOCK_ACCOUNT_ID,
    webhookSecrets: [process.env.MOCK_PAYMENT_WEBHOOK_SECRET || LOCAL_MOCK_WEBHOOK_SECRET],
  });
  return providerStore.__ccmMockPaymentProvider;
}

/** Test seam for failure injection. Refused outside local/test mock mode. */
export function setMockPaymentProviderForTests(provider: MockPaymentProvider | undefined): void {
  if (!mockPaymentsEnabled()) throw new PaymentFlowError('Mock provider override is disabled', 'UNAVAILABLE');
  providerStore.__ccmMockPaymentProvider = provider;
}

const payeeAccountFor = (creatorId: unknown) => `acct_mock_${String(creatorId).replaceAll('-', '')}`;

function mockProviderFee(amount: bigint): bigint {
  const bps = Number(process.env.MOCK_PROVIDER_FEE_BPS ?? '0');
  if (!Number.isInteger(bps) || bps < 0 || bps > 1000) return 0n;
  return (amount * BigInt(bps)) / 10_000n;
}

export type ProviderCallResult =
  | { state: 'READY'; operationId: string; reference: string }
  | { state: 'RETRY'; operationId: string; code: string }
  | { state: 'REJECTED'; operationId: string; code: string };

async function journal(tx: Tx, operationId: string, orderId: string, kind: string, requestHash: string): Promise<Row> {
  await tx`insert into app.provider_operations (operation_id,order_id,kind,request_hash,provider,status)
    values (${operationId},${orderId},${kind},${requestHash},${MOCK_PROVIDER},'PENDING') on conflict (operation_id) do nothing`;
  const [row] = await tx<Row[]>`select * from app.provider_operations where operation_id=${operationId} for update`;
  if (!row || row.request_hash !== requestHash || row.kind !== kind) {
    throw new PaymentFlowError('Provider operation id was already used for a different request', 'IDEMPOTENCY_CONFLICT');
  }
  return row;
}

async function recordCallFailure(tx: Tx, operationId: string, error: unknown): Promise<ProviderCallResult> {
  if (!isProviderError(error)) throw error;
  const unknown = error.outcome === 'UNKNOWN';
  const status = unknown ? 'UNKNOWN' : error.retryable ? 'PENDING' : 'FAILED';
  await tx`update app.provider_operations set status=${status},
    outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('lastError',${error.code}::text),updated_at=now()
    where operation_id=${operationId} and status<>'SUCCEEDED'`;
  return { state: unknown || error.retryable ? 'RETRY' : 'REJECTED', operationId, code: error.code };
}

/** The checkout hold funding converts: the creator's workload claim, or the entitlement of a DIGITAL purchase (XPL-04). */
async function lockCheckoutHold(tx: Tx, orderId: string): Promise<Row | undefined> {
  const [claim] = await tx<Row[]>`select id,state from app.workload_claims where order_id=${orderId} for update`;
  if (claim) return claim;
  const [entitlement] = await tx<Row[]>`select id,state from app.digital_entitlements where order_id=${orderId} for update`;
  return entitlement;
}

/**
 * Creates (or replays) the funding intent for an order the buyer owns. Commits the journal row even
 * when the provider outcome is UNKNOWN, so the next attempt reuses the same operation id.
 */
export async function ensureFundingIntent(tx: Tx, buyerId: string, orderId: string): Promise<ProviderCallResult> {
  const provider = getMockPaymentProvider();
  if (!(await isFlagEnabled(tx, 'CHECKOUT_CREATION_ENABLED'))) throw new PaymentFlowError('Checkout is temporarily paused; existing payments and refunds continue', 'UNAVAILABLE');
  const [order] = await tx<Row[]>`select id,buyer_id,creator_id,status,payment_status,amount_minor,platform_fee_minor,currency from app.orders where id=${orderId} for update`;
  if (!order || String(order.buyer_id) !== buyerId) throw new PaymentFlowError('Order not found or not funded by this account', 'FORBIDDEN');
  if (order.status !== 'AWAITING_PAYMENT' || !['PENDING', 'PROCESSING', 'FAILED'].includes(String(order.payment_status))) {
    throw new PaymentFlowError('This order is not awaiting payment', 'INVALID_STATE');
  }
  const claim = await lockCheckoutHold(tx, orderId);
  if (claim?.state !== 'HELD') throw new PaymentFlowError('The reservation for this order is no longer active', 'INVALID_STATE');

  // Reuse the latest attempt unless the provider reported it FAILED/CANCELED or rejected it outright.
  const attempts = await tx<Row[]>`select operation_id,status,outcome from app.provider_operations where order_id=${orderId} and kind='funding.create' order by created_at asc`;
  const latest = attempts.at(-1);
  const latestFundingStatus = String((latest?.outcome as Row | null)?.fundingStatus ?? '');
  const reuse = latest && latest.status !== 'FAILED' && !['FAILED', 'CANCELED'].includes(latestFundingStatus);
  const operationId = reuse ? String(latest.operation_id) : `fund:${orderId}:${attempts.length + 1}`;

  const input: FundingInput = {
    orderId,
    buyerId,
    payeeAccountId: payeeAccountFor(order.creator_id),
    amount: BigInt(String(order.amount_minor)),
    currency: String(order.currency),
    platformFee: BigInt(String(order.platform_fee_minor)),
  };
  await journal(tx, operationId, orderId, 'funding.create', computeRequestHash('funding.create', input));
  if (!reuse && order.payment_status === 'FAILED') {
    await tx`update app.orders set payment_status='PENDING',version=version+1,updated_at=now() where id=${orderId}`;
  }
  try {
    const intent = await provider.createFundingIntent(input, operationId);
    await tx`update app.provider_operations set status='SUCCEEDED',provider_reference=${intent.reference},
      outcome=coalesce(outcome,'{}'::jsonb)-'lastError',updated_at=now() where operation_id=${operationId}`;
    return { state: 'READY', operationId, reference: intent.reference };
  } catch (error) {
    return recordCallFailure(tx, operationId, error);
  }
}

/** Local stand-in for the provider's hosted checkout: the buyer confirms at the "provider", which then sends signed webhooks. */
export async function completeMockCheckout(buyerId: string, orderId: string, outcome: 'SUCCEEDED' | 'FAILED') {
  const provider = getMockPaymentProvider();
  const intent = await sql.begin((tx) => ensureFundingIntent(tx, buyerId, orderId));
  if (intent.state !== 'READY') return { intent, receipts: [] as WebhookReceipt[] };
  const status = await provider.getFundingStatus(intent.reference);
  if (status.status === 'REQUIRES_ACTION' || status.status === 'PROCESSING') {
    await provider.simulateFundingOutcome(intent.reference, {
      status: outcome,
      providerFee: outcome === 'SUCCEEDED' ? mockProviderFee(status.amount) : undefined,
    });
  }
  return { intent, receipts: await deliverPendingMockWebhooks() };
}

/**
 * Before cancelling an unpaid order, cancel its open provider intent. If the provider already
 * captured funds, cancellation is refused until the webhook is processed (then refund instead).
 */
export async function cancelOpenFunding(tx: Tx, orderId: string): Promise<void> {
  // A crypto deposit seen on chain but not yet final is an uncertain payment, like an UNKNOWN provider call (CRY-05).
  const [pendingChain] = await tx<Row[]>`select id from app.crypto_payment_intents where order_id=${orderId} and status='PENDING_FINALITY' limit 1`;
  if (pendingChain) throw new PaymentFlowError('A crypto deposit for this order is waiting for finality; retry after it settles', 'INVALID_STATE');
  await tx`update app.crypto_payment_intents set status='CANCELLED',status_reason='Order cancelled before a deposit arrived',updated_at=now()
    where order_id=${orderId} and status='AWAITING_DEPOSIT'`;
  if (!mockPaymentsEnabled()) return;
  const [open] = await tx<Row[]>`select operation_id,provider_reference from app.provider_operations
    where order_id=${orderId} and kind='funding.create' and status='SUCCEEDED' and provider_reference is not null
      and coalesce(outcome->>'fundingStatus','') not in ('FAILED','CANCELED','SUCCEEDED')
    order by created_at desc limit 1`;
  const [unresolved] = await tx<Row[]>`select operation_id from app.provider_operations
    where order_id=${orderId} and kind='funding.create' and status in ('PENDING','UNKNOWN') limit 1`;
  if (unresolved) throw new PaymentFlowError('A payment attempt is still unresolved with the provider; retry payment status before cancelling', 'INVALID_STATE');
  if (!open) return;
  const reference = String(open.provider_reference);
  const operationId = `cancel:${reference}`;
  await journal(tx, operationId, orderId, 'funding.cancel', computeRequestHash('funding.cancel', { reference }));
  try {
    const result = await getMockPaymentProvider().cancelFunding(reference, operationId);
    await tx`update app.provider_operations set status='SUCCEEDED',provider_reference=${reference},updated_at=now() where operation_id=${operationId}`;
    await tx`update app.provider_operations set outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('fundingStatus',${result.status}::text),updated_at=now()
      where operation_id=${String(open.operation_id)} and coalesce(outcome->>'fundingStatus','')<>'SUCCEEDED'`;
  } catch (error) {
    if (isProviderError(error, 'INVALID_STATE')) {
      throw new PaymentFlowError('The provider already confirmed this payment; wait for confirmation, then cancel for a refund', 'INVALID_STATE');
    }
    const recorded = await recordCallFailure(tx, operationId, error);
    const code = recorded.state === 'READY' ? 'UNKNOWN' : recorded.code;
    throw new PaymentFlowError(`Provider cancellation did not complete (${code}); retry`, 'INVALID_STATE');
  }
}

/** Requests a full refund of provider-confirmed funding. The order shows REFUNDED only after the provider confirms. */
export async function requestProviderRefund(tx: Tx, order: Row, reason: RefundReason): Promise<ProviderCallResult> {
  const orderId = String(order.id);
  if (order.payment_rail === 'CRYPTO') return queueCryptoRefund(tx, order);
  if (order.payment_rail === 'POOL') return returnPoolFunding(tx, order);
  const [funding] = await tx<Row[]>`select provider_reference from app.provider_operations
    where order_id=${orderId} and kind='funding.create' and outcome->>'fundingStatus'='SUCCEEDED' order by created_at desc limit 1`;
  if (!funding) throw new PaymentFlowError('No provider-confirmed funding exists for this order', 'INVALID_STATE');
  // A mutually agreed partial refund (ORD-15) uses its own stable operation; otherwise the full principal.
  const agreed = order.cancellation_refund_minor === null || order.cancellation_refund_minor === undefined ? null : BigInt(String(order.cancellation_refund_minor));
  const amount = agreed ?? BigInt(String(order.amount_minor));
  if (amount <= 0n) throw new PaymentFlowError('There is no amount to refund for this order', 'INVALID_STATE');
  const operationId = agreed !== null && agreed < BigInt(String(order.amount_minor)) ? `refund:${orderId}:agreed` : `refund:${orderId}:full`;
  const input: RefundInput = {
    fundingReference: String(funding.provider_reference),
    orderId,
    amount,
    currency: String(order.currency),
    reason,
  };
  const row = await journal(tx, operationId, orderId, 'refund.create', computeRequestHash('refund.create', input));
  try {
    const refund = await getMockPaymentProvider().refund(input, operationId);
    await tx`update app.provider_operations set status='SUCCEEDED',provider_reference=${refund.reference},
      outcome=coalesce(outcome,'{}'::jsonb)-'lastError',updated_at=now() where id=${String(row.id)}`;
    return { state: 'READY', operationId, reference: refund.reference };
  } catch (error) {
    return recordCallFailure(tx, operationId, error);
  }
}

export type FeePayerPolicy = 'CREATOR_AT_COST' | 'PLATFORM_SUBSIDIZED';

/** Who bears the actual provider cost (master §8.1). Sandbox default CREATOR_AT_COST; production must choose explicitly. */
export function feePayerPolicy(): FeePayerPolicy {
  const value = process.env.FEE_PAYER_POLICY;
  if (value === 'CREATOR_AT_COST' || value === 'PLATFORM_SUBSIDIZED') return value;
  if (process.env.NODE_ENV === 'production') throw new PaymentFlowError('FEE_PAYER_POLICY must be chosen before live settlement', 'UNAVAILABLE');
  return 'CREATOR_AT_COST';
}

/**
 * Transfers the creator's entitlement for an approved order under operation `release:<orderId>:full`.
 * The order shows RELEASED only after the provider's release webhook is processed.
 */
export async function requestCreatorRelease(tx: Tx, order: Row): Promise<ProviderCallResult> {
  const orderId = String(order.id);
  if (!(await isFlagEnabled(tx, 'PAYOUT_CREATION_ENABLED'))) throw new PaymentFlowError('New payouts are paused by the payout kill switch', 'UNAVAILABLE');
  if (order.payment_rail === 'CRYPTO') return queueCryptoRelease(tx, order);
  if (order.payment_rail === 'POOL') return settlePoolOrder(tx, order);
  const [funding] = await tx<Row[]>`select provider_reference from app.provider_operations
    where order_id=${orderId} and kind='funding.create' and outcome->>'fundingStatus'='SUCCEEDED' order by created_at desc limit 1`;
  if (!funding) throw new PaymentFlowError('No provider-confirmed funding exists for this order', 'INVALID_STATE');
  // Approved orders release the full entitlement; mutually cancelled orders release the unrefunded remainder.
  const refunded = order.status === 'CANCELLED' && order.cancellation_refund_minor !== null ? BigInt(String(order.cancellation_refund_minor)) : 0n;
  const amount = BigInt(String(order.amount_minor)) - refunded;
  const providerFee = order.provider_fee_minor == null ? 0n : BigInt(String(order.provider_fee_minor));
  const policy = feePayerPolicy();
  const net = policy === 'CREATOR_AT_COST' ? amount - providerFee : amount;
  if (net <= 0n) throw new PaymentFlowError('Creator net would not be positive; resolve the provider cost policy first', 'INVALID_STATE');

  const operationId = refunded > 0n ? `release:${orderId}:remainder` : `release:${orderId}:full`;
  const input: ReleaseInput = {
    fundingReference: String(funding.provider_reference),
    orderId,
    payeeAccountId: payeeAccountFor(order.creator_id),
    amount: net,
    currency: String(order.currency),
    platformFee: BigInt(String(order.platform_fee_minor)),
  };
  const row = await journal(tx, operationId, orderId, 'release.create', computeRequestHash('release.create', input));
  await tx`update app.provider_operations set outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('netAmount',${net.toString()}::text,'providerFee',${providerFee.toString()}::text,'feePolicy',${policy}::text,'grossAmount',${amount.toString()}::text)
    where id=${String(row.id)}`;
  try {
    const release = await getMockPaymentProvider().releaseToCreator(input, operationId);
    await tx`update app.provider_operations set status='SUCCEEDED',provider_reference=${release.reference},
      outcome=coalesce(outcome,'{}'::jsonb)-'lastError',updated_at=now() where id=${String(row.id)}`;
    await tx`update app.orders set settlement_status='PENDING',version=version+1,updated_at=now() where id=${orderId} and settlement_status='READY'`;
    return { state: 'READY', operationId, reference: release.reference };
  } catch (error) {
    const result = await recordCallFailure(tx, operationId, error);
    if (isProviderError(error, 'PAYEE_NOT_CAPABLE')) {
      await openCase(tx, orderId, String(row.id), 'PAYOUT_CAPABILITY_MISSING', 'MEDIUM', 'Creator must finish payout onboarding; the job retries the same release operation');
    }
    if (isProviderError(error, 'NOT_FOUND')) {
      // Locally this is the in-memory mock after a restart. Nothing is released; an operator verifies the funding.
      await openCase(tx, orderId, String(row.id), 'PROVIDER_OBJECT_MISSING', 'HIGH', 'Provider has no record of the funding for this release; verify manually before releasing');
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export type WebhookReceipt = { eventId: string; type: string; duplicate: boolean; outcome: string };

export async function deliverPendingMockWebhooks(): Promise<WebhookReceipt[]> {
  if (!mockPaymentsEnabled()) return [];
  const receipts: WebhookReceipt[] = [];
  for (const delivery of getMockPaymentProvider().takeWebhookDeliveries()) {
    receipts.push(await receivePaymentWebhook(delivery.rawBody, delivery.headers));
  }
  return receipts;
}

/** Verify → persist inbox → process. Throws ProviderError (reject, 4xx) or other errors (retryable, 5xx). */
export async function receivePaymentWebhook(rawBody: Uint8Array, headers: Headers): Promise<WebhookReceipt> {
  const event = await getMockPaymentProvider().verifyWebhook(rawBody, headers);
  const payload = {
    objectType: event.objectType,
    reference: event.reference,
    fundingReference: event.fundingReference,
    operationId: event.operationId,
    orderId: event.orderId,
    status: event.status,
    amount: event.amount.toString(),
    currency: event.currency,
    providerFee: event.providerFee?.toString() ?? null,
    createdAt: event.createdAt,
  };
  await sql`insert into app.webhook_inbox (provider,mode,event_id,event_type,payload,signature_verified)
    values (${MOCK_PROVIDER},${event.mode},${event.eventId},${event.type},${JSON.stringify(payload)}::jsonb,true)
    on conflict (provider,mode,event_id) do nothing`;
  return processVerifiedEvent(event);
}

/**
 * Applies an already-verified fact exactly once, keyed by its inbox row. Used by the webhook route,
 * the inbox reprocessing job, and provider API fetches during reconciliation.
 */
export async function processVerifiedEvent(event: VerifiedEvent): Promise<WebhookReceipt> {
  try {
    return await sql.begin(async (tx) => {
      const [inbox] = await tx<Row[]>`select id,processed_at from app.webhook_inbox where provider=${MOCK_PROVIDER} and mode=${event.mode} and event_id=${event.eventId} for update`;
      if (!inbox) throw new Error('webhook inbox row missing');
      if (inbox.processed_at) return { eventId: event.eventId, type: event.type, duplicate: true, outcome: 'ALREADY_PROCESSED' };
      const outcome = await applyPaymentEvent(tx, event);
      await tx`update app.webhook_inbox set processed_at=now(),attempts=attempts+1 where id=${String(inbox.id)}`;
      return { eventId: event.eventId, type: event.type, duplicate: false, outcome };
    });
  } catch (error) {
    await sql`update app.webhook_inbox set attempts=attempts+1 where provider=${MOCK_PROVIDER} and mode=${event.mode} and event_id=${event.eventId}`;
    throw error;
  }
}

/** Rebuilds a verified fact from a stored inbox row (signature already checked at receipt, or fetched from the provider API). */
export function eventFromInboxRow(row: Row): VerifiedEvent {
  const payload = row.payload as Row;
  return {
    eventId: String(row.event_id),
    type: String(row.event_type) as VerifiedEvent['type'],
    mode: String(row.mode) as VerifiedEvent['mode'],
    accountId: MOCK_ACCOUNT_ID,
    createdAt: String(payload.createdAt),
    objectType: String(payload.objectType) as VerifiedEvent['objectType'],
    reference: String(payload.reference),
    fundingReference: String(payload.fundingReference),
    operationId: String(payload.operationId),
    orderId: String(payload.orderId),
    status: String(payload.status) as VerifiedEvent['status'],
    amount: BigInt(String(payload.amount)),
    currency: String(payload.currency),
    providerFee: payload.providerFee == null ? null : BigInt(String(payload.providerFee)),
  };
}

/**
 * Records a status fetched from the authenticated provider API (reconciliation when a webhook is late
 * or missing) and processes it through the same idempotent path as webhooks.
 */
export async function applyFetchedProviderFact(fact: Omit<VerifiedEvent, 'eventId' | 'mode' | 'accountId' | 'createdAt'>): Promise<WebhookReceipt> {
  const event: VerifiedEvent = {
    ...fact,
    eventId: `fetch:${fact.reference}:${fact.status}`,
    mode: getMockPaymentProvider().mode,
    accountId: MOCK_ACCOUNT_ID,
    createdAt: new Date().toISOString(),
  };
  const payload = {
    objectType: event.objectType, reference: event.reference, fundingReference: event.fundingReference, operationId: event.operationId,
    orderId: event.orderId, status: event.status, amount: event.amount.toString(), currency: event.currency,
    providerFee: event.providerFee?.toString() ?? null, createdAt: event.createdAt, source: 'provider_api_fetch',
  };
  await sql`insert into app.webhook_inbox (provider,mode,event_id,event_type,payload,signature_verified)
    values (${MOCK_PROVIDER},${event.mode},${event.eventId},${event.type},${JSON.stringify(payload)}::jsonb,false)
    on conflict (provider,mode,event_id) do nothing`;
  return processVerifiedEvent(event);
}

async function applyPaymentEvent(tx: Tx, event: VerifiedEvent): Promise<string> {
  if (event.objectType === 'funding') return applyFundingEvent(tx, event);
  if (event.objectType === 'refund') return applyRefundEvent(tx, event);
  if (event.objectType === 'dispute') return applyDisputeEvent(tx, event);
  if (event.objectType === 'reversal') return applyReversalEvent(tx, event);
  return applyReleaseEvent(tx, event);
}

// ---------------------------------------------------------------------------
// PAY-16: provider costs that change after capture
// ---------------------------------------------------------------------------

async function applyLateProviderCost(tx: Tx, event: VerifiedEvent, operation: Row, order: Row): Promise<string> {
  const orderId = String(order.id);
  // Retried from the inbox until the funding fact itself has been applied.
  if (order.payment_status !== 'SUCCEEDED' && !['REFUND_PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(String(order.payment_status))) {
    throw new Error(`provider cost update for order ${orderId} arrived before its funding was applied`);
  }
  const [seen] = await tx<Row[]>`select id from app.provider_cost_adjustments where provider=${MOCK_PROVIDER} and event_id=${event.eventId}`;
  if (seen) return 'DUPLICATE_FACT';
  const [last] = await tx<Row[]>`select actual_fee_minor from app.provider_cost_adjustments where order_id=${orderId} order by created_at desc, id desc limit 1`;
  const [confirmed] = await tx<Row[]>`select payload->>'provider_fee_minor' as fee from app.order_events where order_id=${orderId} and kind='PAYMENT_CONFIRMED' order by created_at limit 1`;
  const previous = BigInt(String(last?.actual_fee_minor ?? confirmed?.fee ?? '0'));
  const actual = event.providerFee ?? 0n;
  const delta = actual - previous;
  if (delta === 0n) return 'COST_UNCHANGED';

  const amount = BigInt(String(order.amount_minor));
  const refunded = order.cancellation_refund_minor == null ? 0n : BigInt(String(order.cancellation_refund_minor));
  const creatorGross = order.status === 'REFUNDED' ? 0n : amount - refunded;
  const phase: CostPhase = creatorGross <= 0n ? 'NO_CREATOR_SETTLEMENT'
    : ['PENDING', 'RELEASED'].includes(String(order.settlement_status)) ? 'AFTER_RELEASE' : 'BEFORE_RELEASE';
  const feePayer = feePayerPolicy();
  const capBps = lateCostCapBps();
  const capMinor = (amount * BigInt(capBps)) / 10_000n;
  const [soFar] = await tx<Row[]>`select coalesce(sum(creator_share_minor) filter (where creator_share_minor > 0),0)::text as borne from app.provider_cost_adjustments where order_id=${orderId}`;
  const shares = lateCostShares({
    delta, feePayer, phase, creatorGross, capMinor,
    creatorBorne: BigInt(String(order.provider_fee_minor ?? '0')),
    creatorLateIncreasesSoFar: BigInt(String(soFar!.borne)),
  });

  await tx`insert into app.provider_cost_adjustments (order_id,provider,event_id,previous_fee_minor,actual_fee_minor,delta_minor,creator_share_minor,platform_share_minor,creator_credit_minor,phase,fee_payer,cap_bps,cap_minor,policy_version)
    values (${orderId},${MOCK_PROVIDER},${event.eventId},${previous.toString()},${actual.toString()},${delta.toString()},${shares.creatorShare.toString()},${shares.platformShare.toString()},
      ${shares.creatorCredit.toString()},${phase},${feePayer},${capBps},${capMinor.toString()},${COST_POLICY_VERSION})`;
  // The cost deducted from the creator's payout follows their share; it is only ever changed before the payout.
  if (shares.creatorShare !== 0n) {
    await tx`update app.orders set provider_fee_minor=provider_fee_minor + ${shares.creatorShare.toString()}::bigint,updated_at=now() where id=${orderId}`;
  }
  const currency = String(order.currency);
  const magnitude = delta < 0n ? -delta : delta;
  await ledger(tx, orderId, 'PROVIDER_COST_ADJUSTED', `cost:mock:${event.eventId}`, delta > 0n
    ? [['provider_fee_expense:mock', magnitude], ['provider_clearing:mock', -magnitude]]
    : [['provider_clearing:mock', magnitude], ['provider_fee_expense:mock', -(magnitude - shares.creatorCredit)], [`creator_cost_credit:${orderId}`, -shares.creatorCredit]],
    currency);
  await orderEvent(tx, orderId, 'PROVIDER_COST_ADJUSTED', {
    provider: MOCK_PROVIDER, event_id: event.eventId, previous_fee_minor: previous.toString(), actual_fee_minor: actual.toString(), phase,
    creator_share_minor: shares.creatorShare.toString(), platform_share_minor: shares.platformShare.toString(), creator_credit_minor: shares.creatorCredit.toString(), policy_version: COST_POLICY_VERSION,
  });
  if (phase === 'AFTER_RELEASE' && delta > 0n) {
    await openCase(tx, orderId, String(operation.id), 'LATE_PROVIDER_COST_AFTER_RELEASE', 'MEDIUM', 'A higher provider cost arrived after the creator payout; the platform bears it under cost-v1 and nothing is taken from the creator');
  } else if (shares.creatorCredit > 0n) {
    await openCase(tx, orderId, String(operation.id), 'LATE_COST_CREDIT_OWED', 'MEDIUM', 'The final provider cost is lower than what the creator paid; decide how to pay the credit owed to them');
  } else if (delta > 0n && shares.platformShare > 0n && feePayer === 'CREATOR_AT_COST' && phase === 'BEFORE_RELEASE') {
    await openCase(tx, orderId, String(operation.id), 'LATE_PROVIDER_COST_ABOVE_CAP', 'MEDIUM', 'A late provider cost exceeded what the creator can bear under cost-v1; the platform bears the rest');
  }
  return `COST_ADJUSTED_${phase}`;
}

// ---------------------------------------------------------------------------
// PAY-15: refunds after the creator was paid
// ---------------------------------------------------------------------------

const AFTER_RELEASE_REFUND_PREFIX = 'refund:after-release:';

/**
 * Finance starts a refund for an order whose creator transfer already happened. The money first has to come back from
 * that transfer (a reversal) or be covered by the platform; until then the shortfall is a tracked deficit.
 */
export async function startPostReleaseRefund(tx: Tx, requestedBy: string, orderId: string, amount: bigint, reason: string): Promise<{ refundId: string; state: string }> {
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  if (!order) throw new PaymentFlowError('Order not found', 'INVALID_STATE');
  if (order.payment_rail === 'CRYPTO' || order.payment_rail === 'POOL') throw new PaymentFlowError('Refunds after release apply to card payments; escrow payouts are settled on chain', 'INVALID_STATE');
  if (order.settlement_status !== 'RELEASED') throw new PaymentFlowError('The creator has not been paid for this order; use the normal refund or cancellation', 'INVALID_STATE');
  const [release] = await tx<Row[]>`select provider_reference,outcome from app.provider_operations where order_id=${orderId} and kind='release.create'
    and status='SUCCEEDED' and outcome->>'releaseStatus'='SUCCEEDED' order by created_at desc limit 1`;
  if (!release) throw new PaymentFlowError('No provider-confirmed creator transfer exists for this order', 'INVALID_STATE');
  const [active] = await tx<Row[]>`select id from app.post_release_refunds where order_id=${orderId} and status<>'REFUNDED'`;
  if (active) throw new PaymentFlowError('A refund after release is already in progress for this order', 'INVALID_STATE');
  const [dispute] = await tx<Row[]>`select id from app.payment_disputes where order_id=${orderId} and status in ('OPEN','LOST')`;
  if (dispute) throw new PaymentFlowError('A card payment dispute covers this payment; the card network decides that money', 'INVALID_STATE');
  const transferred = BigInt(String((release.outcome as Row).netAmount));
  const [done] = await tx<Row[]>`select coalesce(sum(amount_minor),0)::text as total from app.post_release_refunds where order_id=${orderId}`;
  if (amount > transferred - BigInt(String(done!.total))) throw new PaymentFlowError('The refund cannot exceed what was transferred to the creator', 'INVALID_STATE');

  const [refund] = await tx<Row[]>`insert into app.post_release_refunds (order_id,amount_minor,currency,reason,requested_by)
    values (${orderId},${amount.toString()},${String(order.currency)},${reason},${requestedBy}) returning *`;
  await orderEvent(tx, orderId, 'REFUND_AFTER_RELEASE_REQUESTED', { refund_id: String(refund!.id), amount_minor: amount.toString() });
  return { refundId: String(refund!.id), state: await attemptTransferReversal(tx, refund!, String(release.provider_reference)) };
}

/** Finance retries the same reversal operation, for example after the creator's balance recovered. */
export async function retryPostReleaseRecovery(tx: Tx, refundId: string): Promise<string> {
  const refund = await lockPostReleaseRefund(tx, refundId);
  if (refund.status !== 'DEFICIT') throw new PaymentFlowError(`This refund is ${String(refund.status).toLowerCase()}, not waiting on a deficit`, 'INVALID_STATE');
  const [release] = await tx<Row[]>`select provider_reference from app.provider_operations where order_id=${String(refund.order_id)} and kind='release.create'
    and status='SUCCEEDED' and outcome->>'releaseStatus'='SUCCEEDED' order by created_at desc limit 1`;
  return attemptTransferReversal(tx, refund, String(release!.provider_reference));
}

/** Finance approves paying the buyer from platform funds; the loss is booked, never taken from the creator. */
export async function coverPostReleaseDeficit(tx: Tx, coveredBy: string, refundId: string, reason: string): Promise<string> {
  const refund = await lockPostReleaseRefund(tx, refundId);
  if (refund.status !== 'DEFICIT') throw new PaymentFlowError(`This refund is ${String(refund.status).toLowerCase()}, not waiting on a deficit`, 'INVALID_STATE');
  const [inflight] = await tx<Row[]>`select id from app.provider_operations where kind='reversal.create' and outcome->>'refundId'=${refundId} and status in ('PENDING','UNKNOWN','SUCCEEDED')`;
  if (inflight) throw new PaymentFlowError('A reversal for this refund may still move money; resolve it before covering', 'INVALID_STATE');
  const orderId = String(refund.order_id);
  const remaining = BigInt(String(refund.amount_minor)) - BigInt(String(refund.recovered_minor));
  await tx`update app.post_release_refunds set covered_minor=${remaining.toString()},covered_by=${coveredBy},covered_reason=${reason},status='REFUND_PENDING',updated_at=now() where id=${refundId}`;
  await ledger(tx, orderId, 'PLATFORM_COVERED_REFUND', `cover:${refundId}`, [[`platform_loss:${orderId}`, remaining], [`post_release_refund:${orderId}`, -remaining]], String(refund.currency));
  await orderEvent(tx, orderId, 'REFUND_DEFICIT_COVERED', { refund_id: refundId, covered_minor: remaining.toString() });
  return requestAfterReleaseRefund(tx, { ...refund, covered_minor: remaining.toString() });
}

async function lockPostReleaseRefund(tx: Tx, refundId: string): Promise<Row> {
  // Order before refund row, the lock order every payment fact uses.
  const [ref] = await tx<Row[]>`select order_id from app.post_release_refunds where id=${refundId}`;
  if (!ref) throw new PaymentFlowError('Refund not found', 'INVALID_STATE');
  await tx`select id from app.orders where id=${String(ref.order_id)} for update`;
  const [refund] = await tx<Row[]>`select * from app.post_release_refunds where id=${refundId} for update`;
  return refund!;
}

async function attemptTransferReversal(tx: Tx, refund: Row, releaseReference: string): Promise<string> {
  const refundId = String(refund.id);
  const orderId = String(refund.order_id);
  const operationId = `reversal:${refundId}`;
  const input: ReversalInput = { releaseReference, orderId, amount: BigInt(String(refund.amount_minor)), currency: String(refund.currency) };
  const row = await journal(tx, operationId, orderId, 'reversal.create', computeRequestHash('reversal.create', input));
  await tx`update app.provider_operations set outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('refundId',${refundId}::text) where id=${String(row.id)}`;
  try {
    const reversal = await getMockPaymentProvider().reverseTransfer(input, operationId);
    await tx`update app.provider_operations set status='SUCCEEDED',provider_reference=${reversal.reference},outcome=coalesce(outcome,'{}'::jsonb)-'lastError',updated_at=now() where id=${String(row.id)}`;
    await tx`update app.post_release_refunds set status='RECOVERING',updated_at=now() where id=${refundId} and status='DEFICIT'`;
    // The provider's reversal fact (webhook) records the recovered money and requests the buyer refund.
    return 'RECOVERING';
  } catch (error) {
    const result = await recordCallFailure(tx, operationId, error);
    if (result.state === 'RETRY') return 'RETRY';
    const available = isProviderError(error) ? error.details.available ?? null : null;
    await tx`update app.post_release_refunds set status='DEFICIT',updated_at=now() where id=${refundId} and status in ('RECOVERING','DEFICIT')`;
    await orderEvent(tx, orderId, 'REFUND_DEFICIT_OPENED', { refund_id: refundId, deficit_minor: String(refund.amount_minor), code: 'code' in result ? result.code : null, available_minor: available });
    await openCase(tx, orderId, String(row.id), 'REFUND_DEFICIT', 'HIGH', 'The creator transfer could not be reversed. Nothing was recovered or refunded: retry the reversal later or approve a platform cover.');
    return 'DEFICIT';
  }
}

async function applyReversalEvent(tx: Tx, event: VerifiedEvent): Promise<string> {
  const operation = await matchOperation(tx, 'reversal.create', event);
  if (!operation?.order_id) {
    await openCase(tx, null, operation ? String(operation.id) : null, 'UNMATCHED_REVERSAL', 'HIGH', `Match provider reversal ${event.reference} to a refund`);
    return 'UNMATCHED';
  }
  const orderId = String(operation.order_id);
  const refundId = String((operation.outcome as Row | null)?.refundId ?? '');
  await tx`select id from app.orders where id=${orderId} for update`;
  const [refund] = await tx<Row[]>`select * from app.post_release_refunds where id=${refundId}::uuid for update`;
  if (!refund) {
    await openCase(tx, orderId, String(operation.id), 'UNMATCHED_REVERSAL', 'HIGH', `Provider reversal ${event.reference} has no refund on record`);
    return 'UNMATCHED';
  }
  if (event.type !== 'reversal.succeeded') return 'REVERSAL_PENDING';
  if ((operation.outcome as Row | null)?.reversalStatus === 'SUCCEEDED') return 'DUPLICATE_FACT';
  const currency = String(refund.currency);
  if (event.amount !== BigInt(String(refund.amount_minor)) || event.currency !== currency) {
    await openCase(tx, orderId, String(operation.id), 'UNEXPECTED_REVERSAL', 'HIGH', 'Provider reversal does not match the requested refund');
    return 'UNEXPECTED_REVERSAL';
  }
  await tx`update app.provider_operations set outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('reversalStatus','SUCCEEDED','reversedAmount',${event.amount.toString()}::text,'lastEventId',${event.eventId}::text),updated_at=now()
    where id=${String(operation.id)}`;
  if (BigInt(String(refund.covered_minor)) > 0n) {
    // The platform already paid the buyer; the recovered money reduces the platform's loss instead.
    await ledger(tx, orderId, 'REVERSAL_RECOVERED_AFTER_COVER', `reversal:mock:${event.reference}`, [['provider_clearing:mock', event.amount], [`platform_loss:${orderId}`, -event.amount]], currency);
    await openCase(tx, orderId, String(operation.id), 'REVERSAL_AFTER_COVER', 'MEDIUM', 'A reversal succeeded after the platform covered this refund; confirm the recovered amount');
    return 'RECOVERED_AFTER_COVER';
  }
  await tx`update app.post_release_refunds set recovered_minor=${event.amount.toString()},status='REFUND_PENDING',updated_at=now() where id=${refundId}::uuid`;
  await ledger(tx, orderId, 'REVERSAL_RECOVERED', `reversal:mock:${event.reference}`, [['provider_clearing:mock', event.amount], [`post_release_refund:${orderId}`, -event.amount]], currency);
  await orderEvent(tx, orderId, 'REFUND_AFTER_RELEASE_RECOVERED', { refund_id: refundId, recovered_minor: event.amount.toString(), reference: event.reference, event_id: event.eventId });
  const state = await requestAfterReleaseRefund(tx, { ...refund, recovered_minor: event.amount.toString() });
  return `RECOVERED_${state}`;
}

async function requestAfterReleaseRefund(tx: Tx, refund: Row): Promise<string> {
  const orderId = String(refund.order_id);
  const [funding] = await tx<Row[]>`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create' and outcome->>'fundingStatus'='SUCCEEDED' order by created_at desc limit 1`;
  const operationId = `${AFTER_RELEASE_REFUND_PREFIX}${String(refund.id)}`;
  const input: RefundInput = {
    fundingReference: String(funding!.provider_reference), orderId, amount: BigInt(String(refund.amount_minor)), currency: String(refund.currency), reason: 'OPERATOR_RESOLUTION',
    ...(BigInt(String(refund.covered_minor)) > 0n ? { source: 'PLATFORM_BALANCE' as const } : {}),
  };
  const row = await journal(tx, operationId, orderId, 'refund.create', computeRequestHash('refund.create', input));
  try {
    const result = await getMockPaymentProvider().refund(input, operationId);
    await tx`update app.provider_operations set status='SUCCEEDED',provider_reference=${result.reference},outcome=coalesce(outcome,'{}'::jsonb)-'lastError',updated_at=now() where id=${String(row.id)}`;
    return 'REFUND_REQUESTED';
  } catch (error) {
    const result = await recordCallFailure(tx, operationId, error);
    if (result.state === 'REJECTED') await openCase(tx, orderId, String(row.id), 'REFUND_FAILED', 'HIGH', `Provider rejected the refund after release (${result.code ?? 'unknown'}); the recovered or covered money is still held`);
    return result.state === 'RETRY' ? 'REFUND_RETRY' : 'REFUND_REJECTED';
  }
}

async function applyPostReleaseRefundEvent(tx: Tx, event: VerifiedEvent, operation: Row): Promise<string> {
  const orderId = String(operation.order_id);
  const refundId = String(operation.operation_id).slice(AFTER_RELEASE_REFUND_PREFIX.length);
  await tx`select id from app.orders where id=${orderId} for update`;
  const [refund] = await tx<Row[]>`select * from app.post_release_refunds where id=${refundId}::uuid for update`;
  if (!refund) return 'UNMATCHED';
  if (event.type === 'refund.succeeded') {
    if (refund.status === 'REFUNDED') return 'DUPLICATE_FACT';
    if (event.amount !== BigInt(String(refund.amount_minor)) || event.currency !== String(refund.currency) || refund.status !== 'REFUND_PENDING') {
      await openCase(tx, orderId, String(operation.id), 'UNEXPECTED_REFUND', 'HIGH', 'Provider refund does not match the refund after release');
      return 'UNEXPECTED_REFUND';
    }
    await tx`update app.post_release_refunds set status='REFUNDED',updated_at=now() where id=${refundId}::uuid`;
    await ledger(tx, orderId, 'REFUND_SETTLED', `refund:mock:${event.reference}`, [[`post_release_refund:${orderId}`, event.amount], ['provider_clearing:mock', -event.amount]], String(refund.currency));
    await orderEvent(tx, orderId, 'REFUND_AFTER_RELEASE_CONFIRMED', { refund_id: refundId, amount_minor: event.amount.toString(), reference: event.reference, event_id: event.eventId });
    const [order] = await tx<Row[]>`select buyer_id from app.orders where id=${orderId}`;
    await outbox(tx, orderId, `notify:refund.updated:SUCCEEDED:after-release:${refundId}`, {
      templateId: 'refund.updated', recipientId: String(order!.buyer_id), params: { orderRef: orderId, amount: event.amount.toString(), currency: String(refund.currency), refundStatus: 'SUCCEEDED' },
    });
    return 'REFUNDED_AFTER_RELEASE';
  }
  if (event.type === 'refund.failed') {
    await openCase(tx, orderId, String(operation.id), 'REFUND_FAILED', 'HIGH', 'Provider refund after release failed; the recovered or covered money is still held');
    await orderEvent(tx, orderId, 'REFUND_FAILED', { refund_id: refundId, reference: event.reference, event_id: event.eventId });
    return 'REFUND_FAILED';
  }
  return 'REFUND_PENDING';
}

/**
 * ORD-14: a card payment dispute is a payment fact about the funding, not an order transition. The order keeps its
 * status, deliveries, approval and reviews. Opening records an evidence snapshot and alerts operators; a creator release
 * still pending is frozen while the dispute is open or lost (see `releaseReadySettlements`); a lost dispute books the
 * returned payment as a loss and never debits the creator automatically.
 */
async function applyDisputeEvent(tx: Tx, event: VerifiedEvent): Promise<string> {
  const [funding] = await tx<Row[]>`select id,order_id from app.provider_operations where provider=${MOCK_PROVIDER} and kind='funding.create' and provider_reference=${event.fundingReference} limit 1`;
  if (!funding?.order_id) {
    await openCase(tx, null, funding ? String(funding.id) : null, 'UNMATCHED_PAYMENT_DISPUTE', 'HIGH', `Match provider dispute ${event.reference} to an order`);
    return 'UNMATCHED';
  }
  const orderId = String(funding.order_id);
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  if (!order) return 'UNMATCHED';
  const currency = String(order.currency);
  const fact = { provider: MOCK_PROVIDER, reference: event.reference, event_id: event.eventId, amount_minor: event.amount.toString() };

  if (event.type === 'dispute.opened') {
    if (event.currency !== currency || event.amount > BigInt(String(order.amount_minor))) {
      await openCase(tx, orderId, String(funding.id), 'UNEXPECTED_PAYMENT_DISPUTE', 'HIGH', 'Provider dispute does not match the captured payment');
      return 'UNEXPECTED_DISPUTE';
    }
    const evidence = await disputeEvidence(tx, order);
    const [inserted] = await tx<Row[]>`insert into app.payment_disputes (order_id,provider,provider_reference,funding_reference,amount_minor,currency,order_status_at_open,settlement_status_at_open,evidence,opened_event_id)
      values (${orderId},${MOCK_PROVIDER},${event.reference},${event.fundingReference},${event.amount.toString()},${currency},${String(order.status)},${String(order.settlement_status)},${JSON.stringify(evidence)}::jsonb,${event.eventId})
      on conflict (provider,provider_reference) do nothing returning id`;
    if (!inserted) return 'DUPLICATE_FACT';
    await orderEvent(tx, orderId, 'PAYMENT_DISPUTE_OPENED', { ...fact, order_status: String(order.status), settlement_status: String(order.settlement_status) });
    await openCase(tx, orderId, String(funding.id), 'PAYMENT_DISPUTE', 'HIGH', 'Card payment disputed: answer the provider with the evidence snapshot before its deadline. The order and its work stay as recorded.');
    await outbox(tx, orderId, `notify:payment.disputed:OPENED:${event.reference}`, { templateId: 'payment.disputed', recipientId: String(order.creator_id), params: { orderRef: orderId, stage: 'OPENED' } });
    return 'PAYMENT_DISPUTE_OPENED';
  }

  const outcome = event.type === 'dispute.won' ? 'WON' : 'LOST';
  const [dispute] = await tx<Row[]>`select * from app.payment_disputes where provider=${MOCK_PROVIDER} and provider_reference=${event.reference} for update`;
  if (!dispute) {
    await openCase(tx, orderId, String(funding.id), 'UNMATCHED_PAYMENT_DISPUTE', 'HIGH', `A decision arrived for provider dispute ${event.reference}, which was never recorded as opened`);
    return 'UNMATCHED';
  }
  if (dispute.status !== 'OPEN') {
    if (dispute.status === outcome) return 'DUPLICATE_FACT';
    await openCase(tx, orderId, String(funding.id), 'CONFLICTING_PAYMENT_DISPUTE', 'HIGH', `Provider sent ${outcome} for a dispute already recorded as ${String(dispute.status)}`);
    return 'CONFLICTING_FACT';
  }
  await tx`update app.payment_disputes set status=${outcome},closed_event_id=${event.eventId},closed_at=now() where id=${String(dispute.id)}`;
  await orderEvent(tx, orderId, `PAYMENT_DISPUTE_${outcome}`, fact);
  if (outcome === 'LOST') {
    const disputed = BigInt(String(dispute.amount_minor));
    await ledger(tx, orderId, 'CHARGEBACK_LOST', `chargeback:mock:${event.reference}`, [[`chargeback_loss:${orderId}`, disputed], ['provider_clearing:mock', -disputed]], currency);
    await openCase(tx, orderId, String(funding.id), 'CHARGEBACK_LOST', 'HIGH', 'The card network returned the payment to the buyer. Decide any recovery separately; nothing is taken from the creator automatically.');
  }
  await outbox(tx, orderId, `notify:payment.disputed:${outcome}:${event.reference}`, { templateId: 'payment.disputed', recipientId: String(order.creator_id), params: { orderRef: orderId, stage: outcome } });
  return `PAYMENT_DISPUTE_${outcome}`;
}

/** What the order record shows about the work, as timestamps and counts only: no brief, delivery or message text. */
async function disputeEvidence(tx: Tx, order: Row): Promise<Row> {
  const orderId = String(order.id);
  const [facts] = await tx<Row[]>`select
      coalesce((select json_agg(json_build_object('version',d.version,'validation_status',d.validation_status,'created_at',d.created_at,'buyer_viewed_at',d.buyer_viewed_at) order by d.version)
        from app.deliveries d where d.order_id=${orderId}),'[]') as deliveries,
      (select count(*)::int from app.messages m where m.order_id=${orderId}) as message_count,
      (select count(*)::int from app.reviews r where r.order_id=${orderId} and r.reviewer_id=${String(order.buyer_id)}) as buyer_reviews,
      (select count(*)::int from app.disputes x where x.order_id=${orderId}) as order_disputes`;
  const terms = (order.terms ?? {}) as Row;
  return {
    order_status: order.status, source: order.source, amount_minor: String(order.amount_minor), currency: order.currency,
    brief_ready_at: order.brief_ready_at, funded_at: order.funded_at, work_start_at: order.work_start_at, delivery_due_at: order.delivery_due_at,
    approved_at: order.approved_at, completed_at: order.completed_at, auto_accept_consent: terms.auto_accept_consent === true,
    policy_version: terms.policy_version ?? null, ...facts,
  };
}

/** Refund reason is part of the refund request hash, so every caller must derive it the same way. */
export function refundReasonFor(orderStatus: unknown): RefundReason {
  return orderStatus === 'DISPUTED' ? 'OPERATOR_RESOLUTION' : 'BUYER_CANCELED_BEFORE_WORK';
}

/** Opens a reconciliation case unless the same open case already exists. */
export async function openCase(tx: Tx, orderId: string | null, operationRowId: string | null, kind: string, severity: string, nextAction: string) {
  const [open] = await tx<Row[]>`select id from app.reconciliation_cases where kind=${kind} and status in ('OPEN','ASSIGNED')
    and order_id is not distinct from ${orderId}::uuid and provider_operation_id is not distinct from ${operationRowId}::uuid limit 1`;
  if (open) return;
  await tx`insert into app.reconciliation_cases (order_id,provider_operation_id,kind,severity,next_action)
    values (${orderId},${operationRowId},${kind},${severity},${nextAction})`;
}

async function orderEvent(tx: Tx, orderId: string, kind: string, payload: Row) {
  await tx`insert into app.order_events (order_id,actor_id,kind,payload) values (${orderId},${null},${kind},${JSON.stringify(payload)}::jsonb)`;
}

async function ledger(tx: Tx, orderId: string, kind: string, idempotencyKey: string, entries: [account: string, amount: bigint][], currency: string) {
  const total = entries.reduce((sum, [, amount]) => sum + amount, 0n);
  if (total !== 0n) throw new Error(`unbalanced ledger transaction ${kind}`);
  const [transaction] = await tx<Row[]>`insert into app.ledger_transactions (order_id,kind,idempotency_key) values (${orderId},${kind},${idempotencyKey})
    on conflict (idempotency_key) do nothing returning id`;
  if (!transaction) return false;
  for (const [account, amount] of entries) {
    if (amount === 0n) continue;
    await tx`insert into app.ledger_entries (transaction_id,account,amount_minor,currency) values (${String(transaction.id)},${account},${amount.toString()},${currency})`;
  }
  return true;
}

async function outbox(tx: Tx, orderId: string, semanticKey: string, payload: Row) {
  await tx`insert into app.outbox (topic,aggregate_id,semantic_key,payload) values ('notification',${orderId},${semanticKey},${JSON.stringify(payload)}::jsonb)
    on conflict (semantic_key) do nothing`;
}

/**
 * Matches a verified fact to its journal row by provider reference, or by the operation id carried in the
 * signed event when an UNKNOWN outcome left the reference unrecorded (the reference is then filled in).
 */
async function matchOperation(tx: Tx, kind: string, event: VerifiedEvent): Promise<Row | undefined> {
  const [operation] = await tx<Row[]>`select id,operation_id,order_id,outcome,provider_reference from app.provider_operations
    where provider=${MOCK_PROVIDER} and kind=${kind}
      and (provider_reference=${event.reference} or (provider_reference is null and operation_id=${event.operationId}))
    order by (provider_reference is not null) desc limit 1 for update`;
  if (operation && operation.provider_reference == null) {
    await tx`update app.provider_operations set provider_reference=${event.reference},updated_at=now() where id=${String(operation.id)}`;
  }
  return operation;
}

async function applyFundingEvent(tx: Tx, event: VerifiedEvent): Promise<string> {
  const operation = await matchOperation(tx, 'funding.create', event);
  if (!operation?.order_id) {
    await openCase(tx, null, operation ? String(operation.id) : null, 'UNMATCHED_FUNDING', 'HIGH', `Match provider funding ${event.reference} to an order`);
    return 'UNMATCHED';
  }
  const orderId = String(operation.order_id);
  // A later non-success fact never regresses a recorded success.
  await tx`update app.provider_operations set outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('fundingStatus',${event.status}::text,'lastEventId',${event.eventId}::text),updated_at=now()
    where id=${String(operation.id)} and coalesce(outcome->>'fundingStatus','')<>'SUCCEEDED'`;
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  if (!order) return 'UNMATCHED';
  if (event.type === 'funding.fee_updated') return applyLateProviderCost(tx, event, operation, order);

  if (event.type === 'funding.succeeded') {
    const amount = BigInt(String(order.amount_minor));
    if (event.amount !== amount || event.currency !== String(order.currency)) {
      await openCase(tx, orderId, String(operation.id), 'AMOUNT_MISMATCH', 'HIGH', 'Provider funding amount/currency differs from the order snapshot');
      return 'AMOUNT_MISMATCH';
    }
    const [existing] = await tx<Row[]>`select id from app.ledger_transactions where idempotency_key=${`funding:mock:${event.reference}`}`;
    if (existing) return 'DUPLICATE_FACT';
    const claim = await lockCheckoutHold(tx, orderId);
    // EXPIRY_RECONCILING = hold expired while this payment was still unresolved; the verified success wins.
    if (order.payment_status === 'SUCCEEDED' || order.status !== 'AWAITING_PAYMENT' || !['HELD', 'EXPIRY_RECONCILING'].includes(String(claim?.state))) {
      const kind = order.payment_status === 'SUCCEEDED' ? 'DUPLICATE_FUNDING' : 'LATE_FUNDING';
      await openCase(tx, orderId, String(operation.id), kind, 'HIGH', 'Provider captured funds the order cannot accept; refund or reinstate with operator approval');
      await orderEvent(tx, orderId, kind, { provider: MOCK_PROVIDER, reference: event.reference, event_id: event.eventId });
      return kind;
    }
    const providerFee = event.providerFee ?? 0n;
    await tx`update app.orders set status='FUNDED',payment_status='SUCCEEDED',provider_fee_minor=${providerFee.toString()},funded_at=now(),
      version=version+1,updated_at=now() where id=${orderId}`;
    // Work clock = max(funded_at, brief_ready_at) + sold turnaround, fixed once set (ORD-03/04).
    await recomputeWorkClock(tx, orderId);
    // Workload counters follow claim state via DB trigger (drizzle/0012).
    await activateOrderClaim(tx, orderId);
    await orderEvent(tx, orderId, 'PAYMENT_CONFIRMED', {
      provider: MOCK_PROVIDER,
      reference: event.reference,
      event_id: event.eventId,
      platform_fee_minor: '0',
      provider_fee_minor: providerFee.toString(),
    });
    const currency = String(order.currency);
    await ledger(tx, orderId, 'FUNDING_CAPTURED', `funding:mock:${event.reference}`, [
      ['provider_clearing:mock', amount - providerFee],
      ['provider_fee_expense:mock', providerFee],
      [`order_principal:${orderId}`, -amount],
    ], currency);
    await outbox(tx, orderId, `notify:payment.confirmed:${orderId}`, {
      templateId: 'payment.confirmed',
      recipientId: String(order.buyer_id),
      params: { orderRef: orderId, amount: amount.toString(), currency },
    });
    await outbox(tx, orderId, `notify:order.new:${orderId}`, {
      templateId: 'order.new',
      recipientId: String(order.creator_id),
      params: { orderRef: orderId, serviceTitle: String(order.title).slice(0, 120) },
    });
    // A DIGITAL order is delivered as soon as it is funded (XPL-04).
    await fulfillDigitalOrder(tx, orderId);
    return 'FUNDED';
  }

  const [latest] = await tx<Row[]>`select operation_id from app.provider_operations where order_id=${orderId} and kind='funding.create' order by created_at desc limit 1`;
  const isLatestAttempt = latest?.operation_id === operation.operation_id;
  if (event.type === 'funding.processing') {
    const updated = await tx`update app.orders set payment_status='PROCESSING',version=version+1,updated_at=now()
      where id=${orderId} and status='AWAITING_PAYMENT' and payment_status='PENDING' and ${isLatestAttempt} returning id`;
    return updated.length ? 'PROCESSING' : 'NO_REGRESSION';
  }
  if (event.type === 'funding.failed' || event.type === 'funding.canceled') {
    const updated = await tx`update app.orders set payment_status='FAILED',version=version+1,updated_at=now()
      where id=${orderId} and status='AWAITING_PAYMENT' and payment_status in ('PENDING','PROCESSING') and ${isLatestAttempt} returning id`;
    if (updated.length) await orderEvent(tx, orderId, 'PAYMENT_FAILED', { provider: MOCK_PROVIDER, reference: event.reference, event_id: event.eventId });
    return updated.length ? 'PAYMENT_FAILED' : 'NO_REGRESSION';
  }
  return 'IGNORED';
}

/**
 * Pool rail (W5-C2): the order is funded from campaign pool allocations made in the same transaction; no charge,
 * checkout or provider call happens. Ledger principal moves from the pool clearing account for the CASH value.
 */
export async function applyPoolFunding(tx: Tx, input: { orderId: string; poolId: string; cashMinor: bigint; templateVersion: number }): Promise<'FUNDED'> {
  const { orderId } = input;
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  const [claim] = await tx<Row[]>`select state from app.workload_claims where order_id=${orderId} for update`;
  if (!order || order.status !== 'AWAITING_PAYMENT' || claim?.state !== 'HELD') throw new PaymentFlowError('Pool funding needs a new order with a held slot', 'INVALID_STATE');
  if (input.cashMinor !== BigInt(String(order.amount_minor))) throw new PaymentFlowError('Pool CASH reward differs from the order price', 'INVALID_STATE');
  await tx`update app.orders set status='FUNDED',payment_status='SUCCEEDED',payment_rail='POOL',provider_fee_minor=0,funded_at=now(),version=version+1,updated_at=now() where id=${orderId}`;
  await recomputeWorkClock(tx, orderId);
  await activateOrderClaim(tx, orderId);
  await orderEvent(tx, orderId, 'PAYMENT_CONFIRMED', { rail: 'POOL', pool_id: input.poolId, template_version: input.templateVersion, platform_fee_minor: '0', provider_fee_minor: '0' });
  await ledger(tx, orderId, 'FUNDING_CAPTURED', `funding:pool:${orderId}`, [[`pool_clearing:${input.poolId}`, input.cashMinor], [`order_principal:${orderId}`, -input.cashMinor]], 'USD');
  await outbox(tx, orderId, `notify:order.new:${orderId}`, {
    templateId: 'order.new', recipientId: String(order.creator_id), params: { orderRef: orderId, serviceTitle: String(order.title).slice(0, 120) },
  });
  return 'FUNDED';
}

async function returnPoolFunding(tx: Tx, order: Row): Promise<ProviderCallResult> {
  const orderId = String(order.id);
  if (order.cancellation_refund_minor !== null && order.cancellation_refund_minor !== undefined && BigInt(String(order.cancellation_refund_minor)) < BigInt(String(order.amount_minor))) {
    throw new PaymentFlowError('Partial refunds of pool-funded hires are not supported; an operator must split the rewards', 'UNAVAILABLE');
  }
  const { returnPoolAllocations } = await import('@/modules/pools/service');
  await returnPoolAllocations(tx, orderId);
  const [poolRow] = await tx<Row[]>`select pool_id from app.pool_allocations where order_id=${orderId} limit 1`;
  const amount = BigInt(String(order.amount_minor));
  const [current] = await tx<Row[]>`select status from app.orders where id=${orderId} for update`;
  if (current?.status === 'CANCELLED') {
    await tx`update app.orders set status='REFUNDED',payment_status='REFUNDED',version=version+1,updated_at=now() where id=${orderId}`;
  }
  await orderEvent(tx, orderId, 'REFUND_SUCCEEDED', { rail: 'POOL', pool_id: poolRow?.pool_id ?? null, amount_minor: amount.toString() });
  if (poolRow) await ledger(tx, orderId, 'REFUND_SUCCEEDED', `refund:pool:${orderId}`, [[`order_principal:${orderId}`, amount], [`pool_clearing:${poolRow.pool_id}`, -amount]], 'USD');
  return { state: 'READY', operationId: `pool-return:${orderId}`, reference: 'pool' };
}

/** CRY-08: COMPLETED only when every required allocation is released; failed assets retry alone via the settlement job. */
/**
 * CRY-08: queues each still-active allocation; the order completes when every required allocation is confirmed
 * released (finalizePoolOrder, called from the payout effect). Failed assets retry alone on the next settlement run.
 */
async function settlePoolOrder(tx: Tx, order: Row): Promise<ProviderCallResult> {
  const orderId = String(order.id);
  const { settlePoolAllocations } = await import('@/modules/pools/service');
  const result = await settlePoolAllocations(tx, order);
  if (result.requiredOutstanding > 0) {
    await tx`update app.orders set settlement_status='PENDING',updated_at=now() where id=${orderId} and settlement_status<>'PENDING'`;
    return { state: 'RETRY', operationId: `pool-release:${orderId}`, code: 'PARTIAL_PENDING' };
  }
  await finalizePoolOrder(tx, order);
  return { state: 'READY', operationId: `pool-release:${orderId}`, reference: 'pool' };
}

/** Records completion once every required allocation is released; optional ones may still be pending or failed. */
export async function finalizePoolOrder(tx: Tx, order: Row): Promise<boolean> {
  const orderId = String(order.id);
  const allocations = await tx<Row[]>`select pool_id,item_key,required,state,last_error from app.pool_allocations where order_id=${orderId}`;
  if (!allocations.length || allocations.some((a) => a.required && a.state !== 'RELEASED') || order.settlement_status === 'RELEASED') return false;
  const poolId = String(allocations[0]!.pool_id);
  const amount = BigInt(String(order.amount_minor));
  if (order.status === 'APPROVED') {
    await tx`update app.orders set settlement_status='RELEASED',status='COMPLETED',completed_at=now(),version=version+1,updated_at=now() where id=${orderId}`;
    await outbox(tx, orderId, `notify:order.completed:${orderId}`, { templateId: 'order.completed', recipientId: String(order.buyer_id), params: { orderRef: orderId } });
  } else {
    await tx`update app.orders set settlement_status='RELEASED',updated_at=now() where id=${orderId}`;
  }
  await orderEvent(tx, orderId, 'SETTLEMENT_RELEASED', {
    rail: 'POOL', pool_id: poolId, released: allocations.filter((a) => a.state === 'RELEASED').map((a) => a.item_key),
    optional_not_released: allocations.filter((a) => !a.required && a.state !== 'RELEASED').map((a) => a.item_key), platform_fee_minor: '0',
  });
  await ledger(tx, orderId, 'SETTLEMENT_RELEASED', `release:pool:${orderId}`, [[`order_principal:${orderId}`, amount], [`pool_clearing:${poolId}`, -amount]], 'USD');
  await outbox(tx, orderId, `notify:payout.succeeded:${orderId}`, {
    templateId: 'payout.succeeded', recipientId: String(order.creator_id), params: { orderRef: orderId, amount: amount.toString(), currency: 'USD' },
  });
  return true;
}

// ---------------------------------------------------------------------------
// CRYPTO rail: releases, refunds and dispute freezes through SpacaEscrow (W9-ARC)
// ---------------------------------------------------------------------------

async function creditedDeposit(tx: Tx, orderId: string): Promise<Row> {
  const [deposit] = await tx<Row[]>`select d.chain_id,d.token_address,d.payer,d.amount_atomic,a.decimals
    from app.chain_deposits d join app.crypto_payment_intents i on i.id=d.intent_id join app.chain_assets a on a.id=d.asset_id
    where i.order_id=${orderId} and d.status='CREDITED' limit 1`;
  if (!deposit) throw new PaymentFlowError('No verified on-chain deposit exists for this order', 'INVALID_STATE');
  return deposit;
}

/** Full or agreed partial refund back to the paying wallet; the escrow contract fixes the recipient. */
async function queueCryptoRefund(tx: Tx, order: Row): Promise<ProviderCallResult> {
  const orderId = String(order.id);
  const deposit = await creditedDeposit(tx, orderId);
  const agreed = order.cancellation_refund_minor === null || order.cancellation_refund_minor === undefined ? null : BigInt(String(order.cancellation_refund_minor));
  const amount = agreed ?? BigInt(String(order.amount_minor));
  if (amount <= 0n) throw new PaymentFlowError('There is no amount to refund for this order', 'INVALID_STATE');
  const partial = agreed !== null && agreed < BigInt(String(order.amount_minor));
  const logicalKey = `ORDER_REFUND:${orderId}:${partial ? 'agreed' : 'full'}`;
  const payout = await enqueueChainPayout(tx, {
    kind: 'ORDER_REFUND', subjectId: orderId, orderId, chainId: Number(deposit.chain_id), escrowRef: escrowReference('order', orderId), logicalKey,
    recipient: String(deposit.payer), token: String(deposit.token_address), amountAtomic: usdMinorToAtomic(amount, Number(deposit.decimals)),
  });
  return { state: 'READY', operationId: logicalKey, reference: String(payout.id) };
}

/** Creator entitlement (or the remainder after an agreed refund) to the creator's verified wallet on the deposit chain. */
async function queueCryptoRelease(tx: Tx, order: Row): Promise<ProviderCallResult> {
  const orderId = String(order.id);
  const deposit = await creditedDeposit(tx, orderId);
  const [wallet] = await tx<Row[]>`select address from app.wallets where user_id=${String(order.creator_id)} and chain_id=${String(deposit.chain_id)} and revoked_at is null order by verified_at desc limit 1`;
  if (!wallet) {
    // Committed with the case (not thrown), so the operator sees it; settlement stays READY and the job retries.
    await openCase(tx, orderId, null, 'NO_PAYOUT_WALLET', 'MEDIUM', 'The creator has no verified wallet on the payment network; ask them to link one, then the settlement job retries');
    return { state: 'RETRY', operationId: `ORDER_RELEASE:${orderId}`, code: 'NO_PAYOUT_WALLET' };
  }
  const refunded = order.status === 'CANCELLED' && order.cancellation_refund_minor !== null && order.cancellation_refund_minor !== undefined ? BigInt(String(order.cancellation_refund_minor)) : 0n;
  const amount = BigInt(String(order.amount_minor)) - refunded;
  if (amount <= 0n) throw new PaymentFlowError('Creator entitlement would not be positive', 'INVALID_STATE');
  const logicalKey = `ORDER_RELEASE:${orderId}:${refunded > 0n ? 'remainder' : 'full'}`;
  const payout = await enqueueChainPayout(tx, {
    kind: 'ORDER_RELEASE', subjectId: orderId, orderId, chainId: Number(deposit.chain_id), escrowRef: escrowReference('order', orderId), logicalKey,
    recipient: String(wallet.address), token: String(deposit.token_address), amountAtomic: usdMinorToAtomic(amount, Number(deposit.decimals)),
  });
  await tx`update app.orders set settlement_status='PENDING',version=version+1,updated_at=now() where id=${orderId} and settlement_status='READY'`;
  return { state: 'READY', operationId: logicalKey, reference: String(payout.id) };
}

/**
 * A dispute on a crypto-funded order freezes its escrow bucket so the payer cannot reclaim mid-dispute; resolution
 * unfreezes it before the release or refund payout, which the worker dispatches in queue order.
 */
export async function setCryptoEscrowFrozen(tx: Tx, order: Row, disputeId: string, frozen: boolean): Promise<void> {
  if (order.payment_rail !== 'CRYPTO') return;
  const orderId = String(order.id);
  const deposit = await creditedDeposit(tx, orderId);
  await enqueueChainPayout(tx, {
    kind: frozen ? 'FREEZE' : 'UNFREEZE', subjectId: orderId, orderId, chainId: Number(deposit.chain_id), escrowRef: escrowReference('order', orderId),
    logicalKey: `${frozen ? 'FREEZE' : 'UNFREEZE'}:${orderId}:${disputeId}`, amountAtomic: 0n,
  });
}

async function payoutMinor(tx: Tx, payout: Row): Promise<bigint> {
  const { assetForToken } = await import('@/modules/crypto/registry');
  const asset = await assetForToken(tx, Number(payout.chain_id), String(payout.token));
  const minor = asset ? atomicToUsdMinor(BigInt(String(payout.amount_atomic)), Number(asset.decimals)) : null;
  if (minor === null) throw new Error(`payout ${String(payout.id)} amount is not cent-exact for its asset`);
  return minor;
}

registerPayoutEffects(['ORDER_RELEASE'], {
  async onConfirmed(tx, payout) {
    const orderId = String(payout.order_id);
    const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
    if (!order || order.settlement_status === 'RELEASED') return;
    const amount = await payoutMinor(tx, payout);
    if (order.status === 'APPROVED') {
      await tx`update app.orders set settlement_status='RELEASED',status='COMPLETED',completed_at=now(),version=version+1,updated_at=now() where id=${orderId}`;
      await outbox(tx, orderId, `notify:order.completed:${orderId}`, { templateId: 'order.completed', recipientId: String(order.buyer_id), params: { orderRef: orderId } });
    } else {
      await tx`update app.orders set settlement_status='RELEASED',updated_at=now() where id=${orderId}`;
    }
    await orderEvent(tx, orderId, 'SETTLEMENT_RELEASED', { rail: 'CRYPTO', chain_id: Number(payout.chain_id), tx_hash: payout.tx_hash ?? null, amount_atomic: String(payout.amount_atomic), creator_net_minor: amount.toString(), platform_fee_minor: '0' });
    await ledger(tx, orderId, 'SETTLEMENT_RELEASED', `release:chain:${String(payout.payout_ref)}`, [[`order_principal:${orderId}`, amount], [`chain_clearing:${String(payout.chain_id)}`, -amount]], 'USD');
    await outbox(tx, orderId, `notify:payout.succeeded:${orderId}`, { templateId: 'payout.succeeded', recipientId: String(order.creator_id), params: { orderRef: orderId, amount: amount.toString(), currency: 'USD' } });
  },
  async onFailed(tx, payout, code) {
    const orderId = String(payout.order_id);
    await tx`update app.orders set settlement_status='FAILED',updated_at=now() where id=${orderId} and settlement_status='PENDING'`;
    await orderEvent(tx, orderId, 'SETTLEMENT_FAILED', { rail: 'CRYPTO', code });
  },
});

registerPayoutEffects(['ORDER_REFUND'], {
  async onConfirmed(tx, payout) {
    const orderId = String(payout.order_id);
    const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
    if (!order || ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(String(order.payment_status))) return;
    const refunded = await payoutMinor(tx, payout);
    const full = refunded === BigInt(String(order.amount_minor));
    if (full) await tx`update app.orders set status=case when status='CANCELLED' then 'REFUNDED' else status end,payment_status='REFUNDED',settlement_status='NOT_READY',version=version+1,updated_at=now() where id=${orderId}`;
    else await tx`update app.orders set payment_status='PARTIALLY_REFUNDED',updated_at=now() where id=${orderId}`;
    await orderEvent(tx, orderId, 'REFUND_CONFIRMED', { rail: 'CRYPTO', chain_id: Number(payout.chain_id), tx_hash: payout.tx_hash ?? null, amount_minor: refunded.toString(), full });
    await ledger(tx, orderId, 'REFUND_SETTLED', `refund:chain:${String(payout.payout_ref)}`, [[`order_principal:${orderId}`, refunded], [`chain_clearing:${String(payout.chain_id)}`, -refunded]], 'USD');
    await outbox(tx, orderId, `notify:refund.updated:SUCCEEDED:${orderId}`, { templateId: 'refund.updated', recipientId: String(order.buyer_id), params: { orderRef: orderId, amount: refunded.toString(), currency: 'USD', refundStatus: 'SUCCEEDED' } });
  },
  async onFailed(tx, payout, code) {
    await orderEvent(tx, String(payout.order_id), 'REFUND_FAILED', { rail: 'CRYPTO', code });
  },
});

registerPayoutEffects(['FREEZE', 'UNFREEZE'], {
  async onConfirmed(tx, payout) {
    await orderEvent(tx, String(payout.order_id), payout.kind === 'FREEZE' ? 'ESCROW_FROZEN' : 'ESCROW_UNFROZEN', { chain_id: Number(payout.chain_id), tx_hash: payout.tx_hash ?? null });
  },
  async onFailed() {},
});

export type ChainFundingFact = {
  orderId: string;
  amountMinor: bigint;
  chainId: number;
  networkMode: string;
  txHash: string;
  logIndex: number;
  assetSymbol: string;
  amountAtomic: string;
};

/**
 * Applies a server-verified, final on-chain deposit to its order (master §11.4). Same guards as provider funding:
 * exact amount, AWAITING_PAYMENT with a live or reconciling hold, one credit per chain event; otherwise a case.
 */
export async function applyChainFunding(tx: Tx, fact: ChainFundingFact): Promise<'FUNDED' | 'LATE_FUNDING' | 'DUPLICATE_FUNDING' | 'AMOUNT_MISMATCH' | 'DUPLICATE_FACT'> {
  const { orderId } = fact;
  const ledgerKey = `funding:chain:${fact.chainId}:${fact.txHash.toLowerCase()}:${fact.logIndex}`;
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  if (!order) throw new PaymentFlowError('Order not found for a verified chain deposit', 'INVALID_STATE');
  const [existing] = await tx<Row[]>`select id from app.ledger_transactions where idempotency_key=${ledgerKey}`;
  if (existing) return 'DUPLICATE_FACT';
  const chainRef = { rail: 'CRYPTO', network_mode: fact.networkMode, chain_id: fact.chainId, tx_hash: fact.txHash, log_index: fact.logIndex, asset: fact.assetSymbol, amount_atomic: fact.amountAtomic };
  if (fact.amountMinor !== BigInt(String(order.amount_minor)) || String(order.currency) !== 'USD') {
    await openCase(tx, orderId, null, 'AMOUNT_MISMATCH', 'HIGH', 'On-chain deposit amount differs from the order snapshot; refund or top up with operator approval');
    return 'AMOUNT_MISMATCH';
  }
  const claim = await lockCheckoutHold(tx, orderId);
  if (order.payment_status === 'SUCCEEDED' || order.status !== 'AWAITING_PAYMENT' || !['HELD', 'EXPIRY_RECONCILING'].includes(String(claim?.state))) {
    const kind = order.payment_status === 'SUCCEEDED' ? 'DUPLICATE_FUNDING' : 'LATE_FUNDING';
    await openCase(tx, orderId, null, kind, 'HIGH', 'An on-chain deposit arrived that the order cannot accept; refund it from the settlement address with operator approval');
    await orderEvent(tx, orderId, kind, chainRef);
    return kind;
  }
  const amount = fact.amountMinor;
  await tx`update app.orders set status='FUNDED',payment_status='SUCCEEDED',payment_rail='CRYPTO',provider_fee_minor=0,funded_at=now(),
    version=version+1,updated_at=now() where id=${orderId}`;
  await recomputeWorkClock(tx, orderId);
  await activateOrderClaim(tx, orderId);
  await orderEvent(tx, orderId, 'PAYMENT_CONFIRMED', { ...chainRef, platform_fee_minor: '0', provider_fee_minor: '0' });
  await ledger(tx, orderId, 'FUNDING_CAPTURED', ledgerKey, [
    [`chain_clearing:${fact.chainId}`, amount],
    [`order_principal:${orderId}`, -amount],
  ], 'USD');
  await outbox(tx, orderId, `notify:payment.confirmed:${orderId}`, {
    templateId: 'payment.confirmed', recipientId: String(order.buyer_id), params: { orderRef: orderId, amount: amount.toString(), currency: 'USD' },
  });
  await outbox(tx, orderId, `notify:order.new:${orderId}`, {
    templateId: 'order.new', recipientId: String(order.creator_id), params: { orderRef: orderId, serviceTitle: String(order.title).slice(0, 120) },
  });
  // A DIGITAL order is delivered as soon as it is funded (XPL-04).
  await fulfillDigitalOrder(tx, orderId);
  return 'FUNDED';
}

async function applyRefundEvent(tx: Tx, event: VerifiedEvent): Promise<string> {
  const operation = await matchOperation(tx, 'refund.create', event);
  if (!operation?.order_id) {
    await openCase(tx, null, operation ? String(operation.id) : null, 'UNMATCHED_REFUND', 'HIGH', `Match provider refund ${event.reference} to an order`);
    return 'UNMATCHED';
  }
  const orderId = String(operation.order_id);
  await tx`update app.provider_operations set outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('refundStatus',${event.status}::text,'lastEventId',${event.eventId}::text),updated_at=now()
    where id=${String(operation.id)} and coalesce(outcome->>'refundStatus','')<>'SUCCEEDED'`;
  if (String(operation.operation_id).startsWith(AFTER_RELEASE_REFUND_PREFIX)) return applyPostReleaseRefundEvent(tx, event, operation);
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  if (!order) return 'UNMATCHED';
  const amount = BigInt(String(order.amount_minor));

  if (event.type === 'refund.succeeded') {
    if (order.payment_status === 'REFUNDED' || order.payment_status === 'PARTIALLY_REFUNDED') return 'DUPLICATE_FACT';
    const agreed = order.cancellation_refund_minor === null ? null : BigInt(String(order.cancellation_refund_minor));
    const expected = agreed ?? amount;
    if (event.amount !== expected || event.currency !== String(order.currency) || order.payment_status !== 'REFUND_PENDING') {
      await openCase(tx, orderId, String(operation.id), 'UNEXPECTED_REFUND', 'HIGH', 'Provider refund does not match the pending refund');
      return 'UNEXPECTED_REFUND';
    }
    if (expected === amount) {
      await tx`update app.orders set status='REFUNDED',payment_status='REFUNDED',settlement_status='NOT_READY',version=version+1,updated_at=now() where id=${orderId}`;
    } else {
      // Partial refunds keep the order CANCELLED; the remainder settles to the creator separately (§7.2).
      await tx`update app.orders set payment_status='PARTIALLY_REFUNDED',updated_at=now() where id=${orderId}`;
    }
    await orderEvent(tx, orderId, 'REFUND_CONFIRMED', { provider: MOCK_PROVIDER, reference: event.reference, event_id: event.eventId, amount_minor: event.amount.toString(), full: expected === amount });
    const currency = String(order.currency);
    await ledger(tx, orderId, 'REFUND_SETTLED', `refund:mock:${event.reference}`, [
      [`order_principal:${orderId}`, expected],
      ['provider_clearing:mock', -expected],
    ], currency);
    await outbox(tx, orderId, `notify:refund.updated:SUCCEEDED:${orderId}`, {
      templateId: 'refund.updated',
      recipientId: String(order.buyer_id),
      params: { orderRef: orderId, amount: expected.toString(), currency, refundStatus: 'SUCCEEDED' },
    });
    return expected === amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }
  if (event.type === 'refund.failed') {
    await openCase(tx, orderId, String(operation.id), 'REFUND_FAILED', 'HIGH', 'Provider refund failed; retry the same refund operation or resolve manually');
    await orderEvent(tx, orderId, 'REFUND_FAILED', { provider: MOCK_PROVIDER, reference: event.reference, event_id: event.eventId });
    return 'REFUND_FAILED';
  }
  return 'REFUND_PENDING';
}

async function applyReleaseEvent(tx: Tx, event: VerifiedEvent): Promise<string> {
  const operation = await matchOperation(tx, 'release.create', event);
  if (!operation?.order_id) {
    await openCase(tx, null, operation ? String(operation.id) : null, 'UNMATCHED_RELEASE', 'HIGH', `Match provider transfer ${event.reference} to an order`);
    return 'UNMATCHED';
  }
  const orderId = String(operation.order_id);
  await tx`update app.provider_operations set outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('releaseStatus',${event.status}::text,'lastEventId',${event.eventId}::text),updated_at=now()
    where id=${String(operation.id)} and coalesce(outcome->>'releaseStatus','')<>'SUCCEEDED'`;
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  if (!order) return 'UNMATCHED';
  const plan = (operation.outcome ?? {}) as Row;
  const net = BigInt(String(plan.netAmount ?? '0'));
  const providerFee = BigInt(String(plan.providerFee ?? '0'));
  const policy = String(plan.feePolicy ?? 'CREATOR_AT_COST');
  const currency = String(order.currency);

  if (event.type === 'release.succeeded') {
    if (order.settlement_status === 'RELEASED') return 'DUPLICATE_FACT';
    if (event.amount !== net || event.currency !== currency || !['READY', 'PENDING'].includes(String(order.settlement_status))) {
      await openCase(tx, orderId, String(operation.id), 'UNEXPECTED_RELEASE', 'HIGH', 'Provider transfer does not match the planned creator release');
      return 'UNEXPECTED_RELEASE';
    }
    const amount = plan.grossAmount === undefined ? BigInt(String(order.amount_minor)) : BigInt(String(plan.grossAmount));
    if (order.status === 'APPROVED') {
      // §7.3: COMPLETED only after the required settlement was released by the provider.
      await tx`update app.orders set settlement_status='RELEASED',status='COMPLETED',completed_at=now(),version=version+1,updated_at=now() where id=${orderId}`;
      await outbox(tx, orderId, `notify:order.completed:${orderId}`, { templateId: 'order.completed', recipientId: String(order.buyer_id), params: { orderRef: orderId } });
    } else {
      await tx`update app.orders set settlement_status='RELEASED',updated_at=now() where id=${orderId}`;
    }
    await orderEvent(tx, orderId, 'SETTLEMENT_RELEASED', {
      provider: MOCK_PROVIDER, reference: event.reference, event_id: event.eventId,
      creator_net_minor: net.toString(), provider_fee_minor: providerFee.toString(), fee_policy: policy, platform_fee_minor: '0',
    });
    // CREATOR_AT_COST: the provider cost is recovered from the creator entitlement, so the expense nets to zero.
    // PLATFORM_SUBSIDIZED: the creator receives the full amount and the provider cost stays a platform expense.
    await ledger(tx, orderId, 'SETTLEMENT_RELEASED', `release:mock:${event.reference}`,
      policy === 'CREATOR_AT_COST'
        ? [[`order_principal:${orderId}`, amount], ['provider_clearing:mock', -net], ['provider_fee_expense:mock', -providerFee]]
        : [[`order_principal:${orderId}`, amount], ['provider_clearing:mock', -amount]],
      currency);
    await outbox(tx, orderId, `notify:payout.succeeded:${orderId}`, {
      templateId: 'payout.succeeded',
      recipientId: String(order.creator_id),
      params: { orderRef: orderId, amount: net.toString(), currency },
    });
    return 'RELEASED';
  }
  if (event.type === 'release.failed') {
    await tx`update app.orders set settlement_status='FAILED',version=version+1,updated_at=now() where id=${orderId} and settlement_status in ('READY','PENDING')`;
    await openCase(tx, orderId, String(operation.id), 'PAYOUT_FAILED', 'HIGH', 'Provider transfer failed; investigate before retrying the same release operation');
    await orderEvent(tx, orderId, 'SETTLEMENT_FAILED', { provider: MOCK_PROVIDER, reference: event.reference, event_id: event.eventId });
    await outbox(tx, orderId, `notify:payout.failed:${orderId}:${event.reference}`, {
      templateId: 'payout.failed',
      recipientId: String(order.creator_id),
      params: { orderRef: orderId },
    });
    return 'RELEASE_FAILED';
  }
  await tx`update app.orders set settlement_status='PENDING',version=version+1,updated_at=now() where id=${orderId} and settlement_status='READY'`;
  return 'RELEASE_PENDING';
}
