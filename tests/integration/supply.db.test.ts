import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, sessionState, workloadCounters, workloadDrift, type TestUser } from './harness';

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
  it('SUP-01: publishing needs one approved public sample linked to the service; the draft is kept', async () => {
    const creator = await createUser('sup01');
    const created = await command(creator, serviceFields());
    expect(created.status).toBe(200);
    const serviceId = String(created.body.id);
    const refused = await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toMatch(/at least 1 approved public work sample before/);
    expect(String(refused.body.error)).toMatch(/Link at least one approved sample/);
    const [draft] = await sql`select status,published_version_id from app.services where id=${serviceId}`;
    expect(draft).toMatchObject({ status: 'DRAFT', published_version_id: null });

    // A sample that is not linked to this service does not satisfy the linked-sample rule.
    expect((await command(creator, { command: 'add_sample', idempotency_key: key('sample'), title: 'Unlinked portfolio', url: 'https://example.com/unlinked' })).status).toBe(200);
    await sql`update app.samples set moderation_status='APPROVED' where creator_id=${creator.id}`;
    const unlinked = await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId });
    expect(unlinked.status).toBe(400);
    expect(String(unlinked.body.error)).not.toMatch(/public work sample/);
    expect(String(unlinked.body.error)).toMatch(/Link at least one approved sample/);
    const added = await command(creator, { command: 'add_sample', idempotency_key: key('sample'), title: 'Portfolio thread', url: 'https://example.com/p1', service_id: serviceId });
    expect(added.status).toBe(200);
    // Samples added later start PENDING and do not count until approved.
    expect((await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId })).status).toBe(400);
    await sql`update app.samples set moderation_status='APPROVED' where creator_id=${creator.id}`;
    expect((await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId })).status).toBe(200);
    const [published] = await sql`select s.status,v.version,v.price_minor from app.services s join app.service_versions v on v.id=s.published_version_id where s.id=${serviceId}`;
    expect(published).toMatchObject({ status: 'PUBLISHED', version: 1, price_minor: '40000' });
    expect((await readModel.getServiceData(serviceId))?.service.availability_status).toBe('ACCEPTING');
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
    expect((await command(creator, { command: 'deliver', idempotency_key: key('deliver'), order_id: orderId, body: 'Delivered after the service was archived.' })).status).toBe(200);
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

describe.skipIf(!RUN_DB)('CAP — active order limit', () => {
  const book = (buyer: TestUser, serviceId: string) => command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief });
  const claimOf = async (orderId: string) => (await sql`select id,state,units,origin,auction_id,order_id from app.workload_claims where order_id=${orderId}`)[0];

  it('CAP-01: with one free place, 20 concurrent bookings on real connections produce exactly one claim', async () => {
    const creator = await createUser('cap01');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 2 });
    const first = await book(await createUser('cap01-first'), serviceId);
    expect(first.status).toBe(200);
    const buyers = await Promise.all(Array.from({ length: 20 }, (_, i) => createUser(`cap01-buyer-${i}`)));
    const results = await Promise.all(buyers.map((buyer) => book(buyer, serviceId)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const loser of results.filter((r) => r.status !== 200)) {
      expect(loser.status).toBe(409);
      expect(String(loser.body.error)).toMatch(/at capacity/);
    }
    expect(await workloadCounters(creator.id)).toMatchObject({ held_units: 2, active_units: 0, max_active_units: 2 });
    const [{ count }] = await sql`select count(*)::int as count from app.workload_claims where creator_id=${creator.id}`;
    expect(count).toBe(2);
    expect(await workloadDrift()).toBe(0);
  });

  it('CAP-02: two services of one creator share the limit; units_per_order is counted', async () => {
    const creator = await createUser('cap02');
    const first = await createPublishedService(command, creator, { capacity: 3 });
    const heavy = await command(creator, withSamples(serviceFields({ title: 'Video explainer weighs two', units_per_order: '2' })));
    expect(heavy.status).toBe(200);
    expect((await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: String(heavy.body.id) })).status).toBe(200);
    const [version] = await sql`select v.units_per_order from app.services s join app.service_versions v on v.id=s.published_version_id where s.id=${String(heavy.body.id)}`;
    expect(version!.units_per_order).toBe(2);

    const buyers = await Promise.all(Array.from({ length: 10 }, (_, i) => createUser(`cap02-buyer-${i}`)));
    const results = await Promise.all(buyers.map((buyer, i) => book(buyer, i % 2 ? first.serviceId : String(heavy.body.id))));
    const won = results.filter((r) => r.status === 200);
    const units = await sql`select coalesce(sum(units),0)::int as n from app.workload_claims where creator_id=${creator.id} and state='HELD'`;
    expect(units[0]!.n).toBeLessThanOrEqual(3);
    expect(won.length).toBeGreaterThanOrEqual(2);
    expect((await workloadCounters(creator.id)).held_units).toBe(units[0]!.n);

    // The heavy service reads as at capacity once fewer than two units are free, even while the light one still accepts.
    const light = await readModel.getServiceData(first.serviceId);
    const heavyView = await readModel.getServiceData(String(heavy.body.id));
    const free = 3 - units[0]!.n;
    expect(light?.service.availability_status).toBe(free >= 1 ? 'ACCEPTING' : 'AT_CAPACITY');
    expect(heavyView?.service.availability_status).toBe(free >= 2 ? 'ACCEPTING' : 'AT_CAPACITY');
    expect(light?.service).not.toHaveProperty('held_units');
    expect(await workloadDrift()).toBe(0);
  });

  it('CAP-06: approving frees the place exactly once and the creator can take a new order', async () => {
    const creator = await createUser('cap06-creator');
    const buyer = await createUser('cap06-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 1 });
    const orderId = String((await book(buyer, serviceId)).body.id);
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect(await workloadCounters(creator.id)).toMatchObject({ held_units: 0, active_units: 1 });
    expect((await book(await createUser('cap06-blocked'), serviceId)).status).toBe(409);
    expect((await readModel.getServiceData(serviceId))?.service.availability_status).toBe('AT_CAPACITY');

    for (const [actor, fields] of [[creator, { command: 'start' }], [creator, { command: 'deliver', body: 'Done — all agreed files are attached.' }], [buyer, { command: 'approve', delivery_version: '1' }]] as const) {
      expect((await command(actor, { idempotency_key: key('step'), order_id: orderId, ...fields })).status).toBe(200);
    }
    const claim = await claimOf(orderId);
    expect(claim).toMatchObject({ state: 'DONE', origin: 'BOOK', units: 1 });
    expect(await workloadCounters(creator.id)).toMatchObject({ held_units: 0, active_units: 0 });
    await expect(sql`update app.workload_claims set state='ACTIVE' where id=${String(claim!.id)}`).rejects.toThrow(/invalid workload claim transition DONE -> ACTIVE/);
    // A later status change (COMPLETED) does not touch the finished claim again.
    await sql`update app.orders set status='COMPLETED',version=version+1 where id=${orderId}`;
    expect(await workloadCounters(creator.id)).toMatchObject({ held_units: 0, active_units: 0 });
    expect((await readModel.getServiceData(serviceId))?.service.availability_status).toBe('ACCEPTING');
    expect((await book(await createUser('cap06-next'), serviceId)).status).toBe(200);
    expect(await workloadDrift()).toBe(0);
  });

  it('CAP-07: lowering the limit keeps accepted work and blocks new orders until the creator is below it', async () => {
    const creator = await createUser('cap07-creator');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 2 });
    const funded: { buyer: TestUser; orderId: string }[] = [];
    for (const n of [1, 2]) {
      const buyer = await createUser(`cap07-buyer-${n}`);
      const booked = await book(buyer, serviceId);
      expect(booked.status).toBe(200);
      expect((await pay(buyer, String(booked.body.id))).status).toBe(200);
      funded.push({ buyer, orderId: String(booked.body.id) });
    }
    expect((await command(creator, { command: 'set_workload_limit', idempotency_key: key('limit'), max_active_units: '0' })).status).toBe(400);
    const lowered = await command(creator, { command: 'set_workload_limit', idempotency_key: key('limit'), max_active_units: '1' });
    expect(lowered.status).toBe(200);
    expect(String(lowered.body.message)).toMatch(/You have 2 in progress/);
    expect(await workloadCounters(creator.id)).toMatchObject({ max_active_units: 1, active_units: 2 });
    for (const { orderId } of funded) expect((await claimOf(orderId))!.state).toBe('ACTIVE');
    expect((await book(await createUser('cap07-blocked-1'), serviceId)).status).toBe(409);

    // One order finishing leaves 1 of 1 in use: still blocked. The second frees the place.
    await command(creator, { command: 'cancel', idempotency_key: key('cancel'), order_id: funded[0]!.orderId });
    expect((await book(await createUser('cap07-blocked-2'), serviceId)).status).toBe(409);
    await command(creator, { command: 'cancel', idempotency_key: key('cancel'), order_id: funded[1]!.orderId });
    expect((await book(await createUser('cap07-open'), serviceId)).status).toBe(200);
    expect(await workloadDrift()).toBe(0);
  });

  it('CAP-08: pausing blocks new bookings and auctions with NOT_ACCEPTING_ORDERS; running work continues', async () => {
    const creator = await createUser('cap08-creator');
    const buyer = await createUser('cap08-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 5 });
    const orderId = String((await book(buyer, serviceId)).body.id);
    expect((await pay(buyer, orderId)).status).toBe(200);

    expect((await command(creator, { command: 'set_accepting_orders', idempotency_key: key('pause'), accepting: 'maybe' })).status).toBe(400);
    expect((await command(creator, { command: 'set_accepting_orders', idempotency_key: key('pause'), accepting: 'false' })).status).toBe(200);
    const blocked = await book(await createUser('cap08-late'), serviceId);
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.error)).toMatch(/paused new orders/);
    const auction = await command(creator, {
      command: 'create_auction', idempotency_key: key('auc'), service_id: serviceId, starting_price: '100', minimum_increment: '10',
      starts_at: commandInstant(new Date(Date.now() - 60_000)), ends_at: commandInstant(new Date(Date.now() + 3_600_000)),
    });
    expect(auction.status).toBe(409);
    expect((await readModel.getServiceData(serviceId))?.service.availability_status).toBe('PAUSED');
    expect((await command(creator, { command: 'start', idempotency_key: key('start'), order_id: orderId })).status).toBe(200);
    expect((await command(creator, { command: 'deliver', idempotency_key: key('deliver'), order_id: orderId, body: 'Delivered while new orders are paused.' })).status).toBe(200);

    expect((await command(creator, { command: 'set_accepting_orders', idempotency_key: key('resume'), accepting: 'true' })).status).toBe(200);
    expect((await book(await createUser('cap08-after'), serviceId)).status).toBe(200);
  });

  it('CAP-09: Buy Now moves the auction claim to the order without claiming another place', async () => {
    const seller = await createUser('cap09-seller');
    const buyer = await createUser('cap09-buyer');
    const { serviceId } = await createPublishedService(command, seller, { capacity: 2 });
    const created = await command(seller, {
      command: 'create_auction', idempotency_key: key('auc'), service_id: serviceId, starting_price: '100', minimum_increment: '10', buy_now_price: '300',
      starts_at: commandInstant(new Date(Date.now() - 60_000)), ends_at: commandInstant(new Date(Date.now() + 3_600_000)),
    });
    expect(created.status).toBe(200);
    const [claim] = await sql`select id,origin,state from app.workload_claims where auction_id=${String(created.body.id)}`;
    expect(claim).toMatchObject({ origin: 'AUCTION', state: 'HELD' });
    expect(await workloadCounters(seller.id)).toMatchObject({ held_units: 1 });
    const bought = await command(buyer, { command: 'buy_now', idempotency_key: key('bn'), auction_id: String(created.body.id) });
    expect(bought.status).toBe(200);
    expect(await claimOf(String(bought.body.id))).toMatchObject({ id: claim!.id, origin: 'AUCTION', auction_id: null, state: 'HELD' });
    expect(await workloadCounters(seller.id)).toMatchObject({ held_units: 1, active_units: 0 });
    const [order] = await sql`select terms,service_version_id from app.orders where id=${String(bought.body.id)}`;
    expect(order!.terms).toMatchObject({ source: 'AUCTION', sale_kind: 'BUY_NOW', price_minor: '30000' });
    expect(order!.service_version_id).not.toBeNull();
  });

  it('CAP-12: cancelling funded work frees the place once, even if the order status changes again', async () => {
    const creator = await createUser('cap12-creator');
    const buyer = await createUser('cap12-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 1 });
    const orderId = String((await book(buyer, serviceId)).body.id);
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('cancel'), order_id: orderId })).status).toBe(200);
    expect((await claimOf(orderId))!.state).toBe('RELEASED');
    expect(await workloadCounters(creator.id)).toMatchObject({ held_units: 0, active_units: 0 });
    await sql`update app.orders set status='REFUNDED',version=version+1 where id=${orderId}`;
    expect(await workloadCounters(creator.id)).toMatchObject({ held_units: 0, active_units: 0 });
    expect(await workloadDrift()).toBe(0);
  });

  it('the database refuses claims above the limit, claims that skip HELD, deletes and ownership changes', async () => {
    const creator = await createUser('guard-creator');
    const buyer = await createUser('guard-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 1 });
    const booked = await book(buyer, serviceId);
    const claim = await claimOf(String(booked.body.id));
    const [otherOrder] = await sql`insert into app.orders (buyer_id,creator_id,source,title,status,amount_minor,currency,brief)
      values (${buyer.id},${creator.id},'BOOK','direct insert','AWAITING_PAYMENT',100,'USD','direct insert used to probe the DB guard') returning id`;
    await expect(sql`insert into app.workload_claims (creator_id,units,origin,order_id,state) values (${creator.id},1,'BOOK',${String(otherOrder!.id)},'HELD')`).rejects.toThrow(/active order limit/);
    await expect(sql`insert into app.workload_claims (creator_id,units,origin,order_id,state) values (${creator.id},1,'BOOK',${String(otherOrder!.id)},'ACTIVE')`).rejects.toThrow(/must start HELD/);
    await sql`update app.creator_workloads set accepting_orders=false where creator_id=${creator.id}`;
    await sql`update app.creator_workloads set max_active_units=5 where creator_id=${creator.id}`;
    await expect(sql`insert into app.workload_claims (creator_id,units,origin,order_id,state) values (${creator.id},1,'BOOK',${String(otherOrder!.id)},'HELD')`).rejects.toThrow(/not accepting new orders/);
    await expect(sql`delete from app.workload_claims where id=${String(claim!.id)}`).rejects.toThrow(/cannot be deleted/);
    await expect(sql`update app.workload_claims set creator_id=${buyer.id} where id=${String(claim!.id)}`).rejects.toThrow(/immutable/);
    await expect(sql`update app.workload_claims set units=2 where id=${String(claim!.id)}`).rejects.toThrow(/immutable|workload_claims_units_check/);
    await expect(sql`update app.creator_workloads set held_units=-1 where creator_id=${creator.id}`).rejects.toThrow(/held_units_check/);
    expect(await workloadDrift()).toBe(0);
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
