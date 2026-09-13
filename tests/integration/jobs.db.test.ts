import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider, type MockPaymentProviderOptions } from '@/modules/payments/providers';
import { poolCounters, RUN_DB, ORIGIN, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const jobsRoute = await import('@/app/api/dev/jobs/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const { listInAppNotifications } = await import('@/modules/notifications/store');
const { sql } = await import('@/lib/db');

let provider: MockPaymentProvider;
function useProvider(options: Partial<MockPaymentProviderOptions> = {}) {
  provider = new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_jobs_integration_secret'], ...options });
  funding.setMockPaymentProviderForTests(provider);
}

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const orderRow = async (orderId: string) => (await sql`select * from app.orders where id=${orderId}`)[0]!;
const count = async (query: Promise<{ count: number }[]>) => (await query)[0]!.count;
const payeeOf = (creator: TestUser) => `acct_mock_${creator.id.replaceAll('-', '')}`;

async function bookedOrder(label: string, creator?: TestUser) {
  const seller = creator ?? (await createUser(`${label}-creator`));
  const buyer = await createUser(`${label}-buyer`);
  const { serviceId, poolId } = await createPublishedService(command, seller, { capacity: 1 });
  const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief: 'Jobs integration brief with enough detail to start.' });
  if (booked.status !== 200) throw new Error(JSON.stringify(booked.body));
  return { creator: seller, buyer, serviceId, poolId, orderId: String(booked.body.id) };
}

async function expireHold(orderId: string) {
  await sql`update app.reservations set expires_at=now() - interval '1 minute' where order_id=${orderId}`;
}

async function completedOrder(label: string, creator?: TestUser) {
  const booked = await bookedOrder(label, creator);
  expect((await pay(booked.buyer, booked.orderId)).status).toBe(200);
  const step = (actor: TestUser, fields: Record<string, string>) => command(actor, { idempotency_key: key('step'), order_id: booked.orderId, ...fields });
  expect((await step(booked.creator, { command: 'start' })).status).toBe(200);
  expect((await step(booked.creator, { command: 'deliver', body: 'Final delivery with all agreed files.' })).status).toBe(200);
  expect((await step(booked.buyer, { command: 'approve', delivery_version: '1' })).status).toBe(200);
  return booked;
}

async function ledgerByAccount(orderId: string) {
  const rows = await sql`select e.account,sum(e.amount_minor)::text as total from app.ledger_entries e
    join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId} group by e.account order by e.account`;
  return Object.fromEntries(rows.map((r) => [String(r.account).replace(orderId, '<order>'), r.total]));
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

describe.skipIf(!RUN_DB)('expire_checkout_holds', () => {
  it('releases an expired unpaid hold once, and leaves unexpired holds alone', async () => {
    const expired = await bookedOrder('expire');
    const fresh = await bookedOrder('fresh');
    await expireHold(expired.orderId);

    expect((await jobs.expireCheckoutHolds({ orderId: fresh.orderId })).examined).toBe(0);
    const first = await jobs.expireCheckoutHolds({ orderId: expired.orderId });
    expect(first.outcomes).toEqual({ RELEASED: 1 });
    expect((await jobs.expireCheckoutHolds({ orderId: expired.orderId })).examined).toBe(0);

    expect(await orderRow(expired.orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'PENDING' });
    const [reservation] = await sql`select state from app.reservations where order_id=${expired.orderId}`;
    expect(reservation!.state).toBe('RELEASED');
    expect((await poolCounters(expired.poolId)).reserved_units).toBe(0);
    expect(await count(sql`select count(*)::int as count from app.order_events where order_id=${expired.orderId} and kind='HOLD_EXPIRED'`)).toBe(1);
    expect((await orderRow(fresh.orderId)).status).toBe('AWAITING_PAYMENT');
  });

  it('cancels an open provider intent before releasing', async () => {
    const { buyer, orderId } = await bookedOrder('expire-intent');
    const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, buyer.id, orderId));
    if (intent.state !== 'READY') throw new Error('intent not ready');
    await expireHold(orderId);
    expect((await jobs.expireCheckoutHolds({ orderId })).outcomes).toEqual({ RELEASED: 1 });
    expect((await provider.getFundingStatus(intent.reference)).status).toBe('CANCELED');
    expect((await pay(buyer, orderId)).status).toBe(400);
  });

  it('keeps capacity in RECONCILING when the provider already captured, then the late webhook funds the order', async () => {
    const { buyer, poolId, orderId } = await bookedOrder('expire-captured');
    const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, buyer.id, orderId));
    if (intent.state !== 'READY') throw new Error('intent not ready');
    await provider.simulateFundingOutcome(intent.reference, { status: 'SUCCEEDED' });
    const withheld = provider.takeWebhookDeliveries();
    await expireHold(orderId);

    expect((await jobs.expireCheckoutHolds({ orderId })).outcomes).toEqual({ RECONCILING: 1 });
    expect((await jobs.expireCheckoutHolds({ orderId })).outcomes).toEqual({ RECONCILING: 1 });
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='HOLD_EXPIRED_PAYMENT_UNRESOLVED' and status='OPEN'`)).toBe(1);
    const [reservation] = await sql`select state from app.reservations where order_id=${orderId}`;
    expect(reservation!.state).toBe('RECONCILING');

    const receipt = await funding.receivePaymentWebhook(withheld[0]!.rawBody, withheld[0]!.headers);
    expect(receipt.outcome).toBe('FUNDED');
    expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED' });
    const pool = await poolCounters(poolId);
    expect(pool).toMatchObject({ reserved_units: 0, committed_units: 1 });
    expect((await jobs.expireCheckoutHolds({ orderId })).examined).toBe(0);
  });

  it('expires an unpaid Buy Now auction order and defaults the auction (no silent relist)', async () => {
    const seller = await createUser('auc-exp-seller');
    const buyer = await createUser('auc-exp-buyer');
    const { serviceId } = await createPublishedService(command, seller, { capacity: 1 });
    const instant = (d: Date) => d.toISOString().slice(0, 19);
    const created = await command(seller, {
      command: 'create_auction', idempotency_key: key('auc'), service_id: serviceId, starting_price: '100', minimum_increment: '10', buy_now_price: '300',
      starts_at: instant(new Date(Date.now() - 60_000)), ends_at: instant(new Date(Date.now() + 3_600_000)),
    });
    const auctionId = String(created.body.id);
    const bought = await command(buyer, { command: 'buy_now', idempotency_key: key('bn'), auction_id: auctionId });
    expect(bought.status).toBe(200);
    const orderId = String(bought.body.id);
    await expireHold(orderId);
    expect((await jobs.expireCheckoutHolds({ orderId })).outcomes).toEqual({ RELEASED: 1 });
    const [auction] = await sql`select status from app.auctions where id=${auctionId}`;
    expect(auction!.status).toBe('WINNER_DEFAULTED');
  });
});

describe.skipIf(!RUN_DB)('release_ready_settlements (PAY-02/03/12)', () => {
  it('CREATOR_AT_COST: releases amount minus actual provider cost; all balances net to zero', async () => {
    vi.stubEnv('MOCK_PROVIDER_FEE_BPS', '300');
    try {
      const { creator, orderId } = await completedOrder('release-cost');
      expect((await orderRow(orderId)).settlement_status).toBe('READY');
      expect((await jobs.releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_REQUESTED: 1 });
      expect((await jobs.releaseReadySettlements({ orderId })).examined).toBe(0);

      expect(await orderRow(orderId)).toMatchObject({ status: 'COMPLETED', settlement_status: 'RELEASED', platform_fee_minor: '0', provider_fee_minor: '1950' });
      expect((await orderRow(orderId)).completed_at).not.toBeNull();
      const [operation] = await sql`select provider_reference,outcome from app.provider_operations where order_id=${orderId} and kind='release.create'`;
      const release = await provider.getReleaseStatus(String(operation!.provider_reference));
      expect(release).toMatchObject({ amount: 63050n, payeeAccountId: payeeOf(creator), platformFee: 0n, status: 'SUCCEEDED' });
      expect(await ledgerByAccount(orderId)).toEqual({ 'order_principal:<order>': '0', 'provider_clearing:mock': '0', 'provider_fee_expense:mock': '0' });
      const [event] = await sql`select payload from app.order_events where order_id=${orderId} and kind='SETTLEMENT_RELEASED'`;
      expect(event!.payload).toMatchObject({ creator_net_minor: '63050', provider_fee_minor: '1950', fee_policy: 'CREATOR_AT_COST', platform_fee_minor: '0' });
      expect(await count(sql`select count(*)::int as count from app.outbox where semantic_key=${`notify:payout.succeeded:${orderId}`}`)).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('PLATFORM_SUBSIDIZED: creator receives the full amount and the cost stays a platform expense', async () => {
    vi.stubEnv('MOCK_PROVIDER_FEE_BPS', '300');
    vi.stubEnv('FEE_PAYER_POLICY', 'PLATFORM_SUBSIDIZED');
    try {
      const { orderId } = await completedOrder('release-subsidy');
      await jobs.releaseReadySettlements({ orderId });
      const [operation] = await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='release.create'`;
      expect((await provider.getReleaseStatus(String(operation!.provider_reference))).amount).toBe(65000n);
      expect(await ledgerByAccount(orderId)).toEqual({ 'order_principal:<order>': '0', 'provider_clearing:mock': '-1950', 'provider_fee_expense:mock': '1950' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('missing payout capability keeps settlement READY, opens one case, and tells nobody money arrived', async () => {
    const creator = await createUser('release-nocap-creator');
    useProvider({ payeesWithoutPayouts: [payeeOf(creator)] });
    const { orderId } = await completedOrder('release-nocap', creator);
    expect((await jobs.releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_REJECTED_PAYEE_NOT_CAPABLE: 1 });
    expect((await jobs.releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_REJECTED_PAYEE_NOT_CAPABLE: 1 });
    expect((await orderRow(orderId)).settlement_status).toBe('READY');
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='PAYOUT_CAPABILITY_MISSING'`)).toBe(1);
    expect(await count(sql`select count(*)::int as count from app.provider_operations where order_id=${orderId} and kind='release.create'`)).toBe(1);
    expect(await count(sql`select count(*)::int as count from app.outbox where semantic_key like ${`notify:payout.%:${orderId}%`}`)).toBe(0);
  });

  it('an open dispute freezes release', async () => {
    const { buyer, orderId } = await completedOrder('release-dispute');
    await sql`insert into app.disputes (order_id,opened_by,reason) values (${orderId},${buyer.id},'Chargeback-style dispute opened after completion')`;
    expect((await jobs.releaseReadySettlements({ orderId })).examined).toBe(0);
    expect((await orderRow(orderId)).settlement_status).toBe('READY');
  });
});

describe.skipIf(!RUN_DB)('reconcile_provider_operations (PAY-10/11/20)', () => {
  it('a missing webhook is recovered from the provider API, and the late webhook is a duplicate fact', async () => {
    const { buyer, orderId } = await bookedOrder('reconcile-missing');
    const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, buyer.id, orderId));
    if (intent.state !== 'READY') throw new Error('intent not ready');
    await provider.simulateFundingOutcome(intent.reference, { status: 'SUCCEEDED' });
    const lost = provider.takeWebhookDeliveries();

    const reconciled = await jobs.reconcileProviderOperations({ orderId, minAgeSeconds: 0 });
    expect(reconciled.outcomes).toEqual({ FETCHED_FUNDED: 1 });
    expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED' });
    const [fetched] = await sql`select signature_verified,payload->>'source' as source from app.webhook_inbox where event_id=${`fetch:${intent.reference}:SUCCEEDED`}`;
    expect(fetched).toMatchObject({ signature_verified: false, source: 'provider_api_fetch' });

    expect((await funding.receivePaymentWebhook(lost[0]!.rawBody, lost[0]!.headers)).outcome).toBe('DUPLICATE_FACT');
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where order_id=${orderId}`)).toBe(1);
  });

  it('resolves UNKNOWN journals by lookup: applied → SUCCEEDED; not applied → FAILED and a fresh attempt funds once', async () => {
    useProvider({ failureInjection: [{ kind: 'funding.create', effect: 'ACCEPT_THEN_TIMEOUT' }] });
    const applied = await bookedOrder('reconcile-applied');
    expect((await pay(applied.buyer, applied.orderId)).status).toBe(503);
    expect((await jobs.reconcileProviderOperations({ orderId: applied.orderId, minAgeSeconds: 0 })).outcomes).toMatchObject({ RESOLVED_APPLIED: 1 });
    const [appliedOp] = await sql`select status,provider_reference from app.provider_operations where order_id=${applied.orderId}`;
    expect(appliedOp!.status).toBe('SUCCEEDED');
    expect(String(appliedOp!.provider_reference)).toMatch(/^mock_fund_/);

    useProvider({ failureInjection: [{ kind: 'funding.create', effect: 'TIMEOUT_BEFORE_ACCEPT' }] });
    const lost = await bookedOrder('reconcile-lost');
    expect((await pay(lost.buyer, lost.orderId)).status).toBe(503);
    expect((await jobs.reconcileProviderOperations({ orderId: lost.orderId, minAgeSeconds: 0 })).outcomes).toEqual({ RESOLVED_NOT_APPLIED: 1 });
    expect((await pay(lost.buyer, lost.orderId)).status).toBe(200);
    const operations = await sql`select operation_id,status from app.provider_operations where order_id=${lost.orderId} and kind='funding.create' order by created_at`;
    expect(operations.map((o) => [String(o.operation_id).split(':').at(-1), o.status])).toEqual([['1', 'FAILED'], ['2', 'SUCCEEDED']]);
    expect(await orderRow(lost.orderId)).toMatchObject({ status: 'FUNDED' });
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where order_id=${lost.orderId}`)).toBe(1);
  });

  it('a refund accepted-then-timed-out is matched by operation id and refunds exactly once', async () => {
    useProvider({ failureInjection: [{ kind: 'refund.create', effect: 'ACCEPT_THEN_TIMEOUT' }] });
    const { buyer, orderId } = await bookedOrder('reconcile-refund');
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: orderId })).status).toBe(200);

    expect(await orderRow(orderId)).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED' });
    const [refundOp] = await sql`select status,provider_reference from app.provider_operations where order_id=${orderId} and kind='refund.create'`;
    expect(refundOp!.status).toBe('UNKNOWN');
    expect(String(refundOp!.provider_reference)).toMatch(/^mock_re_/);
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${orderId} and kind='UNMATCHED_REFUND'`)).toBe(0);

    expect((await jobs.reconcileProviderOperations({ orderId, minAgeSeconds: 0 })).outcomes).toEqual({ RESOLVED_APPLIED: 1 });
    expect(await count(sql`select count(*)::int as count from app.ledger_transactions where order_id=${orderId} and kind='REFUND_SETTLED'`)).toBe(1);
    const [fundingOp] = await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create'`;
    expect((await provider.getFundingStatus(String(fundingOp!.provider_reference))).refundedSucceeded).toBe(65000n);
  });
});

describe.skipIf(!RUN_DB)('reprocess_webhook_inbox', () => {
  it('re-applies a verified event that was persisted but never processed', async () => {
    const { buyer, orderId } = await bookedOrder('reprocess');
    const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, buyer.id, orderId));
    if (intent.state !== 'READY') throw new Error('intent not ready');
    await provider.simulateFundingOutcome(intent.reference, { status: 'SUCCEEDED' });
    const [delivery] = provider.takeWebhookDeliveries();
    const event = await provider.verifyWebhook(delivery!.rawBody, delivery!.headers);
    // Simulates a crash after the inbox insert committed but before processing.
    await sql`insert into app.webhook_inbox (provider,mode,event_id,event_type,payload,signature_verified) values ('mock',${event.mode},${event.eventId},${event.type},
      ${JSON.stringify({ objectType: event.objectType, reference: event.reference, fundingReference: event.fundingReference, operationId: event.operationId, orderId: event.orderId, status: event.status, amount: event.amount.toString(), currency: event.currency, providerFee: event.providerFee?.toString() ?? null, createdAt: event.createdAt })}::jsonb,true)`;

    expect((await jobs.reprocessWebhookInbox({ orderId, minAgeSeconds: 0 })).outcomes).toEqual({ FUNDED: 1 });
    expect((await jobs.reprocessWebhookInbox({ orderId, minAgeSeconds: 0 })).examined).toBe(0);
    expect((await orderRow(orderId)).status).toBe('FUNDED');
    expect((await funding.receivePaymentWebhook(delivery!.rawBody, delivery!.headers)).duplicate).toBe(true);
  });
});

describe.skipIf(!RUN_DB)('dispatch_notification_outbox', () => {
  it('delivers outbox rows once into the in-app timeline and the local email sink, even with concurrent workers', async () => {
    const { buyer, creator, orderId } = await bookedOrder('notify');
    expect((await pay(buyer, orderId)).status).toBe(200);

    const [a, b] = await Promise.all([jobs.dispatchNotificationOutbox({ orderId }), jobs.dispatchNotificationOutbox({ orderId })]);
    expect((a.outcomes.SENT ?? 0) + (b.outcomes.SENT ?? 0)).toBe(2);
    expect((await jobs.dispatchNotificationOutbox({ orderId })).examined).toBe(0);

    // Force a redelivery of both rows: the durable dedupe key still prevents duplicates.
    await sql`update app.outbox set status='PENDING',sent_at=null where aggregate_id=${orderId}`;
    expect((await jobs.dispatchNotificationOutbox({ orderId })).outcomes).toEqual({ SENT: 2 });

    const rows = await sql`select recipient_id,channel,template_id,status from app.notifications where semantic_key like ${`notify:%:${orderId}`} order by template_id,channel`;
    expect(rows.map((r) => [r.recipient_id === buyer.id ? 'buyer' : r.recipient_id === creator.id ? 'creator' : 'other', r.template_id, r.channel, r.status])).toEqual([
      ['creator', 'order.new', 'email', 'EMAIL_SINK'],
      ['creator', 'order.new', 'in_app', 'DELIVERED'],
      ['buyer', 'payment.confirmed', 'email', 'EMAIL_SINK'],
      ['buyer', 'payment.confirmed', 'in_app', 'DELIVERED'],
    ]);
    const timeline = await listInAppNotifications(buyer.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ subject: 'Payment confirmed', link_path: `/orders/${orderId}` });
    expect(timeline[0]!.body).toContain('650.00 USD');
  });

  it('parks a poison message instead of retrying forever', async () => {
    const { buyer, orderId } = await bookedOrder('poison');
    await sql`insert into app.outbox (topic,aggregate_id,semantic_key,payload) values ('notification',${orderId},${`notify:bogus:${orderId}`},
      ${JSON.stringify({ templateId: 'does.not_exist', recipientId: buyer.id, params: {} })}::jsonb)`;
    expect((await jobs.dispatchNotificationOutbox({ orderId })).outcomes).toEqual({ POISONED: 1 });
    await sql`update app.outbox set available_at=now() - interval '1 hour' where semantic_key=${`notify:bogus:${orderId}`}`;
    expect((await jobs.dispatchNotificationOutbox({ orderId })).examined).toBe(0);
  });
});

describe.skipIf(!RUN_DB)('local jobs route', () => {
  it('runs every job once and refuses cross-origin browser calls', async () => {
    const ok = await jobsRoute.POST(new Request(`${ORIGIN}/api/dev/jobs`, { method: 'POST', headers: { origin: ORIGIN } }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { reports: { job: string }[] };
    expect(body.reports.map((r) => r.job)).toEqual([
      'reprocess_webhook_inbox', 'reconcile_provider_operations', 'expire_checkout_holds', 'expire_hire_offers', 'close_due_auctions', 'auto_accept_deliveries', 'release_ready_settlements', 'order_reminders', 'dispatch_notification_outbox', 'cleanup_storage',
    ]);
    const blocked = await jobsRoute.POST(new Request(`${ORIGIN}/api/dev/jobs`, { method: 'POST', headers: { origin: 'https://attacker.test' } }));
    expect(blocked.status).toBe(403);
  }, 30_000);
});
