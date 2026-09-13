import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Actor } from '@/lib/auth';
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider, signMockWebhook } from '@/modules/payments/providers';
import { ORIGIN, RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, poolCounters, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const webhook = await import('@/app/api/webhooks/mock-payment/route');
const snapshotRoute = await import('@/app/api/auctions/[id]/snapshot/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const { getAuctionData, getMyBids } = await import('@/lib/read-model');
const { sql } = await import('@/lib/db');
const { createSession } = await import('@/lib/auth');

const SECRET = 'whsec_auctions_suite_secret_1';
let provider: MockPaymentProvider;
const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const asActor = (user: TestUser): Actor => ({ id: user.id, email: user.email, display_name: 'x', roles: ['buyer', 'creator'], is_test: true, status: 'ACTIVE', timezone: 'UTC' });
const sleepUntil = async (date: Date) => new Promise((resolve) => setTimeout(resolve, Math.max(0, date.getTime() - Date.now()) + 1200));
const auctionRow = async (id: string) => (await sql`select * from app.auctions where id=${id}`)[0]!;
const reason = 'Moderator evidence recorded for the auction integration suite.';

type Setup = { seller: TestUser; poolId: string; auctionId: string; endsAt: Date };
async function auction(label: string, options: { endsInMs?: number; startsInMs?: number; buyNow?: string } = {}): Promise<Setup> {
  const seller = await createUser(`${label}-seller`);
  const { serviceId, poolId } = await createPublishedService(command, seller, { capacity: 2 });
  // Whole seconds: the command parser drops sub-second precision.
  const endsAt = new Date(Math.ceil((Date.now() + (options.endsInMs ?? 3_600_000)) / 1000) * 1000);
  const created = await command(seller, {
    command: 'create_auction', idempotency_key: key('auc'), service_id: serviceId, starting_price: '100', minimum_increment: '10',
    ...(options.buyNow ? { buy_now_price: options.buyNow } : {}),
    starts_at: commandInstant(new Date(Date.now() + (options.startsInMs ?? -60_000))), ends_at: commandInstant(endsAt),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { seller, poolId, auctionId: String(created.body.id), endsAt };
}
const bid = (actor: TestUser, auctionId: string, amount: string) => command(actor, { command: 'bid', idempotency_key: key('bid'), auction_id: auctionId, amount });
const buyNow = (actor: TestUser, auctionId: string) => command(actor, { command: 'buy_now', idempotency_key: key('bn'), auction_id: auctionId });

async function operator(role: 'moderator'): Promise<TestUser> {
  const email = `it-auc-${role}-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'IT moderator',${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},${role},'Auction suite operator grant')`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}

beforeEach(() => {
  if (!RUN_DB) return;
  provider = new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: [SECRET] });
  funding.setMockPaymentProviderForTests(provider);
});
afterAll(async () => {
  if (RUN_DB) {
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('AUC-01..04/09 — schedule and bid', () => {
  it('AUC-01: scheduling claims a week that still fits the work after the winner window, with a terms snapshot', async () => {
    const setup = await auction('auc01', { buyNow: '300' });
    const [claim] = await sql`select r.state,r.bucket_id,b.ends_at as bucket_ends_at from app.reservations r join app.capacity_buckets b on b.id=r.bucket_id where r.auction_id=${setup.auctionId}`;
    expect(claim!.state).toBe('HELD');
    const row = await auctionRow(setup.auctionId);
    expect(row).toMatchObject({ status: 'LIVE', version: 1 });
    const terms = row.terms_snapshot as Record<string, unknown>;
    expect(terms).toMatchObject({ starting_price_minor: '10000', buy_now_price_minor: '30000', winner_payment_hours: 24, turnaround_hours: 72 });
    expect(new Date(claim!.bucket_ends_at).getTime()).toBeGreaterThanOrEqual(setup.endsAt.getTime() + (24 + 72) * 3600_000);
    expect((await poolCounters(setup.poolId)).reserved_units).toBe(1);

    const { serviceId } = await createPublishedService(command, setup.seller, { capacity: 1 });
    const base = { command: 'create_auction', service_id: serviceId, starting_price: '100', minimum_increment: '10', starts_at: commandInstant(new Date(Date.now() - 60_000)) };
    expect((await command(setup.seller, { ...base, idempotency_key: key('a'), ends_at: commandInstant(new Date(Date.now() + 8 * 86_400_000)) })).status).toBe(400);
    expect((await command(setup.seller, { ...base, idempotency_key: key('a'), buy_now_price: '100', ends_at: commandInstant(new Date(Date.now() + 86_400_000)) })).status).toBe(400);
    expect((await command(setup.seller, { ...base, idempotency_key: key('a'), starts_at: commandInstant(new Date(Date.now() - 3_600_000)), ends_at: commandInstant(new Date(Date.now() + 86_400_000)) })).status).toBe(400);
  });

  it('AUC-02/04/09: first bid at the start price, concurrent equal bids serialize, seller and suspended users are denied', async () => {
    const { seller, auctionId } = await auction('auc02', { buyNow: '150' });
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((label) => createUser(`auc02-${label}`)));
    expect((await bid(a!, auctionId, '99')).status).toBe(422);
    expect((await bid(seller, auctionId, '500')).status).toBe(403);
    await sql`update app.users set status='SUSPENDED' where id=${c!.id}`;
    expect((await bid(c!, auctionId, '500')).status).toBe(403);
    expect((await bid(a!, auctionId, '100')).status).toBe(200);

    const racing = await Promise.all([bid(b!, auctionId, '110'), bid(a!, auctionId, '110')]);
    expect(racing.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(String(racing.find((r) => r.status === 422)!.body.error)).toMatch(/at least \$120\.00/);
    expect((await sql`select sequence,amount_minor from app.bids where auction_id=${auctionId} order by sequence`).map((r) => [Number(r.sequence), r.amount_minor]))
      .toEqual([[1, '10000'], [2, '11000']]);
    // AUC-09: once bidding started, a bid above the old Buy Now price follows the normal minimum.
    expect((await bid(b!, auctionId, '200')).status).toBe(200);
    expect((await buyNow(a!, auctionId)).status).toBe(409);
    expect(await auctionRow(auctionId)).toMatchObject({ current_price_minor: '20000', bid_count: 3 });
    await expect(sql`update app.bids set amount_minor=1 where auction_id=${auctionId}`).rejects.toThrow(/immutable/);
    await expect(sql`update app.auctions set ends_at=ends_at + interval '1 day' where id=${auctionId}`).rejects.toThrow(/frozen/);
  });

  it('AUC-03: bids and Buy Now follow database time, before the start and after the end even without a close job', async () => {
    const early = await auction('auc03-early', { startsInMs: 10 * 60_000, buyNow: '300' });
    const bidder = await createUser('auc03-bidder');
    expect((await auctionRow(early.auctionId)).status).toBe('SCHEDULED');
    expect((await bid(bidder, early.auctionId, '100')).status).toBe(422);
    expect((await buyNow(bidder, early.auctionId)).status).toBe(422);

    const ending = await auction('auc03-end', { endsInMs: 2_000 });
    expect((await bid(bidder, ending.auctionId, '100')).status).toBe(200);
    await sleepUntil(ending.endsAt);
    expect((await auctionRow(ending.auctionId)).status).toBe('LIVE');
    const late = await bid(bidder, ending.auctionId, '500');
    expect(late.status).toBe(422);
    expect(String(late.body.error)).toMatch(/ended/);
    expect((await auctionRow(ending.auctionId)).bid_count).toBe(1);
  }, 15_000);
});

describe.skipIf(!RUN_DB)('AUC-05/06/10/14 — close, winner payment and default', () => {
  it('AUC-05: a no-bid auction closes once and releases its claim once', async () => {
    const { auctionId, poolId } = await auction('auc05');
    await sql`update app.auctions set ends_at=now() - interval '1 second' where id=${auctionId}`;
    const reports = await Promise.all([jobs.closeDueAuctions({ auctionId }), jobs.closeDueAuctions({ auctionId })]);
    const outcomes = reports.flatMap((r) => Object.entries(r.outcomes));
    expect(outcomes.filter(([name]) => name === 'NO_BIDS').reduce((n, [, count]) => n + count, 0)).toBe(1);
    expect(await auctionRow(auctionId)).toMatchObject({ status: 'NO_BIDS' });
    expect((await sql`select state from app.reservations where pool_id=${poolId}`).map((r) => r.state)).toEqual(['RELEASED']);
    expect((await poolCounters(poolId)).reserved_units).toBe(0);
    expect((await jobs.closeDueAuctions({ auctionId })).examined).toBe(0);
  });

  it('AUC-06: duplicate closes pick one winner, one order and one 24-hour payment deadline; payment settles', async () => {
    const setup = await auction('auc06', { endsInMs: 2_500 });
    const [high, low] = await Promise.all([createUser('auc06-high'), createUser('auc06-low')]);
    expect((await bid(low, setup.auctionId, '100')).status).toBe(200);
    expect((await bid(high, setup.auctionId, '130')).status).toBe(200);
    await sleepUntil(setup.endsAt);
    const results = await Promise.all([
      jobs.closeDueAuctions({ auctionId: setup.auctionId }),
      jobs.closeDueAuctions({ auctionId: setup.auctionId }),
      command(setup.seller, { command: 'close_auction', idempotency_key: key('close'), auction_id: setup.auctionId }),
    ]);
    expect(results.length).toBe(3);
    const intents = await sql`select * from app.auction_purchase_intents where auction_id=${setup.auctionId}`;
    expect(intents.length).toBe(1);
    expect(intents[0]).toMatchObject({ kind: 'WINNER', buyer_id: high.id, amount_minor: '13000', status: 'ACTIVE' });
    const orders = await sql`select id,buyer_id,amount_minor,platform_fee_minor,status from app.orders where source='AUCTION' and source_ref=${setup.auctionId}`;
    expect(orders.length).toBe(1);
    expect(orders[0]).toMatchObject({ buyer_id: high.id, amount_minor: '13000', platform_fee_minor: '0', status: 'AWAITING_PAYMENT' });
    const row = await auctionRow(setup.auctionId);
    expect(row).toMatchObject({ status: 'AWAITING_WINNER_PAYMENT', winner_id: high.id, winning_bid_id: intents[0]!.bid_id });
    const dueIn = new Date(row.payment_due_at).getTime() - Date.now();
    expect(dueIn).toBeGreaterThan(23.9 * 3600_000);
    expect(dueIn).toBeLessThanOrEqual(24 * 3600_000);
    expect((await sql`select expires_at from app.reservations where order_id=${String(orders[0]!.id)}`)[0]!.expires_at).toEqual(row.payment_due_at);

    expect((await getAuctionData(asActor(high), setup.auctionId))!.viewer).toMatchObject({ standing: 'WON_PAY', order_id: String(orders[0]!.id) });
    expect((await getAuctionData(asActor(low), setup.auctionId))!.viewer).toMatchObject({ standing: 'LOST' });
    expect((await pay(high, String(orders[0]!.id))).status).toBe(200);
    expect(await auctionRow(setup.auctionId)).toMatchObject({ status: 'SETTLED' });
    expect((await sql`select status from app.auction_purchase_intents where auction_id=${setup.auctionId}`)[0]!.status).toBe('FUNDED');
    expect((await getMyBids(asActor(high))).find((b) => b.id === setup.auctionId)).toMatchObject({ standing: 'WON' });
  }, 20_000);

  it('AUC-10/14: an unpaid winner defaults without charging the runner-up; late funds open a case and never reclaim the slot', async () => {
    const setup = await auction('auc10', { endsInMs: 2_500 });
    const [winner, runnerUp] = await Promise.all([createUser('auc10-winner'), createUser('auc10-runner')]);
    await bid(runnerUp, setup.auctionId, '100');
    await bid(winner, setup.auctionId, '120');
    await sleepUntil(setup.endsAt);
    await jobs.closeDueAuctions({ auctionId: setup.auctionId });
    const [order] = await sql`select id from app.orders where source='AUCTION' and source_ref=${setup.auctionId}`;
    const orderId = String(order!.id);
    const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, winner.id, orderId));
    if (intent.state !== 'READY') throw new Error('intent not ready');

    await sql`update app.reservations set expires_at=now() - interval '1 minute' where order_id=${orderId}`;
    expect((await jobs.expireCheckoutHolds({ orderId })).outcomes).toEqual({ RELEASED: 1 });
    expect((await provider.getFundingStatus(intent.reference)).status).toBe('CANCELED');
    expect(await auctionRow(setup.auctionId)).toMatchObject({ status: 'WINNER_DEFAULTED' });
    expect((await sql`select status from app.auction_purchase_intents where auction_id=${setup.auctionId}`).map((r) => r.status)).toEqual(['DEFAULTED']);
    expect((await sql`select count(*)::int as n from app.orders where source='AUCTION' and source_ref=${setup.auctionId}`)[0]!.n).toBe(1);
    expect((await poolCounters(setup.poolId)).reserved_units).toBe(0);

    const body = new TextEncoder().encode(JSON.stringify({ id: `evt_late_${key('e')}`, type: 'funding.succeeded', mode: 'test', account: 'acct_mock_local', created: new Date().toISOString(),
      data: { objectType: 'funding', reference: intent.reference, fundingReference: intent.reference, operationId: intent.operationId, orderId, status: 'SUCCEEDED', amount: '12000', currency: 'USD', providerFee: '0' } }));
    const headers = new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, SECRET, Math.floor(Date.now() / 1000)) });
    expect((await webhook.POST(new Request(`${ORIGIN}/api/webhooks/mock-payment`, { method: 'POST', headers, body }))).status).toBe(200);
    expect((await sql`select status from app.orders where id=${orderId}`)[0]!.status).toBe('CANCELLED');
    expect(await auctionRow(setup.auctionId)).toMatchObject({ status: 'WINNER_DEFAULTED' });
    expect((await sql`select count(*)::int as n from app.reconciliation_cases where order_id=${orderId} and kind='LATE_FUNDING'`)[0]!.n).toBe(1);
    expect((await poolCounters(setup.poolId)).reserved_units).toBe(0);
  }, 20_000);
});

describe.skipIf(!RUN_DB)('AUC-07/08/11/12/13 — Buy Now, invalidation, cancel and live snapshot', () => {
  it('AUC-07: a racing first bid and Buy Now produce exactly one sale path', async () => {
    const { auctionId } = await auction('auc07', { buyNow: '300' });
    const [bidder, buyer] = await Promise.all([createUser('auc07-bidder'), createUser('auc07-buyer')]);
    const [bidResult, buyResult] = await Promise.all([bid(bidder, auctionId, '100'), buyNow(buyer, auctionId)]);
    expect([bidResult.status, buyResult.status].filter((s) => s === 200)).toHaveLength(1);
    const orders = (await sql`select count(*)::int as n from app.orders where source='AUCTION' and source_ref=${auctionId}`)[0]!.n;
    if (buyResult.status === 200) {
      expect(bidResult.status).toBe(422);
      expect(orders).toBe(1);
      expect(await auctionRow(auctionId)).toMatchObject({ status: 'AWAITING_WINNER_PAYMENT', bid_count: 0 });
    } else {
      expect(buyResult.status).toBe(409);
      expect(orders).toBe(0);
      expect(await auctionRow(auctionId)).toMatchObject({ status: 'LIVE', bid_count: 1 });
    }
  });

  it('AUC-08: an invalidated first bid keeps Buy Now disabled and keeps the history row', async () => {
    const { auctionId } = await auction('auc08', { buyNow: '300' });
    const moderator = await operator('moderator');
    const [bidder, buyer] = await Promise.all([createUser('auc08-bidder'), createUser('auc08-buyer')]);
    const placed = await bid(bidder, auctionId, '100');
    const firstBidAt = (await auctionRow(auctionId)).first_valid_bid_at;
    expect((await command(bidder, { command: 'admin_invalidate_bid', idempotency_key: key('i'), bid_id: String(placed.body.id), reason })).status).toBe(403);
    expect((await command(moderator, { command: 'admin_invalidate_bid', idempotency_key: key('i'), bid_id: String(placed.body.id), reason })).status).toBe(200);
    expect(await auctionRow(auctionId)).toMatchObject({ current_bid_id: null, current_price_minor: null, bid_count: 0, first_valid_bid_at: firstBidAt });
    expect((await sql`select status,invalidated_by from app.bids where id=${String(placed.body.id)}`)[0]).toMatchObject({ status: 'INVALIDATED', invalidated_by: moderator.id });
    expect((await sql`select action from app.audit_log where entity_id=${String(placed.body.id)}`).map((r) => r.action)).toEqual(['bid.invalidate']);
    const data = await getAuctionData(null, auctionId);
    expect(data!.bids).toEqual([]);
    expect(data!.auction).toMatchObject({ buy_now_available: false, next_minimum_minor: '10000' });
    expect((await buyNow(buyer, auctionId)).status).toBe(409);
    expect((await bid(buyer, auctionId, '100')).status).toBe(200);
    await expect(sql`update app.auctions set first_valid_bid_at=null where id=${auctionId}`).rejects.toThrow(/write-once/);
  });

  it('AUC-11: an expired Buy Now checkout ends the auction; it never silently reopens', async () => {
    const { auctionId, poolId } = await auction('auc11', { buyNow: '300' });
    const [buyer, bidder] = await Promise.all([createUser('auc11-buyer'), createUser('auc11-bidder')]);
    const bought = await buyNow(buyer, auctionId);
    expect(bought.status).toBe(200);
    const orderId = String(bought.body.id);
    const hold = (await sql`select expires_at from app.reservations where order_id=${orderId}`)[0]!.expires_at;
    expect(new Date(hold).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    await sql`update app.reservations set expires_at=now() - interval '1 minute' where order_id=${orderId}`;
    await jobs.expireCheckoutHolds({ orderId });
    expect(await auctionRow(auctionId)).toMatchObject({ status: 'WINNER_DEFAULTED' });
    expect((await sql`select kind,status from app.auction_purchase_intents where auction_id=${auctionId}`)[0]).toMatchObject({ kind: 'BUY_NOW', status: 'EXPIRED' });
    expect((await bid(bidder, auctionId, '100')).status).toBe(422);
    expect((await buyNow(bidder, auctionId)).status).toBe(422);
    expect((await poolCounters(poolId)).reserved_units).toBe(0);
    await expect(sql`update app.auctions set status='LIVE' where id=${auctionId}`).rejects.toThrow(/cannot move/);
  });

  it('AUC-12: cancel and a first bid race to one valid outcome', async () => {
    for (let round = 0; round < 3; round++) {
      const { seller, auctionId } = await auction(`auc12-${round}`);
      const bidder = await createUser(`auc12-bidder-${round}`);
      const [cancel, placed] = await Promise.all([
        command(seller, { command: 'cancel_auction', idempotency_key: key('c'), auction_id: auctionId }),
        bid(bidder, auctionId, '100'),
      ]);
      expect([cancel.status, placed.status].filter((s) => s === 200)).toHaveLength(1);
      const row = await auctionRow(auctionId);
      if (cancel.status === 200) expect(row).toMatchObject({ status: 'CANCELLED', bid_count: 0 });
      else expect(row).toMatchObject({ status: 'LIVE', bid_count: 1 });
      if (cancel.status !== 200) expect(cancel.status).toBe(409);
    }
  });

  it('AUC-13: the snapshot carries server time, version and the viewer standing', async () => {
    const { auctionId } = await auction('auc13');
    const [a, b] = await Promise.all([createUser('auc13-a'), createUser('auc13-b')]);
    const first = await getAuctionData(asActor(a), auctionId);
    expect(first!.auction).toMatchObject({ accepting_bids: true, next_minimum_minor: '10000' });
    expect(first!.auction.server_now).toBeTruthy();
    expect(first!.viewer).toMatchObject({ standing: 'NONE' });
    await bid(a, auctionId, '100');
    await bid(b, auctionId, '110');
    const afterA = await getAuctionData(asActor(a), auctionId);
    expect(Number(afterA!.auction.version)).toBeGreaterThan(Number(first!.auction.version));
    expect(afterA!.viewer).toMatchObject({ standing: 'OUTBID', my_highest_minor: '10000' });
    expect((await getAuctionData(asActor(b), auctionId))!.viewer).toMatchObject({ standing: 'WINNING' });
    expect(afterA!.bids.map((x) => x.display_name)).not.toContain(a.id);
    sessionState.token = b.token;
    const polled = await snapshotRoute.GET(new Request(`${ORIGIN}/api/auctions/${auctionId}/snapshot`), { params: Promise.resolve({ id: auctionId }) });
    expect(polled.status).toBe(200);
    expect(((await polled.json()) as { viewer: { standing: string } }).viewer.standing).toBe('WINNING');
    const missing = await snapshotRoute.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ id: randomUUID() }) });
    expect(missing.status).toBe(404);
  });
});
