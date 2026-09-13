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
import { commitOrderReservation } from '@/modules/capacity';
import { recomputeWorkClock } from '@/modules/orders/lifecycle';
import { isFlagEnabled } from '@/modules/admin/policy';
import {
  MockPaymentProvider,
  computeRequestHash,
  isProviderError,
  type FundingInput,
  type ReleaseInput,
  type RefundInput,
  type RefundReason,
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
  const [reservation] = await tx<Row[]>`select state from app.reservations where order_id=${orderId}`;
  if (reservation?.state !== 'HELD') throw new PaymentFlowError('The capacity hold for this order is no longer active', 'INVALID_STATE');

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
  return applyReleaseEvent(tx, event);
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

  if (event.type === 'funding.succeeded') {
    const amount = BigInt(String(order.amount_minor));
    if (event.amount !== amount || event.currency !== String(order.currency)) {
      await openCase(tx, orderId, String(operation.id), 'AMOUNT_MISMATCH', 'HIGH', 'Provider funding amount/currency differs from the order snapshot');
      return 'AMOUNT_MISMATCH';
    }
    const [existing] = await tx<Row[]>`select id from app.ledger_transactions where idempotency_key=${`funding:mock:${event.reference}`}`;
    if (existing) return 'DUPLICATE_FACT';
    const [reservation] = await tx<Row[]>`select * from app.reservations where order_id=${orderId} for update`;
    // RECONCILING = hold expired while this payment was still unresolved; the verified success wins.
    if (order.payment_status === 'SUCCEEDED' || order.status !== 'AWAITING_PAYMENT' || !['HELD', 'RECONCILING'].includes(String(reservation?.state))) {
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
    // Counters follow reservation state via DB trigger (drizzle/0003).
    await commitOrderReservation(tx, orderId);
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

async function applyRefundEvent(tx: Tx, event: VerifiedEvent): Promise<string> {
  const operation = await matchOperation(tx, 'refund.create', event);
  if (!operation?.order_id) {
    await openCase(tx, null, operation ? String(operation.id) : null, 'UNMATCHED_REFUND', 'HIGH', `Match provider refund ${event.reference} to an order`);
    return 'UNMATCHED';
  }
  const orderId = String(operation.order_id);
  await tx`update app.provider_operations set outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('refundStatus',${event.status}::text,'lastEventId',${event.eventId}::text),updated_at=now()
    where id=${String(operation.id)} and coalesce(outcome->>'refundStatus','')<>'SUCCEEDED'`;
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
