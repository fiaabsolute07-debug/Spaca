import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider, signMockWebhook, type MockPaymentProviderOptions } from '@/modules/payments/providers';
import { RUN_DB, ORIGIN, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const webhook = await import('@/app/api/webhooks/mock-payment/route');
const funding = await import('@/modules/payments/funding');
const { sql } = await import('@/lib/db');

const SECRET = 'whsec_integration_test_secret';
let provider: MockPaymentProvider;

function useProvider(options: Partial<MockPaymentProviderOptions> = {}) {
  provider = new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: [SECRET], ...options });
  funding.setMockPaymentProviderForTests(provider);
}

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });

async function postWebhook(rawBody: Uint8Array, headers: Headers) {
  const response = await webhook.POST(new Request(`${ORIGIN}/api/webhooks/mock-payment`, { method: 'POST', headers, body: new Uint8Array(rawBody) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function bookedOrder(label: string, options: { capacity?: number } = {}) {
  const creator = await createUser(`${label}-creator`);
  const buyer = await createUser(`${label}-buyer`);
  const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: options.capacity ?? 1 });
  const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief: 'Payment integration brief with enough detail to start.' });
  if (booked.status !== 200) throw new Error(JSON.stringify(booked.body));
  return { creator, buyer, serviceId, poolId, orderId: String(booked.body.id) };
}

const orderRow = async (orderId: string) => (await sql`select * from app.orders where id=${orderId}`)[0]!;
const count = async (query: Promise<{ count: number }[]>) => (await query)[0]!.count;

async function ledgerBalance(orderId: string) {
  return sql`select e.currency,sum(e.amount_minor)::text as total,count(*)::int as entries from app.ledger_entries e
    join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId} group by e.currency`;
}

/** Creates the intent and lets the provider confirm, but holds the webhooks back for the test to deliver. */
async function providerConfirmsWithoutDelivery(buyer: TestUser, orderId: string, statuses: ('PROCESSING' | 'SUCCEEDED' | 'FAILED')[] = ['SUCCEEDED']) {
  const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, buyer.id, orderId));
  if (intent.state !== 'READY') throw new Error(`intent not ready: ${JSON.stringify(intent)}`);
  for (const status of statuses) await provider.simulateFundingOutcome(intent.reference, { status });
  return { reference: intent.reference, deliveries: provider.takeWebhookDeliveries() };
}

function forgeSignedEvent(type: string, data: Record<string, string | null>) {
  const body = new TextEncoder().encode(
    JSON.stringify({ id: `evt_forged_${key('e')}`, type, mode: 'test', account: 'acct_mock_local', created: new Date().toISOString(), data }),
  );
  const headers = new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, SECRET, Math.floor(Date.now() / 1000)) });
  return { body, headers };
}

beforeEach(() => {
  if (RUN_DB) useProvider();
});

afterAll(async () => {
  if (RUN_DB) {
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('PAY-06 — no client-side mark paid', () => {
  it('sandbox_pay is gone and only the buyer can reach checkout', async () => {
    const { creator, buyer, orderId } = await bookedOrder('pay06');
    const direct = await command(buyer, { command: 'sandbox_pay', idempotency_key: key('sp'), order_id: orderId });
    expect(direct.status).toBe(403);
    expect((await pay(creator, orderId)).status).toBe(403);
    expect((await pay(await createUser('pay06-stranger'), orderId)).status).toBe(403);
    const order = await orderRow(orderId);
    expect(order).toMatchObject({ status: 'AWAITING_PAYMENT', payment_status: 'PENDING' });
    expect(await count(sql`select count(*)::int as count from app.order_events where order_id=${orderId} and kind='PAYMENT_CONFIRMED'`)).toBe(0);
  });
});

describe.skipIf(!RUN_DB)('TEST_PLAN 4 + PAY-02 — provider funding then full order lifecycle', () => {
  it('funds through a verified webhook with zero platform fee, then walks the lifecycle', async () => {
    vi.stubEnv('MOCK_PROVIDER_FEE_BPS', '300');
    try {
      const { creator, buyer, poolId, orderId } = await bookedOrder('life');
      expect((await command(creator, { command: 'start', idempotency_key: key('s'), order_id: orderId })).status).toBe(400);
      expect((await command(buyer, { command: 'approve', idempotency_key: key('a'), order_id: orderId })).status).toBe(400);

      const paid = await pay(buyer, orderId);
      expect(paid.status).toBe(200);
      const order = await orderRow(orderId);
      expect(order).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED', amount_minor: '65000', platform_fee_minor: '0', provider_fee_minor: '1950' });
      const [pool] = await sql`select reserved_units,committed_units from app.capacity_pools where id=${poolId}`;
      expect(pool).toMatchObject({ reserved_units: 0, committed_units: 1 });
      const [reservation] = await sql`select state from app.reservations where order_id=${orderId}`;
      expect(reservation!.state).toBe('COMMITTED');

      expect(await ledgerBalance(orderId)).toEqual([{ currency: 'USD', total: '0', entries: 3 }]);
      const accounts = await sql`select e.account,e.amount_minor from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId} order by e.account`;
      expect(accounts.map((a) => [a.account, a.amount_minor])).toEqual([
        [`order_principal:${orderId}`, '-65000'],
        ['provider_clearing:mock', '63050'],
        ['provider_fee_expense:mock', '1950'],
      ]);
      expect(accounts.some((a) => String(a.account).includes('platform'))).toBe(false);
      const [operation] = await sql`select status,outcome->>'fundingStatus' as funding_status,request_hash from app.provider_operations where order_id=${orderId} and kind='funding.create'`;
      expect(operation).toMatchObject({ status: 'SUCCEEDED', funding_status: 'SUCCEEDED' });
      expect(await count(sql`select count(*)::int as count from app.webhook_inbox where payload->>'orderId'=${orderId} and processed_at is not null and signature_verified`)).toBe(1);
      expect((await sql`select semantic_key from app.outbox where aggregate_id=${orderId} order by semantic_key`).map((r) => r.semantic_key)).toEqual([
        `notify:order.new:${orderId}`,
        `notify:payment.confirmed:${orderId}`,
      ]);

      const step = (actor: TestUser, fields: Record<string, string>) => command(actor, { idempotency_key: key('step'), order_id: orderId, ...fields });
      expect((await step(creator, { command: 'start' })).status).toBe(200);
      expect((await step(creator, { command: 'deliver', body: 'Version one is ready.' })).status).toBe(200);
      expect((await step(buyer, { command: 'revision', body: 'Tighten the headline.' })).status).toBe(200);
      expect((await step(creator, { command: 'deliver', body: 'Version two is ready.' })).status).toBe(200);
      expect((await step(buyer, { command: 'revision', body: 'One more round please.' })).status).toBe(400);
      expect((await step(buyer, { command: 'approve' })).status).toBe(200);
      expect((await step(buyer, { command: 'review', rating: '5', body: 'Clear and fast.' })).status).toBe(200);

      const done = await orderRow(orderId);
      expect(done).toMatchObject({ status: 'COMPLETED', settlement_status: 'READY', revision_count: 1, platform_fee_minor: '0' });
      const kinds = (await sql`select kind from app.order_events where order_id=${orderId} order by created_at asc`).map((e) => e.kind);
      expect(kinds).toEqual(['ORDER_CREATED', 'PAYMENT_CONFIRMED', 'WORK_STARTED', 'DELIVERED', 'REVISION_REQUESTED', 'DELIVERED', 'ORDER_APPROVED']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe.skipIf(!RUN_DB)('PAY-07/08/09 — webhook dedupe, ordering and verification', () => {
  it('one signed event delivered 20 times (10 sequential, 10 concurrent) credits once', async () => {
    const { buyer, orderId } = await bookedOrder('pay07');
    const { reference, deliveries } = await providerConfirmsWithoutDelivery(buyer, orderId);
    expect(deliveries).toHaveLength(1);
    const eventId = deliveries[0]!.eventId;

    const sequential = [];
    for (let i = 0; i < 10; i++) {
      const again = provider.redeliverWebhook(eventId);
      sequential.push(await postWebhook(again.rawBody, again.headers));
    }
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => {
        const again = provider.redeliverWebhook(eventId);
        return postWebhook(again.rawBody, again.headers);
      }),
    );
    const all = [...sequential, ...concurrent];
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(all.filter((r) => r.body.duplicate === false)).toHaveLength(1);

    expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED' });
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where idempotency_key=${`funding:mock:${reference}`}`)).toBe(1);
    expect(await count(sql`select count(*)::int as count from app.order_events where order_id=${orderId} and kind='PAYMENT_CONFIRMED'`)).toBe(1);
    expect(await count(sql`select count(*)::int as count from app.outbox where aggregate_id=${orderId}`)).toBe(2);
    expect(await count(sql`select count(*)::int as count from app.webhook_inbox where event_id=${eventId}`)).toBe(1);
  });

  it('a success processed before older PROCESSING/FAILED facts never regresses', async () => {
    const { buyer, orderId } = await bookedOrder('pay08');
    const { reference, deliveries } = await providerConfirmsWithoutDelivery(buyer, orderId, ['PROCESSING', 'SUCCEEDED']);
    expect(deliveries.map((d) => d.type)).toEqual(['funding.processing', 'funding.succeeded']);
    for (const delivery of [...deliveries].reverse()) expect((await postWebhook(delivery.rawBody, delivery.headers)).status).toBe(200);

    const staleFailure = forgeSignedEvent('funding.failed', {
      objectType: 'funding', reference, fundingReference: reference, operationId: `fund:${orderId}:1`, orderId, status: 'FAILED', amount: '65000', currency: 'USD', providerFee: null,
    });
    expect((await postWebhook(staleFailure.body, staleFailure.headers)).status).toBe(200);

    expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED' });
    const [operation] = await sql`select outcome->>'fundingStatus' as funding_status from app.provider_operations where provider_reference=${reference}`;
    expect(operation!.funding_status).toBe('SUCCEEDED');
  });

  it('rejects tampered, forged and wrong-account webhooks before the inbox', async () => {
    const { buyer, orderId } = await bookedOrder('pay09');
    const { deliveries } = await providerConfirmsWithoutDelivery(buyer, orderId);
    const genuine = deliveries[0]!;

    const tampered = new TextEncoder().encode(new TextDecoder().decode(genuine.rawBody).replace('"65000"', '"1"'));
    expect((await postWebhook(tampered, genuine.headers)).status).toBe(400);
    expect((await postWebhook(genuine.rawBody, new Headers())).status).toBe(400);

    const attackerBody = genuine.rawBody;
    const attackerHeaders = new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(attackerBody, 'whsec_attacker_guess_0000', Math.floor(Date.now() / 1000)) });
    expect((await postWebhook(attackerBody, attackerHeaders)).status).toBe(400);

    const otherAccount = new MockPaymentProvider({ accountId: 'acct_mock_other', webhookSecrets: [SECRET] });
    const foreign = await otherAccount.createFundingIntent({ orderId, buyerId: buyer.id, payeeAccountId: 'acct_x_000001', amount: 65000n, currency: 'USD', platformFee: 0n }, 'op_foreign_account_1');
    await otherAccount.simulateFundingOutcome(foreign.reference, { status: 'SUCCEEDED' });
    const [foreignDelivery] = otherAccount.takeWebhookDeliveries();
    expect((await postWebhook(foreignDelivery!.rawBody, foreignDelivery!.headers)).status).toBe(400);

    expect(await count(sql`select count(*)::int as count from app.webhook_inbox where payload->>'orderId'=${orderId}`)).toBe(0);
    expect(await orderRow(orderId)).toMatchObject({ status: 'AWAITING_PAYMENT', payment_status: 'PENDING' });

    expect((await postWebhook(genuine.rawBody, genuine.headers)).status).toBe(200);
    expect((await orderRow(orderId)).status).toBe('FUNDED');
  });

  it('a signed event whose amount differs from the order snapshot opens a case and does not fund', async () => {
    const { buyer, orderId } = await bookedOrder('mismatch');
    const { reference } = await providerConfirmsWithoutDelivery(buyer, orderId);
    const forged = forgeSignedEvent('funding.succeeded', {
      objectType: 'funding', reference, fundingReference: reference, operationId: `fund:${orderId}:1`, orderId, status: 'SUCCEEDED', amount: '100', currency: 'USD', providerFee: '0',
    });
    expect((await postWebhook(forged.body, forged.headers)).status).toBe(200);
    expect((await orderRow(orderId)).status).toBe('AWAITING_PAYMENT');
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='AMOUNT_MISMATCH'`)).toBe(1);
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where order_id=${orderId}`)).toBe(0);
  });
});

describe.skipIf(!RUN_DB)('PAY-10 — provider accepted but timed out', () => {
  it('journals UNKNOWN, retries the same operation, charges once', async () => {
    useProvider({ failureInjection: [{ kind: 'funding.create', effect: 'ACCEPT_THEN_TIMEOUT' }] });
    const { buyer, orderId } = await bookedOrder('pay10');

    const first = await pay(buyer, orderId);
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ state: 'RETRY', code: 'PROVIDER_TIMEOUT' });
    const [journal] = await sql`select operation_id,status from app.provider_operations where order_id=${orderId} and kind='funding.create'`;
    expect(journal).toMatchObject({ status: 'UNKNOWN' });
    expect((await orderRow(orderId)).status).toBe('AWAITING_PAYMENT');
    expect(await provider.lookupOperation(String(journal!.operation_id))).toMatchObject({ state: 'APPLIED' });

    expect((await pay(buyer, orderId)).status).toBe(200);
    const operations = await sql`select operation_id,status from app.provider_operations where order_id=${orderId} and kind='funding.create'`;
    expect(operations).toEqual([{ operation_id: journal!.operation_id, status: 'SUCCEEDED' }]);
    expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED' });
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where order_id=${orderId}`)).toBe(1);
  });
});

describe.skipIf(!RUN_DB)('cancellation, late funding and refunds', () => {
  it('refuses to cancel when the provider already captured funds; the webhook still funds the order', async () => {
    const { buyer, orderId } = await bookedOrder('captured');
    const { deliveries } = await providerConfirmsWithoutDelivery(buyer, orderId);
    const cancel = await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: orderId });
    expect(cancel.status).toBe(400);
    expect(String(cancel.body.error)).toMatch(/already confirmed/);
    expect((await postWebhook(deliveries[0]!.rawBody, deliveries[0]!.headers)).status).toBe(200);
    expect((await orderRow(orderId)).status).toBe('FUNDED');
  });

  it('cancels the open intent before releasing capacity; late funds open a case instead of funding', async () => {
    const { buyer, poolId, orderId } = await bookedOrder('late');
    const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, buyer.id, orderId));
    if (intent.state !== 'READY') throw new Error('intent not ready');
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: orderId })).status).toBe(200);
    expect((await provider.getFundingStatus(intent.reference)).status).toBe('CANCELED');
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED' });
    const [pool] = await sql`select reserved_units from app.capacity_pools where id=${poolId}`;
    expect(pool!.reserved_units).toBe(0);

    const late = forgeSignedEvent('funding.succeeded', {
      objectType: 'funding', reference: intent.reference, fundingReference: intent.reference, operationId: intent.operationId, orderId, status: 'SUCCEEDED', amount: '65000', currency: 'USD', providerFee: '0',
    });
    expect((await postWebhook(late.body, late.headers)).status).toBe(200);
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'PENDING' });
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='LATE_FUNDING'`)).toBe(1);
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where order_id=${orderId}`)).toBe(0);
  });

  it('full refund is REFUNDED only after the provider confirms, and applies once', async () => {
    useProvider({ refundSettlement: 'pending' });
    const { buyer, poolId, orderId } = await bookedOrder('refund');
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: orderId })).status).toBe(200);
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'REFUND_PENDING' });
    const [pool] = await sql`select committed_units from app.capacity_pools where id=${poolId}`;
    expect(pool!.committed_units).toBe(0);

    const requested = await command(buyer, { command: 'refund', idempotency_key: key('r'), order_id: orderId });
    expect(requested.status).toBe(200);
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'REFUND_PENDING' });

    const [refundOp] = await sql`select provider_reference,status from app.provider_operations where order_id=${orderId} and kind='refund.create'`;
    expect(refundOp!.status).toBe('SUCCEEDED');
    expect((await command(buyer, { command: 'refund', idempotency_key: key('r2'), order_id: orderId })).status).toBe(200);
    expect(await count(sql`select count(*)::int as count from app.provider_operations where order_id=${orderId} and kind='refund.create'`)).toBe(1);

    await provider.simulateRefundOutcome(String(refundOp!.provider_reference), 'SUCCEEDED');
    await funding.deliverPendingMockWebhooks();
    expect(await orderRow(orderId)).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED', platform_fee_minor: '0' });
    expect((await provider.getFundingStatus((await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create'`)[0]!.provider_reference as string)).fullyRefunded).toBe(true);

    // Buyers may request refunds only on CANCELLED orders; a REFUNDED order is refused and nothing new reaches the provider.
    expect((await command(buyer, { command: 'refund', idempotency_key: key('r3'), order_id: orderId })).status).toBe(403);
    expect(await count(sql`select count(*)::int as count from app.provider_operations where order_id=${orderId} and kind='refund.create'`)).toBe(1);
    const balance = await sql`select sum(e.amount_minor)::text as total from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId} and e.account=${`order_principal:${orderId}`}`;
    expect(balance[0]!.total).toBe('0');
    // Funding (clearing, principal; zero provider fee is not written) + refund (principal, clearing).
    expect(await ledgerBalance(orderId)).toEqual([{ currency: 'USD', total: '0', entries: 4 }]);
    expect(await count(sql`select count(*)::int as count from app.outbox where semantic_key=${`notify:refund.updated:SUCCEEDED:${orderId}`}`)).toBe(1);
  });
});
