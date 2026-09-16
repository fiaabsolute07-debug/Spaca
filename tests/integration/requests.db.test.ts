import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/lib/auth';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

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
const applicationsCsvRoute = await import('@/app/api/requests/[id]/applications/route');
const { getRequestData } = await import('@/lib/read-model');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const asActor = (user: TestUser): Actor => ({ id: user.id, email: user.email, display_name: 'x', roles: ['buyer', 'creator'], is_test: true, status: 'ACTIVE', timezone: 'UTC' });
const inDays = (days: number) => commandInstant(new Date(Date.now() + days * 86_400_000));
const note = 'I have shipped launch threads for three developer tools.';

type Creator = TestUser;
async function creator(label: string): Promise<Creator> {
  const user = await createUser(label);
  await createPublishedService(command, user, { capacity: 5 });
  return user;
}

async function createRequest(buyer: TestUser, fields: Record<string, string> = {}) {
  const created = await command(buyer, {
    command: 'create_request', idempotency_key: key('req'), title: 'Launch campaign for our beta',
    brief: 'We need launch threads and follow-up posts for our public beta across creators.', taxonomy: 'CREATE',
    budget: '500', target_hires: '2', deadline: inDays(14), ...fields,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return String(created.body.id);
}

async function applyTo(requestId: string, user: TestUser, quote: string, extra: Record<string, string> = {}) {
  const applied = await command(user, { command: 'apply', idempotency_key: key('apply'), request_id: requestId, quote, turnaround_hours: '48', note, ...extra });
  return applied;
}
const applicationOf = async (requestId: string, user: TestUser) => (await sql`select * from app.applications where request_id=${requestId} and creator_id=${user.id}`)[0]!;
const requestRow = async (requestId: string) => (await sql`select * from app.requests where id=${requestId}`)[0]!;

async function select(buyer: TestUser, application: Record<string, unknown>) {
  return command(buyer, { command: 'select_application', idempotency_key: key('sel'), application_id: String(application.id), application_version: String(application.version) });
}
async function hire(buyer: TestUser, requestId: string, user: Creator, quote: string) {
  expect((await applyTo(requestId, user, quote)).status).toBe(200);
  const offer = await select(buyer, await applicationOf(requestId, user));
  expect(offer.status, JSON.stringify(offer.body)).toBe(200);
  const accepted = await command(user, { command: 'accept_offer', idempotency_key: key('acc'), offer_id: String(offer.body.id) });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return { offerId: String(offer.body.id), orderId: String(accepted.body.id) };
}

beforeEach(() => {
  if (RUN_DB) funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_requests_suite_secret1'] }));
});
afterAll(async () => {
  if (RUN_DB) {
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('REQ-01/02/03/10/11 — requests and private versioned quotes', () => {
  it('REQ-01/10: a cap alone sets the total; edits are versioned and never go below what is held', async () => {
    const buyer = await createUser('req01-buyer');
    const bad = await command(buyer, { command: 'create_request', idempotency_key: key('r'), title: 'Bad deadlines', brief: 'A brief with enough words to be valid here.', taxonomy: 'CREATE',
      per_creator_cap: '100', target_hires: '3', deadline: inDays(5), application_deadline: inDays(6) });
    expect(bad.status).toBe(400);
    const requestId = await createRequest(buyer, { budget: '', per_creator_cap: '100', target_hires: '3', application_deadline: inDays(7) });
    expect(await requestRow(requestId)).toMatchObject({ budget_minor: '30000', per_creator_cap_minor: '10000', target_hires: 3, version: 1, status: 'OPEN' });

    const maker = await creator('req01-creator');
    await hire(buyer, requestId, maker, '90');
    const stale = await command(buyer, { command: 'update_request', idempotency_key: key('u'), request_id: requestId, expected_version: '2', budget: '400' });
    expect(stale.status).toBe(409);
    const below = await command(buyer, { command: 'update_request', idempotency_key: key('u'), request_id: requestId, expected_version: '1', budget: '85', per_creator_cap: '85' });
    expect(below.status).toBe(422);
    await expect(sql`update app.requests set budget_minor=5000 where id=${requestId}`).rejects.toThrow(/requests_budget_not_oversold/);
    const raised = await command(buyer, { command: 'update_request', idempotency_key: key('u'), request_id: requestId, expected_version: '1', budget: '600', target_hires: '1' });
    expect(raised.status).toBe(200);
    expect(await requestRow(requestId)).toMatchObject({ budget_minor: '60000', target_hires: 1, version: 2 });
  });

  it('REQ-02/03/11: one versioned application per creator; quotes stay private; nothing is auto-awarded', async () => {
    const buyer = await createUser('req02-buyer');
    const a = await creator('req02-a');
    const b = await creator('req02-b');
    await sql`insert into app.samples (creator_id,title,url,visibility,moderation_status) values (${a.id},'Approved work','https://example.com/w','PUBLIC','APPROVED')`;
    const requestId = await createRequest(buyer, { per_creator_cap: '300' });

    expect((await applyTo(requestId, a, '301')).status).toBe(422);
    expect((await applyTo(requestId, buyer, '10')).status).toBe(403);
    expect((await applyTo(requestId, a, '100', { turnaround_hours: String(24 * 30) })).status).toBe(422);
    expect((await applyTo(requestId, a, '250')).status).toBe(200);
    expect((await applyTo(requestId, a, '240', { note: `${note} Updated with a lower quote.` })).status).toBe(200);
    expect((await applyTo(requestId, b, '120')).status).toBe(200);
    const [{ n }] = await sql`select count(*)::int as n from app.applications where request_id=${requestId} and creator_id=${a.id}`;
    expect(n).toBe(1);
    const appA = await applicationOf(requestId, a);
    expect(appA).toMatchObject({ version: 2, quote_minor: '24000', status: 'SUBMITTED' });
    expect((appA.samples_snapshot as { title: string }[]).map((sample) => sample.title)).toContain('Approved work');
    expect((await sql`select version,quote_minor from app.application_versions where application_id=${String(appA.id)} order by version`).map((r) => [r.version, r.quote_minor]))
      .toEqual([[1, '25000'], [2, '24000']]);
    await expect(sql`update app.application_versions set quote_minor=1 where application_id=${String(appA.id)}`).rejects.toThrow(/immutable/);

    const asB = await getRequestData(asActor(b), requestId);
    expect(asB!.applications.map((x) => x.creator_id)).toEqual([b.id]);
    expect(asB!.campaign).toBeNull();
    expect((await getRequestData(null, requestId))!.applications).toEqual([]);
    const asBuyer = await getRequestData(asActor(buyer), requestId);
    expect(asBuyer!.applications.map((x) => x.quote_minor).sort()).toEqual(['12000', '24000']);
    expect(asBuyer!.campaign).toMatchObject({ offered_minor: '0', committed_hires: 0 });
    expect((await sql`select count(*)::int as n from app.hire_offers where request_id=${requestId}`)[0]!.n).toBe(0);

    await sql`update app.requests set application_deadline=now() - interval '1 minute' where id=${requestId}`;
    expect((await applyTo(requestId, b, '110')).status).toBe(422);
  });
});

describe.skipIf(!RUN_DB)('REQ-04/05/09 — selection', () => {
  it('REQ-04: a changed or expired quote is never selected silently', async () => {
    const buyer = await createUser('req04-buyer');
    const maker = await creator('req04-creator');
    const requestId = await createRequest(buyer);
    await applyTo(requestId, maker, '200');
    const seen = await applicationOf(requestId, maker);
    await applyTo(requestId, maker, '260');
    const stale = await select(buyer, seen);
    expect(stale.status).toBe(409);
    expect(String(stale.body.error)).toMatch(/version 2/);
    const current = await applicationOf(requestId, maker);
    await sql`update app.applications set valid_until=now() - interval '1 minute' where id=${String(current.id)}`;
    expect((await select(buyer, current)).status).toBe(422);
    expect((await sql`select count(*)::int as n from app.hire_offers where request_id=${requestId}`)[0]!.n).toBe(0);
  });

  it('REQ-04: a creator who paused new orders or was suspended after applying cannot be sent an offer until available again', async () => {
    const buyer = await createUser('req04b-buyer');
    const maker = await creator('req04b-creator');
    const requestId = await createRequest(buyer);
    await applyTo(requestId, maker, '200');
    expect((await command(maker, { command: 'set_accepting_orders', idempotency_key: key('p'), accepting: 'false' })).status).toBe(200);
    const paused = await select(buyer, await applicationOf(requestId, maker));
    expect(paused.status).toBe(409);
    expect(String(paused.body.error)).toMatch(/paused new orders/);
    await sql`update app.users set status='SUSPENDED' where id=${maker.id}`;
    try {
      expect((await select(buyer, await applicationOf(requestId, maker))).status).toBe(403);
    } finally {
      await sql`update app.users set status='ACTIVE' where id=${maker.id}`;
    }
    expect((await sql`select count(*)::int as n from app.hire_offers where request_id=${requestId}`)[0]!.n).toBe(0);
    expect((await sql`select reserved_minor from app.requests where id=${requestId}`)[0]!.reserved_minor).toBe('0');
    expect((await command(maker, { command: 'set_accepting_orders', idempotency_key: key('p'), accepting: 'true' })).status).toBe(200);
    expect((await select(buyer, await applicationOf(requestId, maker))).status).toBe(200);
  });

  it('REQ-05: concurrent selections never exceed the budget or the hire count', async () => {
    const buyer = await createUser('req05-buyer');
    const makers = await Promise.all(['a', 'b', 'c'].map((label) => creator(`req05-${label}`)));
    const byBudget = await createRequest(buyer, { budget: '150', target_hires: '3' });
    for (const maker of makers) await applyTo(byBudget, maker, '70');
    const apps = await Promise.all(makers.map((maker) => applicationOf(byBudget, maker)));
    const results = await Promise.all(apps.map((app) => select(buyer, app)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 422]);
    expect(await requestRow(byBudget)).toMatchObject({ reserved_minor: '14000', reserved_hires: 2 });

    const byCount = await createRequest(buyer, { budget: '1000', target_hires: '2' });
    for (const maker of makers) await applyTo(byCount, maker, '100');
    const countApps = await Promise.all(makers.map((maker) => applicationOf(byCount, maker)));
    const countResults = await Promise.all(countApps.map((app) => select(buyer, app)));
    expect(countResults.map((r) => r.status).sort()).toEqual([200, 200, 422]);
    const row = await requestRow(byCount);
    expect(row).toMatchObject({ reserved_hires: 2, reserved_minor: '20000' });
    const [held] = await sql`select count(*)::int as n, coalesce(sum(amount_minor),0)::text as total from app.request_budget_reservations where request_id=${byCount} and state='HELD'`;
    expect(held).toMatchObject({ n: 2, total: '20000' });
  });

  it('REQ-09: selecting and accepting the same quote twice creates one offer and one order', async () => {
    const buyer = await createUser('req09-buyer');
    const maker = await creator('req09-creator');
    const requestId = await createRequest(buyer);
    await applyTo(requestId, maker, '150');
    const app = await applicationOf(requestId, maker);
    const selections = await Promise.all([select(buyer, app), select(buyer, app)]);
    expect(selections.map((r) => r.status).sort()).toEqual([200, 409]);
    const offerId = String(selections.find((r) => r.status === 200)!.body.id);
    const accepts = await Promise.all([1, 2].map(() => command(maker, { command: 'accept_offer', idempotency_key: key('acc'), offer_id: offerId })));
    expect(accepts.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await sql`select count(*)::int as n from app.orders where source='REQUEST' and source_ref=${requestId}`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from app.request_budget_reservations where request_id=${requestId}`)[0]!.n).toBe(1);
  });
});

describe.skipIf(!RUN_DB)('REQ-06/07/08 — hire, payment and partial failure', () => {
  it('REQ-06/07: accepting holds a place in the creator\'s order limit; an accepted offer outlives its expiry and funding commits the hire', async () => {
    const buyer = await createUser('req06-buyer');
    const maker = await creator('req06-creator');
    const other = await creator('req06-other');
    const requestId = await createRequest(buyer, { target_hires: '1' });
    await applyTo(requestId, maker, '200');
    const offer = await select(buyer, await applicationOf(requestId, maker));
    const offerId = String(offer.body.id);
    expect((await command(other, { command: 'accept_offer', idempotency_key: key('a'), offer_id: offerId })).status).toBe(404);
    // A paused creator cannot take the hire until they resume.
    expect((await command(maker, { command: 'set_accepting_orders', idempotency_key: key('p'), accepting: 'false' })).status).toBe(200);
    expect((await command(maker, { command: 'accept_offer', idempotency_key: key('a'), offer_id: offerId })).status).toBe(409);
    expect((await command(maker, { command: 'set_accepting_orders', idempotency_key: key('p'), accepting: 'true' })).status).toBe(200);
    const accepted = await command(maker, { command: 'accept_offer', idempotency_key: key('a'), offer_id: offerId });
    expect(accepted.status).toBe(200);
    const orderId = String(accepted.body.id);
    const [order] = await sql`select service_id,status,amount_minor,platform_fee_minor,terms from app.orders where id=${orderId}`;
    expect(order).toMatchObject({ service_id: null, status: 'AWAITING_PAYMENT', amount_minor: '20000', platform_fee_minor: '0' });
    expect((order!.terms as Record<string, unknown>).capacity).toMatchObject({ model: 'ACTIVE_ORDERS', units: 1 });
    expect((await sql`select state,origin,creator_id from app.workload_claims where order_id=${orderId}`)[0]).toMatchObject({ state: 'HELD', origin: 'OFFER', creator_id: maker.id });
    expect((await sql`select order_id,state from app.request_budget_reservations where offer_id=${offerId}`)[0]).toMatchObject({ order_id: orderId, state: 'HELD' });

    // The 24-hour offer timer passing after acceptance must not release the accepted hire.
    await sql`update app.hire_offers set expires_at=now() - interval '1 minute' where id=${offerId}`;
    expect((await jobs.expireHireOffers({ requestId })).outcomes).toEqual({});
    expect((await sql`select state from app.request_budget_reservations where offer_id=${offerId}`)[0]!.state).toBe('HELD');
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await sql`select status from app.hire_offers where id=${offerId}`)[0]!.status).toBe('ACCEPTED');
    expect((await sql`select state from app.request_budget_reservations where offer_id=${offerId}`)[0]!.state).toBe('COMMITTED');
    expect(await requestRow(requestId)).toMatchObject({ status: 'FILLED', committed_hires: 1, committed_minor: '20000', reserved_hires: 0 });
  });

  it('REQ-08: one hire refunded and one lapsed leave the funded hire intact; close keeps orders', async () => {
    const buyer = await createUser('req08-buyer');
    const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map((label) => creator(`req08-${label}`)));
    const requestId = await createRequest(buyer, { budget: '1000', target_hires: '3' });
    const first = await hire(buyer, requestId, a!, '100');
    const second = await hire(buyer, requestId, b!, '120');
    const third = await hire(buyer, requestId, c!, '130');
    expect((await pay(buyer, first.orderId)).status).toBe(200);
    expect((await pay(buyer, second.orderId)).status).toBe(200);
    expect(await requestRow(requestId)).toMatchObject({ committed_hires: 2, reserved_hires: 1, status: 'OPEN' });

    // Second hire: funded then cancelled before work → provider refund → budget released.
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: second.orderId })).status).toBe(200);
    expect((await sql`select status from app.orders where id=${second.orderId}`)[0]!.status).toBe('REFUNDED');
    // Third hire: never paid; the checkout hold expires → offer lapses, application can be offered again.
    await sql`update app.workload_claims set expires_at=now() - interval '1 minute' where order_id=${third.orderId}`;
    expect((await jobs.expireCheckoutHolds({ orderId: third.orderId })).outcomes).toEqual({ RELEASED: 1 });
    expect((await sql`select status from app.hire_offers where id=${third.offerId}`)[0]!.status).toBe('LAPSED');
    expect((await applicationOf(requestId, c!)).status).toBe('SUBMITTED');

    const states = Object.fromEntries((await sql`select offer_id,state from app.request_budget_reservations where request_id=${requestId}`).map((r) => [String(r.offer_id), r.state]));
    expect(states).toEqual({ [first.offerId]: 'COMMITTED', [second.offerId]: 'RELEASED', [third.offerId]: 'RELEASED' });
    expect(await requestRow(requestId)).toMatchObject({ committed_hires: 1, committed_minor: '10000', reserved_hires: 0, reserved_minor: '0' });
    expect((await sql`select status from app.orders where id=${first.orderId}`)[0]!.status).toBe('FUNDED');

    const campaign = (await getRequestData(asActor(buyer), requestId))!.campaign!;
    expect(campaign).toMatchObject({ funded_minor: '10000', refunded_minor: '12000', awaiting_payment_minor: '0' });
    expect(campaign.hires.length).toBe(3);

    await applyTo(requestId, d!, '90');
    expect((await select(buyer, await applicationOf(requestId, d!))).status).toBe(200);
    expect((await command(buyer, { command: 'cancel_request', idempotency_key: key('x'), request_id: requestId })).status).toBe(409);
    const closed = await command(buyer, { command: 'close_request', idempotency_key: key('x'), request_id: requestId });
    expect(closed.status).toBe(200);
    expect(await requestRow(requestId)).toMatchObject({ status: 'CLOSED', reserved_hires: 0, committed_hires: 1 });
    expect((await applicationOf(requestId, d!)).status).toBe('SUBMITTED');
    expect((await sql`select status from app.orders where id=${first.orderId}`)[0]!.status).toBe('FUNDED');
    expect((await applyTo(requestId, d!, '95')).status).toBe(422);
  });

  it('offers expire, can be declined or withdrawn, and always return their budget', async () => {
    const buyer = await createUser('offers-buyer');
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((label) => creator(`offers-${label}`)));
    const requestId = await createRequest(buyer, { budget: '600', target_hires: '3' });
    for (const [maker, quote] of [[a, '100'], [b, '110'], [c, '120']] as const) await applyTo(requestId, maker!, quote);
    const offers = await Promise.all([a, b, c].map(async (maker) => String((await select(buyer, await applicationOf(requestId, maker!))).body.id)));
    expect(await requestRow(requestId)).toMatchObject({ reserved_hires: 3, reserved_minor: '33000' });

    expect((await command(b!, { command: 'decline_offer', idempotency_key: key('d'), offer_id: offers[1]!, reason: 'Fully booked this month.' })).status).toBe(200);
    expect((await command(a!, { command: 'withdraw_offer', idempotency_key: key('w'), offer_id: offers[2]! })).status).toBe(404);
    expect((await command(buyer, { command: 'withdraw_offer', idempotency_key: key('w'), offer_id: offers[2]! })).status).toBe(200);
    await sql`update app.hire_offers set expires_at=now() - interval '1 minute' where id=${offers[0]!}`;
    expect((await command(a!, { command: 'accept_offer', idempotency_key: key('a'), offer_id: offers[0]! })).status).toBe(422);
    expect((await jobs.expireHireOffers({ requestId })).outcomes).toEqual({ OFFER_EXPIRED: 1 });

    expect((await sql`select status from app.hire_offers where request_id=${requestId} order by amount_minor`).map((r) => r.status)).toEqual(['EXPIRED', 'DECLINED', 'WITHDRAWN']);
    expect(await requestRow(requestId)).toMatchObject({ reserved_hires: 0, reserved_minor: '0', status: 'OPEN' });
    expect([(await applicationOf(requestId, a!)).status, (await applicationOf(requestId, b!)).status, (await applicationOf(requestId, c!)).status]).toEqual(['SUBMITTED', 'DECLINED', 'SUBMITTED']);
    expect((await select(buyer, await applicationOf(requestId, a!))).status).toBe(200);
    await expect(sql`update app.hire_offers set amount_minor=1 where id=${offers[0]!}`).rejects.toThrow(/immutable|already/);
  });
});

describe.skipIf(!RUN_DB)('REQ-11 — applications CSV for the campaign buyer only', () => {
  const csvFor = async (actor: TestUser | null, id: string) => {
    sessionState.token = actor?.token ?? null;
    const response = await applicationsCsvRoute.GET(new Request(`http://localhost:3000/api/requests/${id}/applications`), { params: Promise.resolve({ id }) });
    return { status: response.status, type: response.headers.get('content-type') ?? '', text: response.status === 200 ? await response.text() : '' };
  };

  it('lists every application in received order with quoted cells and neutralized formulas; others get 404', async () => {
    const buyer = await createUser('csv-buyer');
    const first = await creator('csv-first');
    const second = await creator('csv-second');
    const requestId = await createRequest(buyer);
    expect((await applyTo(requestId, first, '120')).status).toBe(200);
    expect((await applyTo(requestId, second, '95', { note: '=HYPERLINK("https://example.test") launch threads for developer tools we shipped.' })).status).toBe(200);

    const csv = await csvFor(buyer, requestId);
    expect(csv.status).toBe(200);
    expect(csv.type).toContain('text/csv');
    const lines = csv.text.trimEnd().split('\r\n');
    expect(lines[0]).toBe('creator,handle,status,quote_usd,turnaround_hours,quote_version,valid_until,offer_status,received_at,updated_at,note');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"SUBMITTED","120.00","48","1"');
    expect(lines[2]).toContain('"95.00"');
    expect(lines[2]).toContain(`"'=HYPERLINK(""https://example.test"")`);

    expect((await csvFor(first, requestId)).status).toBe(404);
    expect((await csvFor(null, requestId)).status).toBe(404);
    expect((await csvFor(buyer, 'not-a-uuid')).status).toBe(404);
    expect((await csvFor(buyer, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe.skipIf(!RUN_DB)('§9.2 — campaigns for live sessions and for licensed files', () => {
  const sessionBrief = 'We want a live walkthrough of our developer tooling for our engineering team, with questions at the end.';
  const filesBrief = 'We need a set of editable launch graphics and a slide template for our public beta announcement.';
  const rights = 'Use in our own marketing on any channel, edit for size and language, worldwide, with no time limit.';

  it('an ACCESS campaign hires a session length, and the time stays something both sides agree in messages', async () => {
    const buyer = await createUser('access-buyer');
    const requestId = await createRequest(buyer, { title: 'Live walkthrough for our team', brief: sessionBrief, taxonomy: 'ACCESS', access_session_minutes: '90' });
    expect(await requestRow(requestId)).toMatchObject({ taxonomy: 'ACCESS', access_session_minutes: 90 });

    const maker = await creator('access-creator');
    const { orderId } = await hire(buyer, requestId, maker, '150');
    const [order] = await sql`select terms,amount_minor from app.orders where id=${orderId}`;
    const terms = order!.terms as { deliverable: string; access?: { session_minutes: number; scheduling: string }; license?: unknown; digital?: unknown };
    expect(terms.deliverable).toBe('SESSION');
    expect(terms.access).toEqual({ session_minutes: 90, scheduling: 'AGREED_IN_MESSAGES' });
    expect(terms.digital).toBeUndefined();

    // Editing the campaign afterwards does not touch a session that was already hired.
    const version = String((await requestRow(requestId)).version);
    expect((await command(buyer, { command: 'update_request', idempotency_key: key('u'), request_id: requestId, expected_version: version, access_session_minutes: '45' })).status).toBe(200);
    expect(await requestRow(requestId)).toMatchObject({ access_session_minutes: 45 });
    expect(((await sql`select terms from app.orders where id=${orderId}`)[0]!.terms as { access: { session_minutes: number } }).access.session_minutes).toBe(90);
  });

  it('a DIGITAL campaign freezes the rights it commissioned, and stays a commission rather than a product listing', async () => {
    const buyer = await createUser('license-buyer');
    const requestId = await createRequest(buyer, {
      title: 'Launch graphics for our beta', brief: filesBrief, taxonomy: 'DIGITAL', license_kind: 'EXCLUSIVE', license_rights_text: rights,
    });
    expect(await requestRow(requestId)).toMatchObject({ taxonomy: 'DIGITAL', license_kind: 'EXCLUSIVE', license_rights_text: rights });

    const maker = await creator('license-creator');
    const { orderId } = await hire(buyer, requestId, maker, '300');
    const [order] = await sql`select terms from app.orders where id=${orderId}`;
    const terms = order!.terms as { deliverable: string; license?: Record<string, string>; digital?: unknown };
    expect(terms.deliverable).toBe('DIGITAL_FILE');
    expect(terms.license).toEqual({ kind: 'EXCLUSIVE', rights_text: rights, policy_version: 'license-v1' });
    // No entitlement terms: a commissioned file has no stock, no release history and no download limit.
    expect(terms.digital).toBeUndefined();
    expect((await sql`select count(*)::int as n from app.digital_entitlements where order_id=${orderId}`)[0]!.n).toBe(0);
    // It is an ordinary commission with a work clock: work starts once the order is funded (409 here), rather than a
    // product listing, which refuses to start at all because its files are released the moment payment is confirmed.
    const early = await command(maker, { command: 'start', idempotency_key: key('st'), order_id: orderId });
    expect([early.status, String(early.body.error)]).toEqual([409, 'Payment is not confirmed yet']);
  });

  it('refuses a campaign whose category and terms do not match, in the database as well as the command', async () => {
    const buyer = await createUser('terms-guard-buyer');
    const missingSession = await command(buyer, {
      command: 'create_request', idempotency_key: key('r'), title: 'Live session with no length', brief: sessionBrief,
      taxonomy: 'ACCESS', budget: '500', target_hires: '1', deadline: inDays(14),
    });
    expect(missingSession.status).toBe(400);
    const tooLong = await command(buyer, {
      command: 'create_request', idempotency_key: key('r'), title: 'A very long session', brief: sessionBrief,
      taxonomy: 'ACCESS', budget: '500', target_hires: '1', deadline: inDays(14), access_session_minutes: '600',
    });
    expect(tooLong.status).toBe(400);
    const thinRights = await command(buyer, {
      command: 'create_request', idempotency_key: key('r'), title: 'Files with no rights', brief: filesBrief,
      taxonomy: 'DIGITAL', budget: '500', target_hires: '1', deadline: inDays(14), license_kind: 'NON_EXCLUSIVE', license_rights_text: 'anything',
    });
    expect(thinRights.status).toBe(400);

    // The category terms are also enforced below the command layer.
    const createRequestId = await createRequest(buyer);
    await expect(sql`update app.requests set access_session_minutes=60 where id=${createRequestId}`).rejects.toThrow(/requests_access_complete/);
    await expect(sql`update app.requests set license_kind='EXCLUSIVE',license_rights_text=${rights} where id=${createRequestId}`).rejects.toThrow(/requests_license_complete/);
  });
});

describe.skipIf(!RUN_DB)('campaign goals — launch, airdrop, shiller and the rest', () => {
  it('stores the goal, refuses an unknown one, and filters open campaigns by it with counts for every goal', async () => {
    const { getPublicData } = await import('@/lib/read-model');
    const buyer = await createUser('goal-buyer');
    const launch = await createRequest(buyer, { title: 'Mainnet launch threads', campaign_goal: 'LAUNCH' });
    const shill = await createRequest(buyer, { title: 'Disclosed posts for our token week', campaign_goal: 'shill' });
    const unlabelled = await createRequest(buyer, { title: 'A campaign posted through the API without a goal' });
    expect((await requestRow(launch)).campaign_goal).toBe('LAUNCH');
    expect((await requestRow(shill)).campaign_goal).toBe('SHILL');
    expect((await requestRow(unlabelled)).campaign_goal).toBeNull();

    const unknown = await command(buyer, {
      command: 'create_request', idempotency_key: key('req'), title: 'Pump campaign', brief: 'We need launch threads and follow-up posts for our public beta across creators.',
      taxonomy: 'CREATE', budget: '500', target_hires: '2', deadline: inDays(14), campaign_goal: 'PUMP',
    });
    expect(unknown.status).toBe(400);
    await expect(sql`update app.requests set campaign_goal='PUMP' where id=${launch}`).rejects.toThrow(/check constraint/);

    const all = await getPublicData();
    const ids = (rows: Record<string, unknown>[]) => rows.map((r) => String(r.id));
    expect(ids(all.requests)).toEqual(expect.arrayContaining([launch, shill, unlabelled]));
    const launches = await getPublicData({ goal: 'LAUNCH' });
    expect(ids(launches.requests)).toContain(launch);
    expect(ids(launches.requests)).not.toContain(shill);
    expect(ids(launches.requests)).not.toContain(unlabelled);
    expect(launches.requests.every((r) => r.campaign_goal === 'LAUNCH')).toBe(true);
    // Counts describe every open campaign, whichever goal is being viewed.
    expect(launches.goal_counts).toEqual(all.goal_counts);
    expect(launches.request_total).toBe(all.request_total);
    expect(all.goal_counts.SHILL).toBeGreaterThanOrEqual(1);
  });
});
