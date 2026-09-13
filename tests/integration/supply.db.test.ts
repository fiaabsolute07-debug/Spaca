import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, poolCounters, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const funding = await import('@/modules/payments/funding');
const readModel = await import('@/lib/read-model');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const brief = 'Supply integration brief with audience, goal and three headline options.';
const serviceFields = (overrides: Record<string, string> = {}) => ({
  command: 'create_service',
  idempotency_key: key('svc'),
  title: 'Supply engine service',
  description: 'A complete scope used by the supply engine acceptance suite.',
  taxonomy: 'CREATE',
  price: '400',
  capacity: '1',
  turnaround_hours: '48',
  ...overrides,
});
const withSamples = (fields: Record<string, string>) => ({
  ...fields,
  sample_url_1: 'https://example.com/s1', sample_title_1: 'Sample one',
  sample_url_2: 'https://example.com/s2', sample_title_2: 'Sample two',
  sample_url_3: 'https://example.com/s3', sample_title_3: 'Sample three',
});
const actorOf = (user: TestUser) => ({ id: user.id, email: user.email, display_name: 'x', roles: ['buyer', 'creator'], is_test: true, status: 'ACTIVE' as const, timezone: 'UTC' });

beforeEach(() => {
  if (RUN_DB) funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_supply_suite_secret_01'] }));
});
afterAll(async () => {
  if (RUN_DB) {
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('SUP — listing supply', () => {
  it('SUP-01: publishing needs three approved public samples and one linked sample; the draft is kept', async () => {
    const creator = await createUser('sup01');
    const created = await command(creator, serviceFields());
    expect(created.status).toBe(200);
    const serviceId = String(created.body.id);
    const refused = await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toMatch(/at least 3 approved public work samples/);
    expect(String(refused.body.error)).toMatch(/Link at least one approved sample/);
    const [draft] = await sql`select status,published_version_id from app.services where id=${serviceId}`;
    expect(draft).toMatchObject({ status: 'DRAFT', published_version_id: null });

    for (const n of [1, 2, 3]) {
      const added = await command(creator, { command: 'add_sample', idempotency_key: key('sample'), title: `Portfolio ${n}`, url: `https://example.com/p${n}`, service_id: serviceId });
      expect(added.status).toBe(200);
    }
    // Samples added later start PENDING and do not count until approved.
    expect((await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId })).status).toBe(400);
    await sql`update app.samples set moderation_status='APPROVED' where creator_id=${creator.id}`;
    expect((await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId })).status).toBe(200);
    const [published] = await sql`select s.status,v.version,v.price_minor from app.services s join app.service_versions v on v.id=s.published_version_id where s.id=${serviceId}`;
    expect(published).toMatchObject({ status: 'PUBLISHED', version: 1, price_minor: '40000' });
    const buckets = await sql`select count(*)::int as n from app.capacity_buckets b join app.services s on s.pool_id=b.pool_id where s.id=${serviceId}`;
    expect(buckets[0]!.n).toBeGreaterThanOrEqual(8);
  });

  it('SUP-02: a new creator shows no fabricated reputation', async () => {
    const creator = await createUser('sup02');
    const handle = `new-${creator.id.slice(0, 8)}`;
    expect((await command(creator, { command: 'update_profile', idempotency_key: key('p'), display_name: 'New Creator', handle, bio: 'Just getting started.' })).status).toBe(200);
    const data = await readModel.getCreatorData(handle);
    expect(data?.creator).toMatchObject({ completed_jobs: '0', rating: null, services_count: '0' });
  });

  it('SUP-03: an edit after a sale creates V2; the order keeps V1 and a stale checkout is refused until reviewed', async () => {
    const creator = await createUser('sup03-creator');
    const buyer = await createUser('sup03-buyer');
    const buyer2 = await createUser('sup03-buyer2');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 3, price: '500' });
    const [v1] = await sql`select s.version,s.published_version_id from app.services s where s.id=${serviceId}`;
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, service_version_id: String(v1!.published_version_id), accept_terms: 'on' });
    expect(booked.status).toBe(200);
    const orderId = String(booked.body.id);

    expect((await command(creator, { command: 'update_service', idempotency_key: key('upd'), service_id: serviceId, title: 'Updated scope', description: 'A larger scope with two extra deliverables included.', price: '750', turnaround_hours: '96' })).status).toBe(400);
    const stale = await command(creator, { command: 'update_service', idempotency_key: key('upd'), service_id: serviceId, expected_version: String(Number(v1!.version) + 5), title: 'Updated scope', description: 'A larger scope with two extra deliverables included.', price: '750', turnaround_hours: '96' });
    expect(stale.status).toBe(409);
    const updated = await command(creator, { command: 'update_service', idempotency_key: key('upd'), service_id: serviceId, expected_version: String(v1!.version), title: 'Updated scope', description: 'A larger scope with two extra deliverables included.', price: '750', turnaround_hours: '96' });
    expect(updated.status).toBe(200);

    const [order] = await sql`select amount_minor,title,terms,service_version_id from app.orders where id=${orderId}`;
    expect(order).toMatchObject({ amount_minor: '50000', title: `IT service ${String(order!.title).split('IT service ')[1]}`, service_version_id: v1!.published_version_id });
    expect(order!.terms).toMatchObject({ schema_version: 1, source: 'BOOK', price_minor: '50000', turnaround_hours: 72, revision_limit: 1, auto_accept_consent: true, platform_fee_bps: 0 });
    await expect(sql`update app.orders set amount_minor=1 where id=${orderId}`).rejects.toThrow(/sold terms are immutable/);
    await expect(sql`update app.service_versions set price_minor=1 where id=${String(v1!.published_version_id)}`).rejects.toThrow(/immutable/);

    const staleCheckout = await command(buyer2, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, service_version_id: String(v1!.published_version_id) });
    expect(staleCheckout.status).toBe(409);
    expect(String(staleCheckout.body.error)).toMatch(/Review the new price/);
    const [v2] = await sql`select v.id,v.version,v.price_minor from app.services s join app.service_versions v on v.id=s.published_version_id where s.id=${serviceId}`;
    expect(v2).toMatchObject({ version: 2, price_minor: '75000' });
    const fresh = await command(buyer2, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, service_version_id: String(v2!.id) });
    expect(fresh.status).toBe(200);
    const [freshOrder] = await sql`select amount_minor,terms->>'turnaround_hours' as turnaround from app.orders where id=${String(fresh.body.id)}`;
    expect(freshOrder).toMatchObject({ amount_minor: '75000', turnaround: '96' });
    const publicView = await readModel.getServiceData(serviceId);
    expect(publicView?.service).toMatchObject({ price_minor: '75000', service_version: 2, title: 'Updated scope' });
  });

  it('SUP-04: pause/archive stop new sales but funded orders keep working', async () => {
    const creator = await createUser('sup04-creator');
    const buyer = await createUser('sup04-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 3 });
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief });
    const orderId = String(booked.body.id);
    expect((await pay(buyer, orderId)).status).toBe(200);

    expect((await command(creator, { command: 'pause_service', idempotency_key: key('pause'), service_id: serviceId })).status).toBe(200);
    expect((await command(await createUser('sup04-late'), { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief })).status).toBe(404);
    expect((await readModel.getServiceData(serviceId))).toBeNull();
    expect((await command(creator, { command: 'start', idempotency_key: key('start'), order_id: orderId })).status).toBe(200);
    expect((await command(creator, { command: 'archive_service', idempotency_key: key('archive'), service_id: serviceId })).status).toBe(200);
    expect((await command(creator, { command: 'deliver', idempotency_key: key('deliver'), order_id: orderId, body: 'Delivered after archive.' })).status).toBe(200);
    expect((await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId })).status).toBe(422);
    const [order] = await sql`select status from app.orders where id=${orderId}`;
    expect(order!.status).toBe('DELIVERED');
  });

  it('public creator pages never expose drafts or paused services', async () => {
    const creator = await createUser('leak');
    const handle = `leak-${creator.id.slice(0, 8)}`;
    await command(creator, { command: 'update_profile', idempotency_key: key('p'), display_name: 'Leak Test', handle, bio: 'Profile for the draft leak test.' });
    const draft = await command(creator, withSamples(serviceFields({ title: 'Secret draft service' })));
    const { serviceId } = await createPublishedService(command, creator, { capacity: 1 });
    const data = await readModel.getCreatorData(handle);
    const ids = (data?.services ?? []).map((s) => String(s.id));
    expect(ids).toContain(serviceId);
    expect(ids).not.toContain(String(draft.body.id));
    expect((await readModel.getDashboardData(actorOf(creator))).services.map((s) => String(s.id))).toContain(String(draft.body.id));
  });
});

describe.skipIf(!RUN_DB)('CAP — capacity engine', () => {
  it('CAP-02: two services sharing a one-unit pool produce one claim under concurrency', async () => {
    const creator = await createUser('cap02');
    const first = await createPublishedService(command, creator, { capacity: 1 });
    const second = await command(creator, withSamples(serviceFields({ title: 'Second service on shared pool', pool_id: first.poolId })));
    expect(second.status).toBe(200);
    expect((await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: String(second.body.id) })).status).toBe(200);
    const [week] = await sql`select id from app.capacity_buckets where pool_id=${first.poolId} and ends_at - interval '72 hours' >= now() order by starts_at limit 1`;
    const buyers = await Promise.all(Array.from({ length: 10 }, (_, i) => createUser(`cap02-buyer-${i}`)));
    const results = await Promise.all(buyers.map((buyer, i) => command(buyer, {
      command: 'book', idempotency_key: key('book'), service_id: i % 2 ? first.serviceId : String(second.body.id), brief, bucket_id: String(week!.id),
    })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const [bucket] = await sql`select reserved_units,total_units from app.capacity_buckets where id=${String(week!.id)}`;
    expect(bucket).toMatchObject({ reserved_units: 1, total_units: 1 });
  });

  it('CAP-06/CAP-12: consumed work stays counted and cannot be released back', async () => {
    const creator = await createUser('cap06-creator');
    const buyer = await createUser('cap06-buyer');
    const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: 1 });
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief });
    const orderId = String(booked.body.id);
    expect((await pay(buyer, orderId)).status).toBe(200);
    for (const [actor, fields] of [[creator, { command: 'start' }], [creator, { command: 'deliver', body: 'Done.' }], [buyer, { command: 'approve' }]] as const) {
      expect((await command(actor, { idempotency_key: key('step'), order_id: orderId, ...fields })).status).toBe(200);
    }
    const [reservation] = await sql`select id,state,bucket_id from app.reservations where order_id=${orderId}`;
    expect(reservation!.state).toBe('CONSUMED');
    expect(await poolCounters(poolId)).toMatchObject({ reserved_units: 0, committed_units: 1 });
    await expect(sql`update app.reservations set state='RELEASED' where id=${String(reservation!.id)}`).rejects.toThrow(/invalid reservation transition CONSUMED -> RELEASED/);
    const availability = await readModel.getServiceData(serviceId);
    const [bucket] = await sql`select starts_at from app.capacity_buckets where id=${String(reservation!.bucket_id)}`;
    expect(availability?.service.next_available_starts_at).not.toBe(new Date(bucket!.starts_at).toISOString());
  });

  it('CAP-07: lowering weekly capacity below committed units is rejected without changing anything', async () => {
    const creator = await createUser('cap07-creator');
    const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: 2 });
    const [week] = await sql`select id from app.capacity_buckets where pool_id=${poolId} and ends_at - interval '72 hours' >= now() order by starts_at limit 1`;
    for (const n of [1, 2]) {
      const buyer = await createUser(`cap07-buyer-${n}`);
      const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, bucket_id: String(week!.id) });
      expect(booked.status).toBe(200);
      expect((await pay(buyer, String(booked.body.id))).status).toBe(200);
    }
    const lowered = await command(creator, { command: 'set_capacity', idempotency_key: key('cap'), pool_id: poolId, weekly_units: '1' });
    expect(lowered.status).toBe(409);
    const [bucket] = await sql`select total_units,committed_units from app.capacity_buckets where id=${String(week!.id)}`;
    expect(bucket).toMatchObject({ total_units: 2, committed_units: 2 });
    const [pool] = await sql`select weekly_units from app.capacity_pools where id=${poolId}`;
    expect(pool!.weekly_units).toBe(2);
    await expect(sql`update app.capacity_buckets set total_units=1 where id=${String(week!.id)}`).rejects.toThrow(/capacity_buckets_no_oversell/);
    expect((await command(creator, { command: 'set_capacity', idempotency_key: key('cap'), pool_id: poolId, weekly_units: '3' })).status).toBe(200);
  });

  it('CAP-08: a timezone change keeps booked weeks and rebuilds only empty future weeks without overlap', async () => {
    const creator = await createUser('cap08-creator');
    const buyer = await createUser('cap08-buyer');
    const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: 1 });
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief });
    const [held] = await sql`select b.id,b.starts_at,b.ends_at,b.timezone from app.reservations r join app.capacity_buckets b on b.id=r.bucket_id where r.order_id=${String(booked.body.id)}`;
    expect(held!.timezone).toBe('UTC');

    expect((await command(creator, { command: 'set_pool_timezone', idempotency_key: key('tz'), pool_id: poolId, timezone: 'Mars/Base' })).status).toBe(400);
    expect((await command(creator, { command: 'set_pool_timezone', idempotency_key: key('tz'), pool_id: poolId, timezone: 'Asia/Ho_Chi_Minh' })).status).toBe(200);
    const [kept] = await sql`select starts_at,ends_at,timezone,reserved_units from app.capacity_buckets where id=${String(held!.id)}`;
    expect(kept).toMatchObject({ timezone: 'UTC', reserved_units: 1 });
    expect(new Date(kept!.starts_at).toISOString()).toBe(new Date(held!.starts_at).toISOString());
    const future = await sql`select starts_at,ends_at,timezone from app.capacity_buckets where pool_id=${poolId} and starts_at > ${held!.ends_at} order by starts_at`;
    expect(future.length).toBeGreaterThan(0);
    for (const b of future) expect(b.timezone).toBe('Asia/Ho_Chi_Minh');
    const all = await sql`select starts_at,ends_at from app.capacity_buckets where pool_id=${poolId} order by starts_at`;
    for (let i = 1; i < all.length; i++) expect(new Date(all[i]!.starts_at).getTime()).toBeGreaterThanOrEqual(new Date(all[i - 1]!.ends_at).getTime());
    await expect(sql`insert into app.capacity_buckets (pool_id,starts_at,ends_at,local_week_start,timezone,total_units)
      values (${poolId},${new Date(new Date(held!.starts_at).getTime() + 3600_000).toISOString()},${new Date(new Date(held!.ends_at).getTime() + 3600_000).toISOString()},'2026-01-05','UTC',1)`).rejects.toThrow(/capacity_buckets_no_overlap/);
  });

  it('CAP-09: Buy Now moves the auction claim to the order without reserving another unit', async () => {
    const seller = await createUser('cap09-seller');
    const buyer = await createUser('cap09-buyer');
    const { serviceId, poolId } = await createPublishedService(command, seller, { capacity: 2 });
    const created = await command(seller, {
      command: 'create_auction', idempotency_key: key('auc'), service_id: serviceId, starting_price: '100', minimum_increment: '10', buy_now_price: '300',
      starts_at: commandInstant(new Date(Date.now() - 60_000)), ends_at: commandInstant(new Date(Date.now() + 3_600_000)),
    });
    expect(created.status).toBe(200);
    const [claim] = await sql`select id,bucket_id from app.reservations where auction_id=${String(created.body.id)}`;
    expect(await poolCounters(poolId)).toMatchObject({ reserved_units: 1 });
    const bought = await command(buyer, { command: 'buy_now', idempotency_key: key('bn'), auction_id: String(created.body.id) });
    expect(bought.status).toBe(200);
    const [moved] = await sql`select id,bucket_id,order_id,auction_id,state from app.reservations where order_id=${String(bought.body.id)}`;
    expect(moved).toMatchObject({ id: claim!.id, bucket_id: claim!.bucket_id, auction_id: null, state: 'HELD' });
    expect(await poolCounters(poolId)).toMatchObject({ reserved_units: 1 });
    const [order] = await sql`select terms,service_version_id from app.orders where id=${String(bought.body.id)}`;
    expect(order!.terms).toMatchObject({ source: 'AUCTION', sale_kind: 'BUY_NOW', price_minor: '30000' });
    expect(order!.service_version_id).not.toBeNull();
  });

  it('counters are derived from reservation state; direct oversell or deletes are refused by the database', async () => {
    const creator = await createUser('guard-creator');
    const buyer = await createUser('guard-buyer');
    const { serviceId, poolId } = await createPublishedService(command, creator, { capacity: 1 });
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief });
    const [reservation] = await sql`select id,bucket_id,pool_id from app.reservations where order_id=${String(booked.body.id)}`;
    const other = await command(await createUser('guard-other'), { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, bucket_id: String(reservation!.bucket_id) });
    expect(other.status).toBe(409);
    const [otherOrder] = await sql`insert into app.orders (buyer_id,creator_id,source,title,status,amount_minor,currency,brief)
      values (${buyer.id},${creator.id},'BOOK','direct insert','AWAITING_PAYMENT',100,'USD','direct insert used to probe the DB guard') returning id`;
    await expect(sql`insert into app.reservations (pool_id,bucket_id,order_id,state) values (${poolId},${String(reservation!.bucket_id)},${String(otherOrder!.id)},'HELD')`).rejects.toThrow(/capacity_buckets_no_oversell/);
    await expect(sql`delete from app.reservations where id=${String(reservation!.id)}`).rejects.toThrow(/cannot be deleted/);
    await expect(sql`update app.reservations set bucket_id=gen_random_uuid() where id=${String(reservation!.id)}`).rejects.toThrow(/immutable/);
  });
});

describe.skipIf(!RUN_DB)('SEC-09/SEC-10 — self-dealing and suspended accounts', () => {
  it('SEC-09: self booking is rejected even for dual-role users', async () => {
    const dual = await createUser('sec09');
    const { serviceId } = await createPublishedService(command, dual, { capacity: 1 });
    const self = await command(dual, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief });
    expect(self.status).toBe(400);
    expect(String(self.body.error)).toMatch(/cannot book your own service/);
  });

  it('SEC-10: a suspended creator loses new sales but can still deliver and message on funded orders', async () => {
    const creator = await createUser('sec10-creator');
    const buyer = await createUser('sec10-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 3 });
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief });
    const orderId = String(booked.body.id);
    expect((await pay(buyer, orderId)).status).toBe(200);

    await sql`update app.users set status='SUSPENDED' where id=${creator.id}`;
    expect((await command(await createUser('sec10-new-buyer'), { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief })).status).toBe(404);
    expect(await readModel.getServiceData(serviceId)).toBeNull();
    expect((await readModel.getPublicData()).services.map((s) => String(s.id))).not.toContain(serviceId);
    const publishAttempt = await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId });
    expect(publishAttempt.status).toBe(403);
    expect((await command(creator, { command: 'create_request', idempotency_key: key('req'), title: 'x', brief, taxonomy: 'CREATE', budget: '10', target_hires: '1', deadline: '2099-01-01T00:00' })).status).toBe(403);

    expect((await command(creator, { command: 'start', idempotency_key: key('start'), order_id: orderId })).status).toBe(200);
    expect((await command(creator, { command: 'message', idempotency_key: key('msg'), order_id: orderId, body: 'Still working on your order.' })).status).toBe(200);
    expect((await command(creator, { command: 'deliver', idempotency_key: key('deliver'), order_id: orderId, body: 'Delivered while suspended.' })).status).toBe(200);
    const visible = await readModel.getOrderData(actorOf(creator), orderId);
    expect(visible?.order.status).toBe('DELIVERED');
    await sql`update app.users set status='ACTIVE' where id=${creator.id}`;
  });
});
