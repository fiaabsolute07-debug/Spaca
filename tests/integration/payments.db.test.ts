import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider, signMockWebhook, type MockPaymentProviderOptions } from '@/modules/payments/providers';
import { workloadCounters, RUN_DB, ORIGIN, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

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
  const { serviceId, creatorId } = await createPublishedService(command, creator, { capacity: options.capacity ?? 1 });
  const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief: 'Payment integration brief with enough detail to start.' });
  if (booked.status !== 200) throw new Error(JSON.stringify(booked.body));
  return { creator, buyer, serviceId, creatorId, orderId: String(booked.body.id) };
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
      const { creator, buyer, creatorId, orderId } = await bookedOrder('life');
      expect((await command(creator, { command: 'start', idempotency_key: key('s'), order_id: orderId })).status).toBe(409); // ORD-02: payment pending
      expect((await command(buyer, { command: 'approve', idempotency_key: key('a'), order_id: orderId, delivery_version: '1' })).status).toBe(409);

      const paid = await pay(buyer, orderId);
      expect(paid.status).toBe(200);
      const order = await orderRow(orderId);
      expect(order).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED', amount_minor: '65000', platform_fee_minor: '0', provider_fee_minor: '1950' });
      const workload = await workloadCounters(creatorId);
      expect(workload).toMatchObject({ held_units: 0, active_units: 1 });
      const [claim] = await sql`select state from app.workload_claims where order_id=${orderId}`;
      expect(claim!.state).toBe('ACTIVE');

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
      expect((await step(creator, { command: 'deliver', body: 'Version one is ready for your review.' })).status).toBe(200);
      expect((await step(buyer, { command: 'revision', delivery_version: '1', body: 'Tighten the headline.' })).status).toBe(200);
      expect((await step(creator, { command: 'deliver', body: 'Version two is ready for your review.' })).status).toBe(200);
      expect((await step(buyer, { command: 'approve', delivery_version: '1' })).status).toBe(409); // ORD-08 stale version
      expect((await step(buyer, { command: 'revision', delivery_version: '2', body: 'One more round please.' })).status).toBe(422); // ORD-06
      expect((await step(buyer, { command: 'approve', delivery_version: '2' })).status).toBe(200);
      expect((await step(buyer, { command: 'review', rating: '5', body: 'Clear and fast.' })).status).toBe(409); // REV-01: not completed yet
      const approved = await orderRow(orderId);
      expect(approved).toMatchObject({ status: 'APPROVED', settlement_status: 'READY', revision_count: 1, platform_fee_minor: '0' });

      const { releaseReadySettlements } = await import('@/modules/jobs');
      await releaseReadySettlements({ orderId });
      expect((await step(buyer, { command: 'review', rating: '5', body: 'Clear and fast.' })).status).toBe(200);
      const done = await orderRow(orderId);
      expect(done).toMatchObject({ status: 'COMPLETED', settlement_status: 'RELEASED', revision_count: 1, platform_fee_minor: '0' });
      const kinds = (await sql`select kind from app.order_events where order_id=${orderId} order by created_at asc`).map((e) => e.kind);
      expect(kinds).toEqual(['ORDER_CREATED', 'PAYMENT_CONFIRMED', 'WORK_STARTED', 'DELIVERED', 'REVISION_REQUESTED', 'DELIVERED', 'ORDER_APPROVED', 'SETTLEMENT_RELEASED', 'REVIEW_SUBMITTED']);
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
    const { buyer, creatorId, orderId } = await bookedOrder('late');
    const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, buyer.id, orderId));
    if (intent.state !== 'READY') throw new Error('intent not ready');
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: orderId })).status).toBe(200);
    expect((await provider.getFundingStatus(intent.reference)).status).toBe('CANCELED');
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED' });
    const workload = await workloadCounters(creatorId);
    expect(workload.held_units).toBe(0);

    const late = forgeSignedEvent('funding.succeeded', {
      objectType: 'funding', reference: intent.reference, fundingReference: intent.reference, operationId: intent.operationId, orderId, status: 'SUCCEEDED', amount: '65000', currency: 'USD', providerFee: '0',
    });
    expect((await postWebhook(late.body, late.headers)).status).toBe(200);
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'PENDING' });
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='LATE_FUNDING'`)).toBe(1);
    // The captured money is recorded (owed back to the buyer), never used to fund the cancelled order.
    expect((await sql`select kind from app.ledger_transactions where order_id=${orderId}`).map((t) => t.kind)).toEqual(['LATE_FUNDING_CAPTURED']);
    expect((await ledgerBalance(orderId))[0]).toMatchObject({ total: '0' });
  });

  it('full refund is REFUNDED only after the provider confirms, and applies once', async () => {
    useProvider({ refundSettlement: 'pending' });
    const { buyer, creatorId, orderId } = await bookedOrder('refund');
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: orderId })).status).toBe(200);
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'REFUND_PENDING' });
    const workload = await workloadCounters(creatorId);
    expect(workload.active_units).toBe(0);

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

describe.skipIf(!RUN_DB)('ORD-14 — card payment disputes after completion', () => {
  const brief = 'Payment integration brief with enough detail to start.';
  const fundingReferenceOf = async (orderId: string) => String((await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create'`)[0]!.provider_reference);
  const deliverAll = async () => {
    for (const delivery of provider.takeWebhookDeliveries()) expect((await postWebhook(delivery.rawBody, delivery.headers)).status).toBe(200);
  };

  async function approvedOrder(label: string) {
    const setup = await bookedOrder(label);
    expect((await pay(setup.buyer, setup.orderId)).status).toBe(200);
    const step = (actor: TestUser, fields: Record<string, string>) => command(actor, { idempotency_key: key('step'), order_id: setup.orderId, ...fields });
    expect((await step(setup.creator, { command: 'start' })).status).toBe(200);
    expect((await step(setup.creator, { command: 'deliver', body: 'Final launch thread with sources and the CTA.' })).status).toBe(200);
    expect((await step(setup.buyer, { command: 'approve', delivery_version: '1' })).status).toBe(200);
    return { ...setup, step };
  }

  it('ORD-14: a chargeback on a completed order keeps the work history, records evidence, alerts operators and books a lost dispute as a loss', async () => {
    const { buyer, orderId, step } = await approvedOrder('ord14');
    const { releaseReadySettlements } = await import('@/modules/jobs');
    await releaseReadySettlements({ orderId });
    expect((await step(buyer, { command: 'review', rating: '5', body: 'Clear and fast.' })).status).toBe(200);
    const before = await orderRow(orderId);
    expect(before).toMatchObject({ status: 'COMPLETED', settlement_status: 'RELEASED' });
    const history = async () => ({
      deliveries: await count(sql`select count(*)::int as count from app.deliveries where order_id=${orderId}`),
      reviews: await count(sql`select count(*)::int as count from app.reviews where order_id=${orderId}`),
      events: (await sql`select kind from app.order_events where order_id=${orderId} and kind not like 'PAYMENT_DISPUTE_%' order by created_at, id`).map((e) => e.kind),
    });
    const recorded = await history();

    // The buyer's bank disputes the payment; the signed webhook is verified like any other provider fact.
    const disputeRef = await provider.simulateChargeback(await fundingReferenceOf(orderId));
    const [opened] = provider.takeWebhookDeliveries();
    const tampered = new TextEncoder().encode(new TextDecoder().decode(opened!.rawBody).replace('"OPEN"', '"LOST"'));
    expect((await postWebhook(tampered, opened!.headers)).status).toBe(400);
    expect((await postWebhook(opened!.rawBody, opened!.headers)).body).toMatchObject({ received: true, duplicate: false });
    expect((await postWebhook(opened!.rawBody, opened!.headers)).body).toMatchObject({ received: true, duplicate: true });

    const [dispute] = await sql`select * from app.payment_disputes where order_id=${orderId}`;
    expect(dispute).toMatchObject({ status: 'OPEN', amount_minor: '65000', order_status_at_open: 'COMPLETED', settlement_status_at_open: 'RELEASED', closed_at: null });
    expect(dispute!.evidence).toMatchObject({ order_status: 'COMPLETED', buyer_reviews: 1, deliveries: [{ version: 1, validation_status: 'VALID' }] });
    expect(JSON.stringify(dispute!.evidence)).not.toContain(brief);
    expect(JSON.stringify(dispute!.evidence)).not.toContain('Final launch thread');
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='PAYMENT_DISPUTE' and status='OPEN'`)).toBe(1);
    expect(await count(sql`select count(*)::int as count from app.outbox where semantic_key=${`notify:payment.disputed:OPENED:${disputeRef}`}`)).toBe(1);

    await provider.simulateChargebackOutcome(disputeRef, 'LOST');
    await deliverAll();
    expect((await sql`select status,closed_at is not null as closed from app.payment_disputes where order_id=${orderId}`)[0]).toEqual({ status: 'LOST', closed: true });
    const chargeback = await sql`select e.account,e.amount_minor from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId} and t.kind='CHARGEBACK_LOST' order by e.account`;
    expect(chargeback.map((e) => [e.account, e.amount_minor])).toEqual([[`chargeback_loss:${orderId}`, '65000'], ['provider_clearing:mock', '-65000']]);
    expect((await ledgerBalance(orderId))[0]).toMatchObject({ total: '0' });
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='CHARGEBACK_LOST'`)).toBe(1);

    // The order, its work and the review are exactly as they were; nothing was taken from the creator.
    const after = await orderRow(orderId);
    expect({ status: after.status, version: after.version, completed_at: after.completed_at, settlement_status: after.settlement_status })
      .toEqual({ status: before.status, version: before.version, completed_at: before.completed_at, settlement_status: before.settlement_status });
    expect(await history()).toEqual(recorded);
    expect((await sql`select kind from app.order_events where order_id=${orderId} and kind like 'PAYMENT_DISPUTE_%' order by created_at`).map((e) => e.kind)).toEqual(['PAYMENT_DISPUTE_OPENED', 'PAYMENT_DISPUTE_LOST']);
    const accounts = (await sql`select distinct e.account from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId} order by e.account`).map((e) => e.account);
    expect(accounts).toEqual([`chargeback_loss:${orderId}`, `order_principal:${orderId}`, 'provider_clearing:mock']);
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where order_id=${orderId} and kind not in ('FUNDING_CAPTURED','SETTLEMENT_RELEASED','CHARGEBACK_LOST')`)).toBe(0);

    // The recorded facts cannot be rewritten.
    await expect(sql`update app.payment_disputes set status='WON' where order_id=${orderId}`).rejects.toThrow(/already LOST/);
    await expect(sql`update app.payment_disputes set evidence='{}'::jsonb where order_id=${orderId}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from app.payment_disputes where order_id=${orderId}`).rejects.toThrow();
  });

  it('ORD-14: an open dispute freezes a pending creator release until it is won', async () => {
    const { orderId } = await approvedOrder('ord14-freeze');
    const { releaseReadySettlements } = await import('@/modules/jobs');
    const disputeRef = await provider.simulateChargeback(await fundingReferenceOf(orderId), 20000n);
    await deliverAll();
    expect((await releaseReadySettlements({ orderId })).examined).toBe(0);
    expect(await orderRow(orderId)).toMatchObject({ status: 'APPROVED', settlement_status: 'READY' });

    await provider.simulateChargebackOutcome(disputeRef, 'WON');
    await deliverAll();
    expect((await sql`select status,amount_minor from app.payment_disputes where order_id=${orderId}`)[0]).toEqual({ status: 'WON', amount_minor: '20000' });
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where order_id=${orderId} and kind='CHARGEBACK_LOST'`)).toBe(0);
    expect((await releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_REQUESTED: 1 });
    expect((await orderRow(orderId)).status).toBe('COMPLETED');
  });

  it('ORD-14: a dispute for an unknown payment or a decision without an opening opens a case and records nothing', async () => {
    const unknown = forgeSignedEvent('dispute.opened', { objectType: 'dispute', reference: `mock_dispute_${key('u')}`, fundingReference: 'mock_funding_unknown_000001',
      operationId: 'dispute:unknown', orderId: '00000000-0000-4000-8000-000000000000', status: 'OPEN', amount: '1000', currency: 'USD', providerFee: null });
    expect((await postWebhook(unknown.body, unknown.headers)).status).toBe(200);
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where kind='UNMATCHED_PAYMENT_DISPUTE' and next_action like ${'%mock_dispute_%'}`)).toBeGreaterThan(0);

    const { orderId } = await approvedOrder('ord14-orphan');
    const decision = forgeSignedEvent('dispute.lost', { objectType: 'dispute', reference: `mock_dispute_${key('o')}`, fundingReference: await fundingReferenceOf(orderId),
      operationId: 'dispute:orphan', orderId, status: 'LOST', amount: '65000', currency: 'USD', providerFee: null });
    expect((await postWebhook(decision.body, decision.headers)).status).toBe(200);
    expect(await count(sql`select count(*)::int as count from app.payment_disputes where order_id=${orderId}`)).toBe(0);
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where order_id=${orderId} and kind='CHARGEBACK_LOST'`)).toBe(0);
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='UNMATCHED_PAYMENT_DISPUTE'`)).toBe(1);
  });
});

describe.skipIf(!RUN_DB)('PAY-15 — refunds after the creator was paid', () => {
  const reason = 'Buyer received duplicate charge; finance approved a refund.';
  const payeeOf = (userId: string) => `acct_mock_${userId.replaceAll('-', '')}`;
  const refundOp = (refundId: string) => sql`select status,outcome from app.provider_operations where operation_id=${`refund:after-release:${refundId}`}`;

  async function financeUser(): Promise<TestUser> {
    const { createSession } = await import('@/lib/auth');
    const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${`it-finance-${key('f')}@example.test`},'IT finance',${[]},true,'ACTIVE') returning id`;
    await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},'finance','Integration test operator grant')`;
    return { id: user!.id, email: '', token: await createSession(user!.id) };
  }

  async function completedOrder(label: string, creatorBalance: bigint) {
    const setup = await bookedOrder(label);
    expect((await pay(setup.buyer, setup.orderId)).status).toBe(200);
    const step = (actor: TestUser, fields: Record<string, string>) => command(actor, { idempotency_key: key('step'), order_id: setup.orderId, ...fields });
    expect((await step(setup.creator, { command: 'start' })).status).toBe(200);
    expect((await step(setup.creator, { command: 'deliver', body: 'Final launch thread with sources and the CTA.' })).status).toBe(200);
    expect((await step(setup.buyer, { command: 'approve', delivery_version: '1' })).status).toBe(200);
    const { releaseReadySettlements } = await import('@/modules/jobs');
    await releaseReadySettlements({ orderId: setup.orderId });
    expect(await orderRow(setup.orderId)).toMatchObject({ status: 'COMPLETED', settlement_status: 'RELEASED' });
    // What the creator still has in their provider balance after spending part of the payout.
    provider.setPayeeBalance(payeeOf(setup.creator.id), creatorBalance);
    return setup;
  }

  const ledgerOf = async (orderId: string) => Object.fromEntries((await sql`select e.account,sum(e.amount_minor)::text as total from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id
    where t.order_id=${orderId} group by e.account`).map((r) => [String(r.account).replace(orderId, '<order>'), r.total]));

  it('PAY-15: a reversal the creator balance cannot cover leaves an open deficit, nothing recovered and nothing refunded, until a retry succeeds', async () => {
    const { buyer, creator, orderId } = await completedOrder('pay15', 1000n);
    const finance = await financeUser();
    const refund = (actor: TestUser, amount: string) => command(actor, { command: 'admin_refund_after_release', idempotency_key: key('rar'), order_id: orderId, amount, reason });
    expect((await refund(buyer, '400')).status).toBe(403);
    expect((await refund(finance, '651')).status).toBe(409);

    const started = await refund(finance, '400');
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const refundId = String(started.body.id);
    expect((await sql`select status,recovered_minor,covered_minor from app.post_release_refunds where id=${refundId}`)[0]).toEqual({ status: 'DEFICIT', recovered_minor: '0', covered_minor: '0' });
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='REFUND_DEFICIT' and status='OPEN'`)).toBe(1);
    expect(await refundOp(refundId)).toHaveLength(0);
    expect(await count(sql`select count(*)::int as count from app.outbox where semantic_key like ${`notify:refund.updated:%${refundId}`}`)).toBe(0);
    expect((await ledgerOf(orderId))['post_release_refund:<order>']).toBeUndefined();
    expect((await refund(finance, '100')).status).toBe(409);

    // Recovery cannot be claimed without the provider's confirmed reversal, and a refund cannot be claimed without the provider's refund.
    await expect(sql`update app.post_release_refunds set recovered_minor=40000,status='REFUND_PENDING' where id=${refundId}`).rejects.toThrow(/not backed by confirmed reversals/);
    await expect(sql`update app.post_release_refunds set covered_minor=40000,covered_by=${finance.id},covered_reason=${reason},status='REFUNDED' where id=${refundId}`).rejects.toThrow(/provider-confirmed buyer refund/);

    // The creator's balance recovers; the same reversal operation now moves the money, then the buyer refund follows.
    provider.setPayeeBalance(payeeOf(creator.id), 50000n);
    const retried = await command(finance, { command: 'admin_retry_refund_recovery', idempotency_key: key('rr'), refund_id: refundId, reason });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    await funding.deliverPendingMockWebhooks();
    expect((await sql`select status,recovered_minor,covered_minor from app.post_release_refunds where id=${refundId}`)[0]).toEqual({ status: 'REFUNDED', recovered_minor: '40000', covered_minor: '0' });
    expect(await count(sql`select count(*)::int as count from app.provider_operations where operation_id=${`reversal:${refundId}`}`)).toBe(1);
    expect(await ledgerOf(orderId)).toMatchObject({ 'post_release_refund:<order>': '0', 'order_principal:<order>': '0' });
    expect((await ledgerBalance(orderId))[0]).toMatchObject({ total: '0' });
    expect(await count(sql`select count(*)::int as count from app.outbox where semantic_key=${`notify:refund.updated:SUCCEEDED:after-release:${refundId}`}`)).toBe(1);
    expect((await orderRow(orderId)).status).toBe('COMPLETED');
    expect(await count(sql`select count(*)::int as count from app.audit_log where entity_id=${refundId} and action like 'order.refund_after_release.%'`)).toBe(2);
  });

  it('PAY-15: finance can instead cover the deficit from platform funds, booked as a platform loss and never taken from the creator', async () => {
    const { orderId } = await completedOrder('pay15-cover', 0n);
    const finance = await financeUser();
    const started = await command(finance, { command: 'admin_refund_after_release', idempotency_key: key('rar'), order_id: orderId, amount: '650', reason });
    const refundId = String(started.body.id);
    expect((await sql`select status from app.post_release_refunds where id=${refundId}`)[0]!.status).toBe('DEFICIT');

    const covered = await command(finance, { command: 'admin_cover_refund_deficit', idempotency_key: key('cv'), refund_id: refundId, reason: 'Creator unreachable; platform refunds the buyer now.' });
    expect(covered.status, JSON.stringify(covered.body)).toBe(200);
    await funding.deliverPendingMockWebhooks();
    expect((await sql`select status,recovered_minor,covered_minor,covered_by from app.post_release_refunds where id=${refundId}`)[0]).toEqual({ status: 'REFUNDED', recovered_minor: '0', covered_minor: '65000', covered_by: finance.id });
    expect(await ledgerOf(orderId)).toMatchObject({ 'platform_loss:<order>': '65000', 'post_release_refund:<order>': '0' });
    expect((await ledgerBalance(orderId))[0]).toMatchObject({ total: '0' });
    expect((await provider.getFundingStatus(await (async () => String((await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create'`)[0]!.provider_reference))())).refundedSucceeded).toBe(65000n);
    expect((await refundOp(refundId))[0]!.status).toBe('SUCCEEDED');

    expect((await command(finance, { command: 'admin_retry_refund_recovery', idempotency_key: key('rr'), refund_id: refundId, reason })).status).toBe(409);
    expect((await command(finance, { command: 'admin_cover_refund_deficit', idempotency_key: key('cv'), refund_id: refundId, reason })).status).toBe(409);
    await expect(sql`update app.post_release_refunds set covered_reason='rewritten later by someone' where id=${refundId}`).rejects.toThrow(/already refunded/);
  });

  it('PAY-15: orders not yet paid out, or under a card dispute, do not take this path', async () => {
    const finance = await financeUser();
    const { buyer, orderId } = await bookedOrder('pay15-unpaid');
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await command(finance, { command: 'admin_refund_after_release', idempotency_key: key('rar'), order_id: orderId, amount: '100', reason })).status).toBe(409);

    const done = await completedOrder('pay15-disputed', 100000n);
    await provider.simulateChargeback(String((await sql`select provider_reference from app.provider_operations where order_id=${done.orderId} and kind='funding.create'`)[0]!.provider_reference));
    await funding.deliverPendingMockWebhooks();
    const refused = await command(finance, { command: 'admin_refund_after_release', idempotency_key: key('rar'), order_id: done.orderId, amount: '100', reason });
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toMatch(/card payment dispute/);
  });
});

describe.skipIf(!RUN_DB)('PAY-16 — provider costs that change after capture (cost-v1)', () => {
  const fundingRef = async (orderId: string) => String((await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create'`)[0]!.provider_reference);
  const adjustments = (orderId: string) => sql`select previous_fee_minor,actual_fee_minor,delta_minor,creator_share_minor,platform_share_minor,creator_credit_minor,phase,cap_minor
    from app.provider_cost_adjustments where order_id=${orderId} order by created_at, id`;
  const accountTotal = async (orderId: string, account: string) => String((await sql`select coalesce(sum(e.amount_minor),0)::text as total from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id
    where t.order_id=${orderId} and e.account=${account}`)[0]!.total);
  const deliver = async () => {
    const deliveries = provider.takeWebhookDeliveries();
    for (const d of deliveries) expect((await postWebhook(d.rawBody, d.headers)).status).toBe(200);
    return deliveries;
  };

  async function approvedWithFee(label: string) {
    vi.stubEnv('MOCK_PROVIDER_FEE_BPS', '300');
    const setup = await bookedOrder(label);
    expect((await pay(setup.buyer, setup.orderId)).status).toBe(200);
    const step = (actor: TestUser, fields: Record<string, string>) => command(actor, { idempotency_key: key('step'), order_id: setup.orderId, ...fields });
    expect((await step(setup.creator, { command: 'start' })).status).toBe(200);
    expect((await step(setup.creator, { command: 'deliver', body: 'Final launch thread with sources and the CTA.' })).status).toBe(200);
    expect((await step(setup.buyer, { command: 'approve', delivery_version: '1' })).status).toBe(200);
    expect(await orderRow(setup.orderId)).toMatchObject({ provider_fee_minor: '1950', settlement_status: 'READY' });
    return setup;
  }

  it('PAY-16: before payout the creator bears a late increase only up to the 1% cap; the platform bears the rest and the payout uses the result', async () => {
    try {
      const { orderId } = await approvedWithFee('pay16-before');
      const ref = await fundingRef(orderId);
      await provider.simulateFeeAdjustment(ref, 2600n);
      const [first] = await deliver();
      await provider.simulateFeeAdjustment(ref, 3900n);
      await deliver();
      expect((await postWebhook(first!.rawBody, first!.headers)).body).toMatchObject({ duplicate: true });
      expect(await adjustments(orderId)).toEqual([
        { previous_fee_minor: '1950', actual_fee_minor: '2600', delta_minor: '650', creator_share_minor: '650', platform_share_minor: '0', creator_credit_minor: '0', phase: 'BEFORE_RELEASE', cap_minor: '650' },
        { previous_fee_minor: '2600', actual_fee_minor: '3900', delta_minor: '1300', creator_share_minor: '0', platform_share_minor: '1300', creator_credit_minor: '0', phase: 'BEFORE_RELEASE', cap_minor: '650' },
      ]);
      expect((await orderRow(orderId)).provider_fee_minor).toBe('2600');
      expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='LATE_PROVIDER_COST_ABOVE_CAP'`)).toBe(1);

      const { releaseReadySettlements } = await import('@/modules/jobs');
      expect((await releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_REQUESTED: 1 });
      expect((await sql`select outcome->>'netAmount' as net from app.provider_operations where order_id=${orderId} and kind='release.create'`)[0]!.net).toBe('62400');
      expect(await orderRow(orderId)).toMatchObject({ status: 'COMPLETED', settlement_status: 'RELEASED' });
      // The platform's net cost is exactly the part above the cap; the order ledger still balances.
      expect(await accountTotal(orderId, 'provider_fee_expense:mock')).toBe('1300');
      expect((await ledgerBalance(orderId))[0]).toMatchObject({ total: '0' });

      await expect(sql`insert into app.provider_cost_adjustments (order_id,provider,event_id,previous_fee_minor,actual_fee_minor,delta_minor,creator_share_minor,platform_share_minor,phase,fee_payer,cap_bps,cap_minor)
        values (${orderId},'mock',${`evt_forged_${key('x')}`},3900,4900,1000,1,999,'BEFORE_RELEASE','CREATOR_AT_COST',100,650)`).rejects.toThrow(/exceeds the creator cap/);
      await expect(sql`update app.provider_cost_adjustments set creator_share_minor=0,platform_share_minor=650 where order_id=${orderId}`).rejects.toThrow(/immutable/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('PAY-16: after payout nothing is taken back; an increase is a platform expense and a lower final cost becomes a credit owed to the creator', async () => {
    try {
      const { orderId } = await approvedWithFee('pay16-after');
      const { releaseReadySettlements } = await import('@/modules/jobs');
      await releaseReadySettlements({ orderId });
      const released = await orderRow(orderId);
      expect(released).toMatchObject({ status: 'COMPLETED', settlement_status: 'RELEASED' });
      const ref = await fundingRef(orderId);

      await provider.simulateFeeAdjustment(ref, 2450n);
      await deliver();
      await provider.simulateFeeAdjustment(ref, 450n);
      await deliver();
      expect(await adjustments(orderId)).toEqual([
        { previous_fee_minor: '1950', actual_fee_minor: '2450', delta_minor: '500', creator_share_minor: '0', platform_share_minor: '500', creator_credit_minor: '0', phase: 'AFTER_RELEASE', cap_minor: '650' },
        { previous_fee_minor: '2450', actual_fee_minor: '450', delta_minor: '-2000', creator_share_minor: '0', platform_share_minor: '-2000', creator_credit_minor: '1950', phase: 'AFTER_RELEASE', cap_minor: '650' },
      ]);
      const after = await orderRow(orderId);
      expect({ fee: after.provider_fee_minor, version: after.version }).toEqual({ fee: released.provider_fee_minor, version: released.version });
      expect((await sql`select outcome->>'netAmount' as net from app.provider_operations where order_id=${orderId} and kind='release.create'`)[0]!.net).toBe('63050');
      expect(await accountTotal(orderId, `creator_cost_credit:${orderId}`)).toBe('-1950');
      expect((await ledgerBalance(orderId))[0]).toMatchObject({ total: '0' });
      expect((await sql`select kind from app.reconciliation_cases where order_id=${orderId} and kind like 'LATE_%' order by created_at`).map((c) => c.kind)).toEqual(['LATE_PROVIDER_COST_AFTER_RELEASE', 'LATE_COST_CREDIT_OWED']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('PAY-16: a cost update that arrives before its funding fact is retried from the inbox, not dropped or misapplied', async () => {
    try {
      const { buyer, orderId } = await bookedOrder('pay16-early');
      const { reference, deliveries } = await providerConfirmsWithoutDelivery(buyer, orderId);
      await provider.simulateFeeAdjustment(reference, 2000n);
      const [feeUpdate] = provider.takeWebhookDeliveries();
      expect((await postWebhook(feeUpdate!.rawBody, feeUpdate!.headers)).status).toBe(500);
      expect(await adjustments(orderId)).toHaveLength(0);
      for (const d of deliveries) expect((await postWebhook(d.rawBody, d.headers)).status).toBe(200);
      const { reprocessWebhookInbox } = await import('@/modules/jobs');
      expect((await reprocessWebhookInbox({ orderId, minAgeSeconds: 0 })).outcomes).toEqual({ COST_ADJUSTED_BEFORE_RELEASE: 1 });
      // This capture reported no cost; the late 20.00 is capped at 1% of the order for the creator.
      expect((await adjustments(orderId))[0]).toMatchObject({ previous_fee_minor: '0', actual_fee_minor: '2000', creator_share_minor: '650', platform_share_minor: '1350' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
