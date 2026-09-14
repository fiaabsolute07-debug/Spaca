import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, createUser, key, sessionState, workloadCounters, workloadDrift, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const slotsRoute = await import('@/app/api/services/[id]/slots/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const brief = 'Review our testnet launch plan together and suggest the first three community steps.';
const note = 'We covered the launch plan, the community steps and the follow-up reading list.';
const QUARTER = 15 * 60_000;
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const allWeek = (start = '00:00', end = '24:00') => JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start, end })));

async function slots(serviceId: string, from: Date, days = 7): Promise<string[]> {
  const response = await slotsRoute.GET(new Request(`http://localhost:3000/api/services/${serviceId}/slots?from=${from.toISOString()}&days=${days}`), { params: Promise.resolve({ id: serviceId }) });
  const body = await response.json() as { slots?: string[]; error?: string };
  if (response.status !== 200) throw new Error(`slots ${response.status}: ${JSON.stringify(body)}`);
  return body.slots!;
}

async function accessService(label: string, options: { timeZone?: string; windows?: string; limit?: number; notice?: number } = {}) {
  const creator = await createUser(`${label}-creator`);
  const saved = await command(creator, { command: 'set_availability', idempotency_key: key('avail'), time_zone: options.timeZone ?? 'UTC', windows: options.windows ?? allWeek() });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const created = await command(creator, {
    command: 'create_service', idempotency_key: key('svc'), title: `Strategy call ${label}`, description: 'A one-hour strategy call about your web3 launch and community plan.',
    taxonomy: 'ACCESS', price: '120', turnaround_hours: '24', access_session_minutes: '60', access_buffer_minutes: '15',
    access_cancel_notice_hours: String(options.notice ?? 24), access_no_show_minutes: '10', sample_url_1: 'https://example.com/talk', sample_title_1: 'Conference talk',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const serviceId = String(created.body.id);
  const published = await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  expect((await command(creator, { command: 'set_workload_limit', idempotency_key: key('limit'), max_active_units: String(options.limit ?? 5) })).status).toBe(200);
  return { creator, serviceId };
}

const book = (buyer: TestUser, serviceId: string, startsAt: number) => command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, starts_at: iso(startsAt), accept_terms: 'on' });
/** First 15-minute grid start at least `hours` from now (UTC availability makes every grid start offered). */
const gridStart = (hours: number) => Math.ceil((Date.now() + hours * HOUR) / QUARTER) * QUARTER;
const appointment = async (orderId: string) => (await sql`select state,starts_at,ends_at,blocked_until,creator_time_zone,meeting_url from app.appointments where order_id=${orderId}`)[0]!;

beforeAll(async () => {
  if (RUN_DB) await sql`update app.feature_flags set enabled=true where key='ACCESS_BOOKING_ENABLED'`;
});
beforeEach(() => {
  if (RUN_DB) funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_access_suite_secret_01'] }));
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  if (RUN_DB) {
    await sql`update app.feature_flags set enabled=false where key='ACCESS_BOOKING_ENABLED'`;
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('CAP-11 — ACCESS sessions never overlap, including the buffer', () => {
  it('refuses the same slot and a slot inside the buffer, accepts the next free slot, and the database refuses a raw overlap', async () => {
    const { creator, serviceId } = await accessService('cap11');
    const [a, b, c] = [await createUser('cap11-a'), await createUser('cap11-b'), await createUser('cap11-c')];
    const start = gridStart(72);

    const first = await book(a, serviceId, start);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const held = await appointment(String(first.body.id));
    expect(held).toMatchObject({ state: 'HELD', creator_time_zone: 'UTC' });
    expect(new Date(held.blocked_until).getTime()).toBe(start + 75 * 60_000);

    const same = await book(b, serviceId, start);
    expect(same.status).toBe(409);
    expect(String(same.body.error)).toMatch(/just booked/);
    // 60-minute session + 15-minute buffer: a start at +60 falls in the buffer, +75 is free. A start at -60 would overlap via its own buffer.
    expect((await book(b, serviceId, start + 60 * 60_000)).status).toBe(409);
    expect((await book(b, serviceId, start - 60 * 60_000)).status).toBe(409);
    const next = await book(b, serviceId, start + 75 * 60_000);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect((await book(c, serviceId, start - 75 * 60_000)).status).toBe(200);

    const free = await slots(serviceId, new Date(start - 3 * HOUR), 1);
    for (const taken of [start - 75 * 60_000, start - 60 * 60_000, start, start + 15 * 60_000, start + 60 * 60_000, start + 75 * 60_000]) expect(free).not.toContain(iso(taken));
    expect(free).toContain(iso(start + 150 * 60_000));
    expect(free).toContain(iso(start - 150 * 60_000));

    // The exclusion constraint holds even if application checks are bypassed.
    const [raw] = await sql`insert into app.orders (buyer_id,creator_id,service_id,service_version_id,source,title,status,amount_minor,platform_fee_minor,currency,brief,brief_ready_at,terms)
      select buyer_id,creator_id,service_id,service_version_id,source,title,'AWAITING_PAYMENT',amount_minor,platform_fee_minor,currency,brief,brief_ready_at,terms from app.orders where id=${String(first.body.id)} returning id`;
    await expect(sql`insert into app.appointments (order_id,creator_id,starts_at,ends_at,buffer_minutes,blocked_until,creator_time_zone,cancel_notice_hours,no_show_minutes)
      values (${String(raw!.id)},${creator.id},${iso(start + 30 * 60_000)},${iso(start + 90 * 60_000)},0,${iso(start + 90 * 60_000)},'UTC',24,10)`).rejects.toThrow(/appointments_no_overlap/);
    expect(await workloadDrift()).toBe(0);
    expect((await workloadCounters(creator.id)).held_units).toBe(3);
  });

  it('lets exactly one of several concurrent bookings for the same start win', async () => {
    const { serviceId, creator } = await accessService('cap11-race');
    const buyers = await Promise.all([1, 2, 3, 4].map((n) => createUser(`race-${n}`)));
    const start = gridStart(48);
    const results = await Promise.all(buyers.map((buyer) => book(buyer, serviceId, start)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await sql`select count(*)::int as n from app.appointments where creator_id=${creator.id} and state in ('HELD','BOOKED')`)[0]!.n).toBe(1);
    expect(await workloadDrift()).toBe(0);
  });

  it('frees the slot when the checkout hold expires, and books it on funding', async () => {
    const { serviceId } = await accessService('cap11-expiry');
    const [a, b] = [await createUser('exp-a'), await createUser('exp-b')];
    const start = gridStart(60);
    const first = await book(a, serviceId, start);
    const orderId = String(first.body.id);
    await sql`update app.workload_claims set expires_at=now() - interval '1 minute' where order_id=${orderId}`;
    await jobs.expireCheckoutHolds({ orderId });
    expect((await appointment(orderId)).state).toBe('CANCELLED');
    expect(await slots(serviceId, new Date(start - HOUR), 1)).toContain(iso(start));

    const second = await book(b, serviceId, start);
    expect(second.status).toBe(200);
    expect((await pay(b, String(second.body.id))).status).toBe(200);
    expect((await appointment(String(second.body.id))).state).toBe('BOOKED');
    const [order] = await sql`select status,delivery_due_at,terms from app.orders where id=${String(second.body.id)}`;
    expect(order!.status).toBe('FUNDED');
    expect(new Date(order!.delivery_due_at).getTime()).toBe(start + 60 * 60_000 + 24 * HOUR);
    expect(order!.terms.access).toMatchObject({ session_minutes: 60, buffer_minutes: 15, cancel_notice_hours: 24, no_show_minutes: 10, time_zone: 'UTC', starts_at: iso(start), policy_version: 'access-v1' });
  });

  it('refuses starts that are not offered: off-grid, too soon, outside availability, or without a time', async () => {
    const { serviceId } = await accessService('offered', { windows: JSON.stringify([{ weekday: 1, start: '09:00', end: '10:00' }]) });
    const buyer = await createUser('offered-buyer');
    expect((await book(buyer, serviceId, gridStart(72) + 5 * 60_000)).status).toBe(422);
    expect((await book(buyer, serviceId, gridStart(1))).status).toBe(422);
    const noTime = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief });
    expect(noTime.status).toBe(422);
    const offered = await slots(serviceId, new Date(), 14);
    expect(offered.length).toBeGreaterThan(0);
    // Monday 09:00–10:00 UTC with 60-minute sessions offers exactly one start per Monday.
    for (const slot of offered) expect(new Date(slot).getUTCDay() === 1 && slot.endsWith('T09:00:00.000Z')).toBe(true);
  });
});

describe.skipIf(!RUN_DB)('XPL-03 — ACCESS across time zones, cancellation notice and no-shows', () => {
  it('offers local availability as UTC instants and keeps booked instants when the creator changes time zone', async () => {
    const windows = JSON.stringify([{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 4, start: '20:00', end: '22:00' }]);
    const { creator, serviceId } = await accessService('xpl03-tz', { timeZone: 'Asia/Ho_Chi_Minh', windows });
    const offered = await slots(serviceId, new Date(), 14);
    expect(offered.length).toBeGreaterThan(0);
    for (const slot of offered) {
      const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(slot));
      expect(/^(Mon (09|10|11):|Thu (20|21):)/.test(local) && !/^(Mon 11:(15|30|45)|Thu 21:(15|30|45))/.test(local), `${slot} → ${local}`).toBe(true);
    }
    const buyer = await createUser('xpl03-buyer');
    const booked = await book(buyer, serviceId, new Date(offered[0]!).getTime());
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);

    expect((await command(creator, { command: 'set_availability', idempotency_key: key('avail'), time_zone: 'America/New_York', windows })).status).toBe(200);
    const kept = await appointment(String(booked.body.id));
    expect(iso(new Date(kept.starts_at).getTime())).toBe(offered[0]);
    expect(kept.creator_time_zone).toBe('Asia/Ho_Chi_Minh');
    const after = await slots(serviceId, new Date(), 14);
    for (const slot of after) {
      const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).format(new Date(slot));
      expect(/^(Mon,? (09|10|11)|Thu,? (20|21))/.test(local), `${slot} → ${local}`).toBe(true);
    }
    expect((await command(creator, { command: 'set_availability', idempotency_key: key('avail'), time_zone: 'Mars/Olympus', windows })).status).toBe(400);
    // The plain HTML form posts one window per checked day; 23:59 from a time input means until midnight.
    const plain = await command(creator, { command: 'set_availability', idempotency_key: key('avail'), time_zone: 'Europe/Berlin', day_2_on: 'on', day_2_start: '10:00', day_2_end: '23:59', day_3_start: '09:00', day_3_end: '17:00' });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(await sql`select weekday,start_minute,end_minute,time_zone from app.availability_windows where creator_id=${creator.id}`).toEqual([{ weekday: 2, start_minute: 600, end_minute: 1440, time_zone: 'Europe/Berlin' }]);
    expect((await command(creator, { command: 'set_availability', idempotency_key: key('avail'), time_zone: 'UTC', windows: JSON.stringify([{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }]) })).status).toBe(400);
  });

  it('applies the cancellation notice to buyers only, and a late cancellation needs the creator to agree', async () => {
    const { creator, serviceId } = await accessService('xpl03-cancel', { notice: 24 });
    const [early, late] = [await createUser('cancel-early'), await createUser('cancel-late')];
    const far = await book(early, serviceId, gridStart(72));
    const soon = await book(late, serviceId, gridStart(14));
    for (const [buyer, order] of [[early, far], [late, soon]] as const) expect((await pay(buyer, String(order.body.id))).status).toBe(200);

    const farCancel = await command(early, { command: 'cancel', idempotency_key: key('c'), order_id: String(far.body.id) });
    expect(farCancel.status, JSON.stringify(farCancel.body)).toBe(200);
    expect((await appointment(String(far.body.id))).state).toBe('CANCELLED');

    const lateCancel = await command(late, { command: 'cancel', idempotency_key: key('c'), order_id: String(soon.body.id) });
    expect(lateCancel.status).toBe(422);
    expect(String(lateCancel.body.error)).toMatch(/24 hours before/);
    const requested = await command(late, { command: 'request_cancellation', idempotency_key: key('rc'), order_id: String(soon.body.id), refund_amount: '60', reason: 'A conflict came up at work, sorry.' });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    const accepted = await command(creator, { command: 'respond_cancellation', idempotency_key: key('ra'), request_id: String(requested.body.id), decision: 'accept' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await appointment(String(soon.body.id))).state).toBe('CANCELLED');
    const [order] = await sql`select status,cancellation_refund_minor,settlement_status from app.orders where id=${String(soon.body.id)}`;
    expect(order).toMatchObject({ status: 'CANCELLED', cancellation_refund_minor: '6000', settlement_status: 'READY' });
    expect(await workloadDrift()).toBe(0);
  });

  it('records a completed session as the delivery, keeps the meeting link private, and refuses start/deliver for sessions', async () => {
    const { creator, serviceId } = await accessService('xpl03-done');
    const buyer = await createUser('done-buyer');
    const start = gridStart(20);
    const booked = await book(buyer, serviceId, start);
    const orderId = String(booked.body.id);
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await command(buyer, { command: 'set_meeting_link', idempotency_key: key('m'), order_id: orderId, meeting_url: 'https://meet.example.com/abc' })).status).toBe(403);
    expect((await command(creator, { command: 'set_meeting_link', idempotency_key: key('m'), order_id: orderId, meeting_url: 'http://meet.example.com/abc' })).status).toBe(400);
    expect((await command(creator, { command: 'set_meeting_link', idempotency_key: key('m'), order_id: orderId, meeting_url: 'https://meet.example.com/abc' })).status).toBe(200);
    expect((await appointment(orderId)).meeting_url).toBe('https://meet.example.com/abc');
    const [event] = await sql`select payload from app.order_events where order_id=${orderId} and kind='MEETING_LINK_SET'`;
    expect(JSON.stringify(event!.payload)).not.toContain('meet.example.com');

    expect((await command(creator, { command: 'start', idempotency_key: key('s'), order_id: orderId })).status).toBe(422);
    expect((await command(creator, { command: 'mark_session', idempotency_key: key('ms'), order_id: orderId, outcome: 'COMPLETED', note })).status).toBe(422);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(start + 5 * 60_000));
    expect((await command(creator, { command: 'mark_session', idempotency_key: key('ms'), order_id: orderId, outcome: 'NO_SHOW_BUYER', note })).status).toBe(422);
    vi.setSystemTime(new Date(start + 65 * 60_000));
    expect((await command(creator, { command: 'mark_session', idempotency_key: key('ms'), order_id: orderId, outcome: 'COMPLETED', note: 'short' })).status).toBe(400);
    const marked = await command(creator, { command: 'mark_session', idempotency_key: key('ms'), order_id: orderId, outcome: 'COMPLETED', note });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    vi.useRealTimers();

    expect((await appointment(orderId)).state).toBe('COMPLETED');
    const [order] = await sql`select status from app.orders where id=${orderId}`;
    expect(order!.status).toBe('DELIVERED');
    const [delivery] = await sql`select body,version from app.deliveries where order_id=${orderId}`;
    expect(delivery).toMatchObject({ body: note, version: 1 });
    expect((await command(buyer, { command: 'report_creator_no_show', idempotency_key: key('ns'), order_id: orderId, body: 'The creator never joined.' })).status).toBe(409);
    expect((await command(buyer, { command: 'approve', idempotency_key: key('ap'), order_id: orderId, delivery_version: '1' })).status).toBe(200);
    expect((await workloadCounters(creator.id)).active_units).toBe(0);
  });

  it('handles a buyer no-show after the grace period and a reported creator no-show as a dispute', async () => {
    const { creator, serviceId } = await accessService('xpl03-noshow');
    const [absent, waiting] = [await createUser('absent-buyer'), await createUser('waiting-buyer')];
    const first = gridStart(20);
    const second = first + 2 * HOUR;
    const a = String((await book(absent, serviceId, first)).body.id);
    const b = String((await book(waiting, serviceId, second)).body.id);
    for (const [buyer, orderId] of [[absent, a], [waiting, b]] as const) expect((await pay(buyer, orderId)).status).toBe(200);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(first + 11 * 60_000));
    const noShow = await command(creator, { command: 'mark_session', idempotency_key: key('ms'), order_id: a, outcome: 'NO_SHOW_BUYER', note: 'Waited fifteen minutes in the call and sent two messages.' });
    expect(noShow.status, JSON.stringify(noShow.body)).toBe(200);
    expect((await appointment(a)).state).toBe('NO_SHOW_BUYER');
    expect((await sql`select status from app.orders where id=${a}`)[0]!.status).toBe('DELIVERED');

    vi.setSystemTime(new Date(second + 5 * 60_000));
    expect((await command(waiting, { command: 'report_creator_no_show', idempotency_key: key('ns'), order_id: b, body: 'The creator never joined the call.' })).status).toBe(422);
    vi.setSystemTime(new Date(second + 12 * 60_000));
    const reported = await command(waiting, { command: 'report_creator_no_show', idempotency_key: key('ns'), order_id: b, body: 'The creator never joined the call.' });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    expect((await command(creator, { command: 'mark_session', idempotency_key: key('ms'), order_id: b, outcome: 'COMPLETED', note })).status).toBe(409);
    vi.useRealTimers();

    expect((await appointment(b)).state).toBe('NO_SHOW_CREATOR');
    const [order] = await sql`select status,status_before_dispute from app.orders where id=${b}`;
    expect(order).toMatchObject({ status: 'DISPUTED', status_before_dispute: 'IN_PROGRESS' });
    expect((await sql`select count(*)::int as n from app.disputes where order_id=${b}`)[0]!.n).toBe(1);
    expect(await workloadDrift()).toBe(0);
  });

  it('keeps ACCESS behind its flag and requires availability to publish', async () => {
    const creator = await createUser('flag-creator');
    const created = await command(creator, {
      command: 'create_service', idempotency_key: key('svc'), title: 'Office hours', description: 'Thirty minutes of office hours about token launches.',
      taxonomy: 'ACCESS', price: '50', turnaround_hours: '24', access_session_minutes: '30', sample_url_1: 'https://example.com/x', sample_title_1: 'Talk',
    });
    expect(created.status).toBe(200);
    const noWindows = await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: String(created.body.id) });
    expect(noWindows.status).toBe(400);
    expect(String(noWindows.body.error)).toMatch(/weekly availability/);
    expect((await command(creator, { command: 'create_service', idempotency_key: key('svc'), title: 'Odd call', description: 'A call that is not on the fifteen minute grid.', taxonomy: 'ACCESS', price: '50', turnaround_hours: '24', access_session_minutes: '50' })).status).toBe(400);

    const { serviceId } = await accessService('flag-live');
    const buyer = await createUser('flag-buyer');
    await sql`update app.feature_flags set enabled=false where key='ACCESS_BOOKING_ENABLED'`;
    try {
      expect((await book(buyer, serviceId, gridStart(30))).status).toBe(422);
      const response = await slotsRoute.GET(new Request(`http://localhost:3000/api/services/${serviceId}/slots`), { params: Promise.resolve({ id: serviceId }) });
      expect(response.status).toBe(503);
    } finally {
      await sql`update app.feature_flags set enabled=true where key='ACCESS_BOOKING_ENABLED'`;
    }
  });
});
