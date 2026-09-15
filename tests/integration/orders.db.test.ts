import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider, type MockPaymentProviderOptions } from '@/modules/payments/providers';
import { RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, workloadCounters, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const lifecycle = await import('@/modules/orders/lifecycle');
const { sql } = await import('@/lib/db');

let provider: MockPaymentProvider;
function useProvider(options: Partial<MockPaymentProviderOptions> = {}) {
  provider = new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_orders_suite_secret_1'], ...options });
  funding.setMockPaymentProviderForTests(provider);
}

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const orderRow = async (orderId: string) => (await sql`select * from app.orders where id=${orderId}`)[0]!;
const events = async (orderId: string) => (await sql`select kind from app.order_events where order_id=${orderId} order by created_at asc, id asc`).map((e) => String(e.kind));
const brief = 'Orders suite brief: audience, goals, required facts and three headline options.';
const note = (label: string) => `${label}: all agreed files and copy are included here.`;

type Setup = { creator: TestUser; buyer: TestUser; serviceId: string; creatorId: string; orderId: string };

async function funded(label: string, options: { consent?: boolean } = {}): Promise<Setup> {
  const creator = await createUser(`${label}-creator`);
  const buyer = await createUser(`${label}-buyer`);
  const { serviceId, creatorId } = await createPublishedService(command, creator, { capacity: 3 });
  const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, ...(options.consent === false ? {} : { accept_terms: 'on' }) });
  if (booked.status !== 200) throw new Error(JSON.stringify(booked.body));
  const orderId = String(booked.body.id);
  const paid = await pay(buyer, orderId);
  if (paid.status !== 200) throw new Error(JSON.stringify(paid.body));
  return { creator, buyer, serviceId, creatorId, orderId };
}

const step = (actor: TestUser, orderId: string, fields: Record<string, string>) => command(actor, { idempotency_key: key('step'), order_id: orderId, ...fields });

/**
 * A funded order whose work clock started `hours` ago. Built through Buy Now (funded without a brief, so no deadline yet);
 * the clock inputs are backdated and the real clock rule sets the deadline, since a set deadline cannot be moved (drizzle/0020).
 */
async function clockStartedHoursAgo(label: string, hours: number) {
  const creator = await createUser(`${label}-creator`);
  const buyer = await createUser(`${label}-buyer`);
  const { serviceId } = await createPublishedService(command, creator, { capacity: 1 });
  const auction = await command(creator, { command: 'create_auction', idempotency_key: key('auc'), service_id: serviceId, starting_price: '100', minimum_increment: '10', buy_now_price: '200',
    starts_at: commandInstant(new Date(Date.now() - 60_000)), ends_at: commandInstant(new Date(Date.now() + 3_600_000)) });
  const orderId = String((await command(buyer, { command: 'buy_now', idempotency_key: key('bn'), auction_id: String(auction.body.id) })).body.id);
  expect((await pay(buyer, orderId)).status).toBe(200);
  await sql`update app.orders set brief=${brief},brief_ready_at=now() - make_interval(hours => ${hours}),funded_at=now() - make_interval(hours => ${hours}) where id=${orderId} and delivery_due_at is null`;
  await sql.begin((tx) => lifecycle.recomputeWorkClock(tx, orderId));
  return { creator, buyer, orderId };
}

async function delivered(label: string, options: { consent?: boolean } = {}) {
  const setup = await funded(label, options);
  expect((await step(setup.creator, setup.orderId, { command: 'start' })).status).toBe(200);
  expect((await step(setup.creator, setup.orderId, { command: 'deliver', body: note('V1') })).status).toBe(200);
  return setup;
}

async function ledgerByAccount(orderId: string) {
  const rows = await sql`select e.account,sum(e.amount_minor)::text as total from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id
    where t.order_id=${orderId} group by e.account order by e.account`;
  return Object.fromEntries(rows.map((r) => [String(r.account).replace(orderId, '<order>'), r.total]));
}

beforeEach(() => {
  if (RUN_DB) useProvider();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (RUN_DB) {
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('ORD — work clock and gating', () => {
  it('ORD-02: start/deliver are refused while payment is pending or the brief is missing', async () => {
    const creator = await createUser('ord02-creator');
    const buyer = await createUser('ord02-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 1 });
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief });
    const orderId = String(booked.body.id);
    const pendingStart = await step(creator, orderId, { command: 'start' });
    expect(pendingStart.status).toBe(409);
    expect(String(pendingStart.body.error)).toMatch(/Payment is not confirmed/);
    expect((await step(creator, orderId, { command: 'deliver', body: note('early') })).status).toBe(409);
    expect((await orderRow(orderId)).status).toBe('AWAITING_PAYMENT');

    // Auction purchases start without a brief: funded but blocked until the buyer completes it.
    const seller = await createUser('ord02-seller');
    const auctionBuyer = await createUser('ord02-auction-buyer');
    const { serviceId: auctionService } = await createPublishedService(command, seller, { capacity: 1 });
    const auction = await command(seller, { command: 'create_auction', idempotency_key: key('auc'), service_id: auctionService, starting_price: '100', minimum_increment: '10', buy_now_price: '200',
      starts_at: commandInstant(new Date(Date.now() - 60_000)), ends_at: commandInstant(new Date(Date.now() + 3_600_000)) });
    const bought = await command(auctionBuyer, { command: 'buy_now', idempotency_key: key('bn'), auction_id: String(auction.body.id) });
    const auctionOrder = String(bought.body.id);
    expect((await pay(auctionBuyer, auctionOrder)).status).toBe(200);
    const noBrief = await step(seller, auctionOrder, { command: 'start' });
    expect(noBrief.status).toBe(422);
    expect(String(noBrief.body.error)).toMatch(/not completed the brief/);
    const fundedRow = await orderRow(auctionOrder);
    expect(fundedRow).toMatchObject({ status: 'FUNDED', work_start_at: null, delivery_due_at: null });
    expect(fundedRow.funded_at).not.toBeNull();
  });

  it('ORD-03: the due date is max(funded_at, brief_ready_at) + turnaround, never null from max(null)', async () => {
    const seller = await createUser('ord03-seller');
    const buyer = await createUser('ord03-buyer');
    const { serviceId } = await createPublishedService(command, seller, { capacity: 1 });
    const auction = await command(seller, { command: 'create_auction', idempotency_key: key('auc'), service_id: serviceId, starting_price: '100', minimum_increment: '10', buy_now_price: '200',
      starts_at: commandInstant(new Date(Date.now() - 60_000)), ends_at: commandInstant(new Date(Date.now() + 3_600_000)) });
    const orderId = String((await command(buyer, { command: 'buy_now', idempotency_key: key('bn'), auction_id: String(auction.body.id) })).body.id);
    expect((await pay(buyer, orderId)).status).toBe(200);
    await sql`update app.orders set funded_at=now() - interval '5 hours' where id=${orderId}`;
    expect((await step(buyer, orderId, { command: 'submit_brief', brief })).status).toBe(200);
    const row = await orderRow(orderId);
    expect(new Date(row.work_start_at).getTime()).toBe(new Date(row.brief_ready_at).getTime());
    expect(new Date(row.delivery_due_at).getTime() - new Date(row.work_start_at).getTime()).toBe(72 * 3600_000);
    expect((await step(buyer, orderId, { command: 'submit_brief', brief })).status).toBe(422);
  });

  it('ORD-04: starting late does not move the agreed deadline', async () => {
    const { creator, orderId } = await funded('ord04');
    const before = await orderRow(orderId);
    // A set deadline moves only through an accepted amendment (ORD-12); a direct write is refused.
    await expect(sql`update app.orders set delivery_due_at=${new Date(Date.now() + 10 * 3600_000).toISOString()} where id=${orderId}`).rejects.toThrow(/accepted amendment/);
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    const after = await orderRow(orderId);
    expect(new Date(after.delivery_due_at).toISOString()).toBe(new Date(before.delivery_due_at).toISOString());
    expect(new Date(after.work_start_at).toISOString()).toBe(new Date(before.work_start_at).toISOString());
  });
});

describe.skipIf(!RUN_DB)('ORD — delivery, revision, approval', () => {
  it('ORD-05/06: V1 is kept, one revision resets the review clock on V2, a second revision is refused', async () => {
    const { creator, buyer, orderId } = await delivered('ord05');
    await sql`update app.orders set review_due_at=now() + interval '1 hour' where id=${orderId}`;
    expect((await step(buyer, orderId, { command: 'revision', delivery_version: '1', body: 'Please tighten the opening.' })).status).toBe(200);
    const revising = await orderRow(orderId);
    expect(revising).toMatchObject({ status: 'REVISION_REQUESTED', revision_count: 1 });
    expect(new Date(revising.revision_due_at).getTime() - Date.now()).toBeGreaterThan(47 * 3600_000);
    expect((await step(creator, orderId, { command: 'deliver', body: note('V2') })).status).toBe(200);
    const v2 = await orderRow(orderId);
    expect(new Date(v2.review_due_at).getTime() - Date.now()).toBeGreaterThan(71 * 3600_000);
    const versions = await sql`select version,body from app.deliveries where order_id=${orderId} order by version`;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(String(versions[0]!.body)).toContain('V1');
    await expect(sql`update app.deliveries set body='rewritten' where order_id=${orderId} and version=1`).rejects.toThrow(/append-only/);
    const second = await step(buyer, orderId, { command: 'revision', delivery_version: '2', body: 'Another round.' });
    expect(second.status).toBe(422);
    expect(String(second.body.error)).toMatch(/already been used/);
    expect((await step(buyer, orderId, { command: 'dispute', body: 'Scope item three is missing.' })).status).toBe(200);
  });

  it('ORD-07: an empty or non-http delivery is refused and does not start review', async () => {
    const { creator, orderId } = await funded('ord07');
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    expect((await step(creator, orderId, { command: 'deliver', body: 'ok' })).status).toBe(400);
    expect((await step(creator, orderId, { command: 'deliver', body: '', url: 'javascript:alert(1)' })).status).toBe(400);
    const row = await orderRow(orderId);
    expect(row).toMatchObject({ status: 'IN_PROGRESS', review_due_at: null });
    expect((await step(creator, orderId, { command: 'deliver', body: '', url: 'https://files.example.com/final.zip' })).status).toBe(200);
  });

  it('ORD-08: approving a stale version is a conflict and approves nothing', async () => {
    const { creator, buyer, orderId } = await delivered('ord08');
    expect((await step(buyer, orderId, { command: 'revision', delivery_version: '1', body: 'Adjust the tone please.' })).status).toBe(200);
    expect((await step(creator, orderId, { command: 'deliver', body: note('V2') })).status).toBe(200);
    const stale = await step(buyer, orderId, { command: 'approve', delivery_version: '1' });
    expect(stale.status).toBe(409);
    expect(String(stale.body.error)).toMatch(/newer delivery \(version 2\)/);
    expect((await step(buyer, orderId, { command: 'approve' })).status).toBe(400);
    expect((await orderRow(orderId)).status).toBe('DELIVERED');
    expect((await step(buyer, orderId, { command: 'approve', delivery_version: '2' })).status).toBe(200);
  });

  it('ORD-10: concurrent approve, revision, dispute and auto-accept serialize to exactly one outcome', async () => {
    const { buyer, creator, orderId } = await delivered('ord10');
    await sql`update app.orders set review_due_at=now() - interval '1 minute' where id=${orderId}`;
    await sql`update app.deliveries set buyer_viewed_at=now() where order_id=${orderId}`;
    const results = await Promise.all([
      step(buyer, orderId, { command: 'approve', delivery_version: '1' }),
      step(buyer, orderId, { command: 'revision', delivery_version: '1', body: 'Change the headline.' }),
      step(creator, orderId, { command: 'dispute', body: 'Buyer is unresponsive about scope.' }),
      jobs.autoAcceptDeliveries({ orderId }),
    ]);
    const commandWins = results.slice(0, 3).filter((r) => (r as { status: number }).status === 200).length;
    const autoApproved = (results[3] as { outcomes: Record<string, number> }).outcomes.AUTO_APPROVED ?? 0;
    expect(commandWins + autoApproved).toBe(1);
    const row = await orderRow(orderId);
    expect(['APPROVED', 'REVISION_REQUESTED', 'DISPUTED']).toContain(row.status);
    const kinds = await events(orderId);
    expect(kinds.filter((k) => ['ORDER_APPROVED', 'ORDER_AUTO_APPROVED', 'REVISION_REQUESTED', 'DISPUTE_OPENED'].includes(k))).toHaveLength(1);
  });
});

describe.skipIf(!RUN_DB)('ORD — auto-accept and review holds', () => {
  it('ORD-09/16: expired review window + consent + buyer viewed → one auto-approval even when replayed', async () => {
    const { buyer, orderId } = await delivered('ord09');
    expect((await step(buyer, orderId, { command: 'mark_delivery_viewed' })).status).toBe(200);
    await sql`update app.orders set review_due_at=now() - interval '1 minute' where id=${orderId}`;
    const [first, second] = await Promise.all([jobs.autoAcceptDeliveries({ orderId }), jobs.autoAcceptDeliveries({ orderId })]);
    expect((first.outcomes.AUTO_APPROVED ?? 0) + (second.outcomes.AUTO_APPROVED ?? 0)).toBe(1);
    expect((await jobs.autoAcceptDeliveries({ orderId })).examined).toBe(0);
    expect(await orderRow(orderId)).toMatchObject({ status: 'APPROVED', settlement_status: 'READY' });
    expect((await events(orderId)).filter((k) => k === 'ORDER_AUTO_APPROVED')).toHaveLength(1);
    expect((await jobs.releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_REQUESTED: 1 });
    expect((await orderRow(orderId)).status).toBe('COMPLETED');
  });

  it('ORD-11: without view evidence the order stays DELIVERED on hold; viewing later restarts a full review window', async () => {
    const { buyer, orderId } = await delivered('ord11');
    await sql`update app.orders set review_due_at=now() - interval '1 minute' where id=${orderId}`;
    expect((await jobs.autoAcceptDeliveries({ orderId })).outcomes).toEqual({ HOLD_NO_BUYER_NOTIFICATION_EVIDENCE: 1 });
    expect((await jobs.autoAcceptDeliveries({ orderId })).examined).toBe(0);
    expect((await orderRow(orderId)).status).toBe('DELIVERED');
    const [hold] = await sql`select reason,resolved_at from app.review_holds where order_id=${orderId}`;
    expect(hold).toMatchObject({ reason: 'NO_BUYER_NOTIFICATION_EVIDENCE', resolved_at: null });
    expect((await sql`select count(*)::int as n from app.reconciliation_cases where order_id=${orderId} and kind='REVIEW_HOLD'`)[0]!.n).toBe(1);

    expect((await step(buyer, orderId, { command: 'mark_delivery_viewed' })).status).toBe(200);
    const resumed = await orderRow(orderId);
    expect(new Date(resumed.review_due_at).getTime() - Date.now()).toBeGreaterThan(71 * 3600_000);
    expect((await sql`select resolution from app.review_holds where order_id=${orderId}`)[0]!.resolution).toBe('BUYER_VIEWED');
    expect(await events(orderId)).toContain('REVIEW_WINDOW_RESUMED');
    expect((await jobs.autoAcceptDeliveries({ orderId })).examined).toBe(0);
  });

  it('no auto-accept consent creates a hold instead of approving', async () => {
    const { buyer, orderId } = await delivered('ord-noconsent', { consent: false });
    await step(buyer, orderId, { command: 'mark_delivery_viewed' });
    await sql`update app.orders set review_due_at=now() - interval '1 minute' where id=${orderId}`;
    expect((await jobs.autoAcceptDeliveries({ orderId })).outcomes).toEqual({ HOLD_NO_AUTO_ACCEPT_CONSENT: 1 });
    expect((await orderRow(orderId)).status).toBe('DELIVERED');
  });

  it('reminders are queued once per semantic event', async () => {
    const { orderId } = await delivered('ord-remind');
    await sql`update app.orders set review_due_at=now() + interval '2 hours' where id=${orderId}`;
    expect((await jobs.sendOrderReminders({ orderId })).outcomes).toEqual({ REVIEW_REMINDER: 1 });
    await jobs.sendOrderReminders({ orderId });
    expect((await sql`select count(*)::int as n from app.outbox where semantic_key like ${`notify:order.review_reminder:${orderId}:%`}`)[0]!.n).toBe(1);
  });
});

describe.skipIf(!RUN_DB)('ORD — cancellation after work starts', () => {
  it('ORD-13: an overdue order notifies the buyer; unilateral cancel is refused after work starts', async () => {
    // The work clock started 80 hours ago and the service turnaround is 72 hours, so the order is 8 hours overdue.
    const { buyer, creator, orderId } = await clockStartedHoursAgo('ord13', 80);
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    expect((await jobs.sendOrderReminders({ orderId })).outcomes).toEqual({ OVERDUE: 1 });
    const unilateral = await step(buyer, orderId, { command: 'cancel' });
    expect(unilateral.status).toBe(409);
    expect(String(unilateral.body.error)).toMatch(/request a cancellation/);
    const request = await step(buyer, orderId, { command: 'request_cancellation', refund_amount: '200', reason: 'Work is overdue and no update was shared.' });
    expect(request.status).toBe(200);
    expect((await step(buyer, orderId, { command: 'request_cancellation', refund_amount: '200', reason: 'Duplicate request attempt.' })).status).toBe(409);
    expect((await orderRow(orderId)).status).toBe('IN_PROGRESS');
  });

  it('ORD-15: accepted partial refund refunds the agreed amount, releases the remainder, and frees the creator\'s place', async () => {
    useProvider({ refundSettlement: 'immediate' });
    const { buyer, creator, orderId, creatorId } = await funded('ord15');
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    const requested = await step(creator, orderId, { command: 'request_cancellation', refund_amount: '400', reason: 'Client changed direction halfway through.' });
    const requestId = String(requested.body.id);
    // The requester cannot accept their own request.
    expect((await step(creator, orderId, { command: 'respond_cancellation', request_id: requestId, decision: 'accept' })).status).toBe(403);
    await expect(sql`update app.cancellation_requests set refund_amount_minor=1 where id=${requestId}`).rejects.toThrow(/immutable/);

    const accepted = await command(buyer, { command: 'respond_cancellation', idempotency_key: key('resp'), request_id: requestId, decision: 'accept' });
    expect(accepted.status).toBe(200);
    const cancelled = await orderRow(orderId);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancellation_refund_minor: '40000', payment_status: 'PARTIALLY_REFUNDED', settlement_status: 'READY' });
    const [claim] = await sql`select state from app.workload_claims where order_id=${orderId}`;
    expect(claim!.state).toBe('RELEASED');
    expect(await workloadCounters(creatorId)).toMatchObject({ active_units: 0, held_units: 0 });

    expect((await jobs.releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_REQUESTED: 1 });
    const settled = await orderRow(orderId);
    expect(settled).toMatchObject({ status: 'CANCELLED', settlement_status: 'RELEASED' });
    const [refundOp] = await sql`select operation_id,provider_reference from app.provider_operations where order_id=${orderId} and kind='refund.create'`;
    expect(String(refundOp!.operation_id)).toBe(`refund:${orderId}:agreed`);
    expect((await provider.getRefundStatus(String(refundOp!.provider_reference))).amount).toBe(40000n);
    const [releaseOp] = await sql`select operation_id,provider_reference from app.provider_operations where order_id=${orderId} and kind='release.create'`;
    expect(String(releaseOp!.operation_id)).toBe(`release:${orderId}:remainder`);
    expect((await provider.getReleaseStatus(String(releaseOp!.provider_reference))).amount).toBe(25000n);
    expect(await ledgerByAccount(orderId)).toEqual({ 'order_principal:<order>': '0', 'provider_clearing:mock': '0' });
    expect((await step(buyer, orderId, { command: 'review', rating: '5', body: 'Not eligible.' })).status).toBe(409);
  });

  it('ORD-15: a delivery racing the acceptance leaves one serialized decision', async () => {
    const { buyer, creator, orderId } = await funded('ord15-race');
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    const requested = await step(buyer, orderId, { command: 'request_cancellation', refund_amount: '650', reason: 'Plans changed on our side.' });
    const requestId = String(requested.body.id);
    const [accept, deliver] = await Promise.all([
      command(creator, { command: 'respond_cancellation', idempotency_key: key('resp'), request_id: requestId, decision: 'accept' }),
      step(creator, orderId, { command: 'deliver', body: note('race') }),
    ]);
    expect([accept.status, deliver.status].filter((s) => s === 200)).toHaveLength(1);
    const row = await orderRow(orderId);
    const [request] = await sql`select status from app.cancellation_requests where id=${requestId}`;
    if (accept.status === 200) {
      // The full refund's post-commit mock webhook may already have landed (CANCELLED → REFUNDED).
      expect(['CANCELLED', 'REFUNDED']).toContain(row.status);
      expect(request!.status).toBe('ACCEPTED');
    } else {
      expect(row.status).toBe('DELIVERED');
      expect(request!.status).toBe('EXPIRED');
    }
    expect((await sql`select count(*)::int as n from app.provider_operations where order_id=${orderId} and kind in ('refund.create','release.create')`)[0]!.n).toBeLessThanOrEqual(1);
  });

  it('a request made before a later delivery can no longer be accepted', async () => {
    const { buyer, creator, orderId } = await funded('ord15-stale');
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    const requestId = String((await step(buyer, orderId, { command: 'request_cancellation', refund_amount: '100', reason: 'Scope no longer needed.' })).body.id);
    expect((await step(creator, orderId, { command: 'deliver', body: note('after request') })).status).toBe(200);
    const late = await command(creator, { command: 'respond_cancellation', idempotency_key: key('resp'), request_id: requestId, decision: 'accept' });
    expect(late.status).toBe(409);
    expect((await sql`select status from app.cancellation_requests where id=${requestId}`)[0]!.status).toBe('EXPIRED');
  });
});

describe.skipIf(!RUN_DB)('REV — reviews and reputation', () => {
  it('REV-01/02: outsiders and incomplete orders cannot review; double submit keeps one review', async () => {
    const { buyer, creator, orderId } = await delivered('rev');
    expect((await step(buyer, orderId, { command: 'approve', delivery_version: '1' })).status).toBe(200);
    expect((await step(buyer, orderId, { command: 'review', rating: '5', body: 'Early review attempt.' })).status).toBe(409);
    await jobs.releaseReadySettlements({ orderId });
    expect((await step(await createUser('rev-outsider'), orderId, { command: 'review', rating: '1', body: 'Not mine.' })).status).toBe(403);
    expect((await step(creator, orderId, { command: 'review', rating: '5', body: 'Self review.' })).status).toBe(403);
    const reviews = await Promise.all([1, 2, 3].map((n) => step(buyer, orderId, { command: 'review', rating: String(n + 2), body: `Great work ${n}` })));
    expect(reviews.every((r) => r.status === 200)).toBe(true);
    expect((await sql`select count(*)::int as n from app.reviews where order_id=${orderId}`)[0]!.n).toBe(1);
  });

  it('REV-03: reputation counts only eligible completed orders and reports N; fixtures are excluded by default', async () => {
    const { buyer, creator, orderId } = await delivered('rev03');
    expect((await step(buyer, orderId, { command: 'approve', delivery_version: '1' })).status).toBe(200);
    await jobs.releaseReadySettlements({ orderId });
    await step(buyer, orderId, { command: 'review', rating: '4', body: 'Solid delivery.' });
    expect(await lifecycle.creatorReputation(sql, creator.id)).toEqual({ completed_jobs: 0, on_time_rate: null, on_time_sample: 0, rating: null, review_count: 0, repeat_buyers: 0 });
    vi.stubEnv('REPUTATION_INCLUDE_TEST_DATA', 'true');
    expect(await lifecycle.creatorReputation(sql, creator.id)).toEqual({ completed_jobs: 1, on_time_rate: 1, on_time_sample: 1, rating: 4, review_count: 1, repeat_buyers: 0 });
  });
});

describe.skipIf(!RUN_DB)('DB guards', () => {
  it('the database refuses transitions outside the §7.2 matrix and status changes without a version bump', async () => {
    const { orderId } = await delivered('guard');
    await expect(sql`update app.orders set status='COMPLETED',version=version+1 where id=${orderId}`).rejects.toThrow(/invalid order transition DELIVERED -> COMPLETED/);
    await expect(sql`update app.orders set status='AWAITING_PAYMENT',version=version+1 where id=${orderId}`).rejects.toThrow(/invalid order transition/);
    await expect(sql`update app.orders set status='APPROVED' where id=${orderId}`).rejects.toThrow(/must increment version/);
    await expect(sql`delete from app.deliveries where order_id=${orderId}`).rejects.toThrow(/immutable/);
  });
});

describe.skipIf(!RUN_DB)('ORD-12 — deadline extensions by agreement', () => {
  const amendmentsOf = async (orderId: string) => sql`select status,deadline,old_due_at,new_due_at,proposed_by from app.order_amendments where order_id=${orderId} order by created_at`;
  const hoursFrom = (from: Date | string, hours: number) => commandInstant(new Date(new Date(from).getTime() + hours * 3600_000));

  it('ORD-12: a proposal changes nothing until the other party accepts; the agreed deadline is recorded and cannot be rewritten', async () => {
    const { buyer, creator, orderId } = await funded('ord12-accept');
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    const original = (await orderRow(orderId)).delivery_due_at;
    const newDue = hoursFrom(original, 48);

    const proposed = await step(creator, orderId, { command: 'request_deadline_extension', new_due_at: newDue, reason: 'The buyer added two extra audiences to the brief.' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    const amendmentId = String(proposed.body.id);
    expect(new Date((await orderRow(orderId)).delivery_due_at).toISOString()).toBe(new Date(original).toISOString());
    expect((await sql`select count(*)::int as n from app.outbox where semantic_key=${`notify:order.deadline_extension_requested:${amendmentId}`}`)[0]!.n).toBe(1);

    // Only the other party decides; the proposer cannot accept their own proposal and outsiders see nothing.
    const respond = (actor: TestUser, decision: string) => command(actor, { command: 'respond_deadline_extension', idempotency_key: key('amend'), amendment_id: amendmentId, decision });
    expect((await respond(creator, 'accept')).status).toBe(403);
    expect((await respond(await createUser('ord12-outsider'), 'accept')).status).toBe(403);
    expect((await respond(buyer, 'withdraw')).status).toBe(403);
    expect((await step(buyer, orderId, { command: 'request_deadline_extension', new_due_at: hoursFrom(original, 24), reason: 'A second proposal while one is open.' })).status).toBe(409);

    expect((await respond(buyer, 'accept')).status).toBe(200);
    const after = await orderRow(orderId);
    expect(new Date(after.delivery_due_at).toISOString()).toBe(new Date(`${newDue}Z`).toISOString());
    expect(await amendmentsOf(orderId)).toMatchObject([{ status: 'ACCEPTED', deadline: 'DELIVERY', proposed_by: creator.id }]);
    expect((await sql`select payload from app.order_events where order_id=${orderId} and kind='DEADLINE_EXTENDED'`)[0]!.payload).toMatchObject({ amendment_id: amendmentId, deadline: 'DELIVERY' });
    expect((await respond(buyer, 'accept')).status).toBe(409);

    // The record is immutable, and the deadline cannot be moved again without a new accepted amendment.
    await expect(sql`update app.order_amendments set new_due_at=new_due_at + interval '1 day' where id=${amendmentId}`).rejects.toThrow(/immutable/);
    await expect(sql`update app.order_amendments set status='REJECTED' where id=${amendmentId}`).rejects.toThrow(/already ACCEPTED/);
    await expect(sql`delete from app.order_amendments where id=${amendmentId}`).rejects.toThrow();
    await expect(sql`update app.orders set delivery_due_at=delivery_due_at + interval '1 day' where id=${orderId}`).rejects.toThrow(/accepted amendment/);
  });

  it('ORD-12: dates must move later within the cap; declined and withdrawn proposals keep the deadline', async () => {
    const { buyer, creator, orderId } = await funded('ord12-rules');
    const due = (await orderRow(orderId)).delivery_due_at;
    const propose = (actor: TestUser, newDue: string, reason = 'Waiting on the buyer’s launch date confirmation.') => step(actor, orderId, { command: 'request_deadline_extension', new_due_at: newDue, reason });
    expect((await propose(creator, hoursFrom(due, -1))).status).toBe(400);
    expect((await propose(creator, hoursFrom(due, 91 * 24))).status).toBe(400);
    expect((await propose(creator, hoursFrom(due, 24), 'short')).status).toBe(400);

    // Proposed while funded, still valid after work starts (starting does not change the deadline); then declined.
    const declined = await propose(buyer, hoursFrom(due, 24));
    expect(declined.status).toBe(200);
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    expect((await command(creator, { command: 'respond_deadline_extension', idempotency_key: key('amend'), amendment_id: String(declined.body.id), decision: 'reject' })).status).toBe(200);
    const withdrawn = await propose(creator, hoursFrom(due, 12));
    expect((await command(creator, { command: 'respond_deadline_extension', idempotency_key: key('amend'), amendment_id: String(withdrawn.body.id), decision: 'withdraw' })).status).toBe(200);
    expect(new Date((await orderRow(orderId)).delivery_due_at).toISOString()).toBe(new Date(due).toISOString());
    expect((await amendmentsOf(orderId)).map((a) => a.status)).toEqual(['REJECTED', 'WITHDRAWN']);
  });

  it('ORD-12: a delivery expires the open proposal, so consent never outlives the order it was given for', async () => {
    const { buyer, creator, orderId } = await funded('ord12-expire');
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    const due = (await orderRow(orderId)).delivery_due_at;
    const proposed = await step(creator, orderId, { command: 'request_deadline_extension', new_due_at: hoursFrom(due, 24), reason: 'Need one more day for the video edit.' });
    expect((await step(creator, orderId, { command: 'deliver', body: note('V1') })).status).toBe(200);
    expect((await amendmentsOf(orderId)).map((a) => a.status)).toEqual(['EXPIRED']);
    expect((await sql`select count(*)::int as n from app.order_events where order_id=${orderId} and kind='DEADLINE_EXTENSION_EXPIRED'`)[0]!.n).toBe(1);
    expect((await command(buyer, { command: 'respond_deadline_extension', idempotency_key: key('amend'), amendment_id: String(proposed.body.id), decision: 'accept' })).status).toBe(409);
    expect((await step(buyer, orderId, { command: 'request_deadline_extension', new_due_at: hoursFrom(due, 24), reason: 'Nothing is due while I review.' })).status).toBe(409);
  });

  it('ORD-12: lateness and the on-time metric use the agreed deadline', async () => {
    // 8 hours overdue on the original deadline; both sides agree to 24 hours from now, then the creator delivers.
    const { buyer, creator, orderId } = await clockStartedHoursAgo('ord12-metric', 80);
    expect((await step(creator, orderId, { command: 'start' })).status).toBe(200);
    const proposed = await step(creator, orderId, { command: 'request_deadline_extension', new_due_at: commandInstant(new Date(Date.now() + 24 * 3600_000)), reason: 'Launch moved; buyer asked to include the new date.' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    expect((await command(buyer, { command: 'respond_deadline_extension', idempotency_key: key('amend'), amendment_id: String(proposed.body.id), decision: 'accept' })).status).toBe(200);
    expect((await step(creator, orderId, { command: 'deliver', body: note('V1') })).status).toBe(200);
    expect((await sql`select payload->>'late' as late from app.order_events where order_id=${orderId} and kind='DELIVERED'`)[0]!.late).toBe('false');
    expect((await step(buyer, orderId, { command: 'approve', delivery_version: '1' })).status).toBe(200);
    await jobs.releaseReadySettlements({ orderId });
    expect((await orderRow(orderId)).status).toBe('COMPLETED');
    vi.stubEnv('REPUTATION_INCLUDE_TEST_DATA', 'true');
    expect(await lifecycle.creatorReputation(sql, creator.id)).toMatchObject({ completed_jobs: 1, on_time_sample: 1, on_time_rate: 1 });
  });
});
