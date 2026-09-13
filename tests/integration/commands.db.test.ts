import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  RUN_DB,
  callRoute,
  commandInstant,
  createPublishedService,
  createUser,
  key,
  sessionState,
  type TestUser,
} from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const { POST } = await import('@/app/api/commands/route');
const { sql } = await import('@/lib/db');
const { getPublicData, getOrderData, getRequestData, getAuctionData } = await import('@/lib/read-model');

const command = (actor: TestUser | null, fields: Record<string, string>, options?: { origin?: string }) =>
  callRoute(POST, '/api/commands', actor, fields, options);

const brief = 'Integration brief: launch narrative, landing page, three headline options.';

async function book(buyer: TestUser, serviceId: string, idempotencyKey = key('book'), text = brief) {
  return command(buyer, { command: 'book', idempotency_key: idempotencyKey, service_id: serviceId, brief: text });
}

afterAll(async () => {
  if (RUN_DB) await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('TEST_PLAN 1 — authorization and isolation', () => {
  it('rejects anonymous and cross-origin mutations', async () => {
    expect((await command(null, { command: 'message', idempotency_key: key('anon') })).status).toBe(401);
    const user = await createUser('origin');
    const crossOrigin = await command(user, { command: 'message', idempotency_key: key('xorigin') }, { origin: 'https://attacker.test' });
    expect(crossOrigin.status).toBe(403);
  });

  it('keeps orders, services and pools scoped to their owners', async () => {
    const creator = await createUser('authz-creator');
    const otherCreator = await createUser('authz-creator2');
    const buyer = await createUser('authz-buyer');
    const otherBuyer = await createUser('authz-buyer2');
    const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: 2 });
    const booked = await book(buyer, serviceId);
    expect(booked.status).toBe(200);
    const orderId = String(booked.body.id);

    const foreignMessage = await command(otherBuyer, { command: 'message', idempotency_key: key('m'), order_id: orderId, body: 'hello' });
    expect(foreignMessage.status).toBe(403);
    expect(await getOrderData({ id: otherBuyer.id, email: otherBuyer.email, display_name: 'x', roles: ['buyer'], is_test: true }, orderId)).toBeNull();
    expect(await getOrderData({ id: buyer.id, email: buyer.email, display_name: 'x', roles: ['buyer'], is_test: true }, orderId)).not.toBeNull();

    expect((await command(otherCreator, { command: 'pause_service', idempotency_key: key('p'), service_id: serviceId })).status).toBe(403);
    expect((await command(otherCreator, { command: 'set_capacity', idempotency_key: key('c'), pool_id: poolId, total_units: '99' })).status).toBe(403);
    expect((await command(creator, { command: 'book', idempotency_key: key('self'), service_id: serviceId, brief })).status).toBe(400);
  });

  it('anonymous catalogue exposes only published services and approved public samples', async () => {
    const creator = await createUser('catalog');
    const draft = await command(creator, {
      command: 'create_service',
      idempotency_key: key('draft'),
      title: 'Draft only service',
      description: 'This draft must never appear in the public catalogue.',
      taxonomy: 'CREATE',
      price: '10',
      capacity: '1',
      turnaround_hours: '24',
      sample_url_1: 'https://example.com/a',
      sample_title_1: 'a',
      sample_url_2: 'https://example.com/b',
      sample_title_2: 'b',
      sample_url_3: 'https://example.com/c',
      sample_title_3: 'c',
    });
    expect(draft.status).toBe(200);
    await command(creator, { command: 'add_sample', idempotency_key: key('private'), title: 'Private sample', url: 'https://example.com/private', visibility: 'PRIVATE' });

    const data = await getPublicData();
    const ids = data.services.map((s) => String(s.id));
    expect(ids).not.toContain(String(draft.body.id));
    for (const service of data.services) {
      expect(service.status).toBe('PUBLISHED');
      for (const sample of service.samples as Record<string, unknown>[]) {
        expect(sample.visibility).toBe('PUBLIC');
        expect(sample.moderation_status).toBe('APPROVED');
      }
    }
  });
});

describe.skipIf(!RUN_DB)('TEST_PLAN 2 — capacity race', () => {
  it('eight concurrent buyers contend for one unit: exactly one reservation commits', async () => {
    const creator = await createUser('race-creator');
    const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: 1 });
    const buyers = await Promise.all(Array.from({ length: 8 }, (_, i) => createUser(`race-buyer-${i}`)));

    const results = await Promise.all(buyers.map((buyer) => book(buyer, serviceId)));
    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    for (const loser of losers) expect(String(loser.body.error)).toMatch(/no available capacity/);

    const [pool] = await sql`select total_units,reserved_units,committed_units from app.capacity_pools where id=${poolId}`;
    expect(pool).toMatchObject({ total_units: 1, reserved_units: 1, committed_units: 0 });
    const [{ count }] = await sql`select count(*)::int as count from app.reservations where pool_id=${poolId}`;
    expect(count).toBe(1);
  });

  it('capacity cannot be lowered below held units', async () => {
    const creator = await createUser('cap-creator');
    const buyer = await createUser('cap-buyer');
    const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: 2 });
    expect((await book(buyer, serviceId)).status).toBe(200);
    const lowered = await command(creator, { command: 'set_capacity', idempotency_key: key('lower'), pool_id: poolId, total_units: '0' });
    expect(lowered.status).toBe(400);
    expect((await command(creator, { command: 'set_capacity', idempotency_key: key('ok'), pool_id: poolId, total_units: '1' })).status).toBe(200);
  });
});

describe.skipIf(!RUN_DB)('TEST_PLAN 3 — command idempotency', () => {
  it('replays the original result for the same key and body, and rejects a different body', async () => {
    const creator = await createUser('idem-creator');
    const buyer = await createUser('idem-buyer');
    const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: 5 });
    const idempotencyKey = key('same');

    const first = await book(buyer, serviceId, idempotencyKey);
    const replay = await book(buyer, serviceId, idempotencyKey);
    expect(first.status).toBe(200);
    expect(replay).toEqual(first);

    const conflict = await book(buyer, serviceId, idempotencyKey, `${brief} Different body.`);
    expect(conflict.status).toBe(409); // master §13.1: idempotency conflict is 409
    expect(String(conflict.body.error)).toMatch(/idempotency key/i);

    const [{ count }] = await sql`select count(*)::int as count from app.orders where buyer_id=${buyer.id}`;
    expect(count).toBe(1);
    const [pool] = await sql`select reserved_units from app.capacity_pools where id=${poolId}`;
    expect(pool!.reserved_units).toBe(1);
  });

  it('concurrent duplicate submits with one key apply once and all return the same result', async () => {
    const creator = await createUser('idem-conc-creator');
    const buyer = await createUser('idem-conc-buyer');
    const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: 5 });
    const idempotencyKey = key('concurrent');

    const results = await Promise.all(Array.from({ length: 6 }, () => book(buyer, serviceId, idempotencyKey)));
    const [{ count }] = await sql`select count(*)::int as count from app.orders where buyer_id=${buyer.id}`;
    expect(count).toBe(1);
    const [pool] = await sql`select reserved_units from app.capacity_pools where id=${poolId}`;
    expect(pool!.reserved_units).toBe(1);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => String(r.body.id))).size).toBe(1);
  });
});

describe.skipIf(!RUN_DB)('TEST_PLAN 6 — requests and applications', () => {
  it('selection and acceptance stay scoped; unselected applications remain historical', async () => {
    const buyer = await createUser('req-buyer');
    const otherBuyer = await createUser('req-buyer2');
    const creatorA = await createUser('req-creator-a');
    const creatorB = await createUser('req-creator-b');
    await createPublishedService(command, creatorA, { capacity: 2 });
    await createPublishedService(command, creatorB, { capacity: 2 });

    const created = await command(buyer, {
      command: 'create_request',
      idempotency_key: key('req'),
      title: 'Launch thread for our beta',
      brief: 'We need a launch thread and two follow-up posts for our public beta.',
      taxonomy: 'CREATE',
      budget: '500',
      per_creator_cap: '300',
      target_hires: '1',
      deadline: commandInstant(new Date(Date.now() + 7 * 24 * 3600 * 1000)),
    });
    expect(created.status).toBe(200);
    const requestId = String(created.body.id);

    const apply = (creator: TestUser, quote: string) =>
      command(creator, { command: 'apply', idempotency_key: key('apply'), request_id: requestId, quote, turnaround_hours: '48', note: 'I have shipped launch threads for three developer tools.' });
    expect((await apply(creatorA, '301')).status).toBe(400); // over per-creator cap
    expect((await apply(creatorA, '250')).status).toBe(200);
    expect((await apply(creatorB, '280')).status).toBe(200);
    expect((await command(buyer, { command: 'apply', idempotency_key: key('self-apply'), request_id: requestId, quote: '10', turnaround_hours: '1', note: 'Buyer applying to own request.' })).status).toBe(400);

    const [appA] = await sql`select id from app.applications where request_id=${requestId} and creator_id=${creatorA.id}`;
    const [appB] = await sql`select id from app.applications where request_id=${requestId} and creator_id=${creatorB.id}`;

    expect((await command(otherBuyer, { command: 'select_application', idempotency_key: key('sel'), application_id: String(appA!.id) })).status).toBe(403);
    expect((await command(buyer, { command: 'select_application', idempotency_key: key('sel'), application_id: String(appA!.id) })).status).toBe(200);

    expect((await command(creatorB, { command: 'accept_offer', idempotency_key: key('acc'), application_id: String(appA!.id) })).status).toBe(403);
    expect((await command(creatorB, { command: 'accept_offer', idempotency_key: key('acc'), application_id: String(appB!.id) })).status).toBe(400);

    const accepted = await command(creatorA, { command: 'accept_offer', idempotency_key: key('acc'), application_id: String(appA!.id) });
    expect(accepted.status).toBe(200);
    const [order] = await sql`select source,amount_minor,platform_fee_minor,buyer_id,creator_id,status from app.orders where id=${String(accepted.body.id)}`;
    expect(order).toMatchObject({ source: 'REQUEST', amount_minor: '25000', platform_fee_minor: '0', buyer_id: buyer.id, creator_id: creatorA.id, status: 'AWAITING_PAYMENT' });

    // Anonymous visitors can open the public request page without seeing applications.
    const anonymousView = await getRequestData(null, requestId);
    expect(anonymousView?.request.id).toBe(requestId);
    expect(anonymousView?.applications).toEqual([]);

    const statuses = await sql`select creator_id,status from app.applications where request_id=${requestId}`;
    expect(Object.fromEntries(statuses.map((s) => [s.creator_id, s.status]))).toEqual({ [creatorA.id]: 'ACCEPTED', [creatorB.id]: 'SUBMITTED' });
    const [request] = await sql`select status from app.requests where id=${requestId}`;
    expect(request!.status).toBe('FILLED');
  });
});

describe.skipIf(!RUN_DB)('TEST_PLAN 7 — auctions', () => {
  it('server time, monotonic bids, buy-now gating, and single close', async () => {
    const seller = await createUser('auc-seller');
    const bidder1 = await createUser('auc-bidder1');
    const bidder2 = await createUser('auc-bidder2');
    const bidder3 = await createUser('auc-bidder3');
    const { serviceId, poolId } = await createPublishedService(command, seller, { capacity: 1 });

    const endsAt = new Date(Date.now() + 4000);
    const created = await command(seller, {
      command: 'create_auction',
      idempotency_key: key('auc'),
      service_id: serviceId,
      starting_price: '100',
      minimum_increment: '10',
      buy_now_price: '500',
      starts_at: commandInstant(new Date(Date.now() - 60_000)),
      ends_at: commandInstant(endsAt),
    });
    expect(created.status).toBe(200);
    const auctionId = String(created.body.id);
    const [pool] = await sql`select reserved_units from app.capacity_pools where id=${poolId}`;
    expect(pool!.reserved_units).toBe(1);

    expect((await getAuctionData(null, auctionId))?.auction.id).toBe(auctionId);

    const bid = (actor: TestUser, amount: string) => command(actor, { command: 'bid', idempotency_key: key('bid'), auction_id: auctionId, amount });
    expect((await bid(seller, '200')).status).toBe(400);
    expect((await bid(bidder1, '105')).status).toBe(400);
    expect((await bid(bidder1, '110')).status).toBe(200);

    const buyNow = await command(bidder3, { command: 'buy_now', idempotency_key: key('bn'), auction_id: auctionId });
    expect(buyNow.status).toBe(400);

    const concurrent = await Promise.all([bid(bidder2, '120'), bid(bidder3, '120')]);
    expect(concurrent.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await bid(bidder1, '125')).status).toBe(400);

    const early = await command(seller, { command: 'close_auction', idempotency_key: key('close'), auction_id: auctionId });
    expect(early.status).toBe(400);
    expect((await command(bidder1, { command: 'retract_bid', idempotency_key: key('retract'), auction_id: auctionId })).status).toBe(400);

    await new Promise((resolve) => setTimeout(resolve, Math.max(0, endsAt.getTime() - Date.now()) + 1100));
    expect((await bid(bidder1, '200')).status).toBe(400);
    const closed = await command(seller, { command: 'close_auction', idempotency_key: key('close'), auction_id: auctionId });
    expect(closed.status).toBe(200);
    const [order] = await sql`select buyer_id,amount_minor,platform_fee_minor,source from app.orders where id=${String(closed.body.id)}`;
    const [winningBid] = await sql`select bidder_id from app.bids where auction_id=${auctionId} and amount_minor=12000`;
    expect(order).toMatchObject({ buyer_id: winningBid!.bidder_id, amount_minor: '12000', platform_fee_minor: '0', source: 'AUCTION' });
    expect((await command(seller, { command: 'close_auction', idempotency_key: key('close2'), auction_id: auctionId })).status).toBe(400);
    const [{ count }] = await sql`select count(*)::int as count from app.bids where auction_id=${auctionId}`;
    expect(count).toBe(2);
  }, 20_000);
});
