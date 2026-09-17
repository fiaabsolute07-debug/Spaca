import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { ORIGIN, RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const auth = await import('@/app/api/auth/route');
const cron = await import('@/app/api/cron/jobs/route');
const funding = await import('@/modules/payments/funding');
const { isFlagEnabled } = await import('@/modules/admin/policy');
const { hashPassword } = await import('@/lib/auth');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const CLOSED = 'Payments are not open yet on spaca. Everything before paying works; paying, bidding and collateral open later.';
const brief = 'Launch brief with the audience, the goal and three headline options for the thread.';

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (!RUN_DB) return;
  funding.setMockPaymentProviderForTests(undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('Launch mode: no money, scheduled jobs, sign-in throttling', () => {
  it('with PAYMENT_MODE=off everything before paying works, and booking, collateral and bids refuse with one message', async () => {
    funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_launch_mode_suite_1'] }));
    const creator = await createUser('launch-creator', ['creator']);
    const buyer = await createUser('launch-buyer', ['buyer']);
    const { serviceId } = await createPublishedService(command, creator);

    vi.stubEnv('PAYMENT_MODE', 'off');
    for (const flag of ['CHECKOUT_CREATION_ENABLED', 'BIDDING_ENABLED', 'PAYOUT_CREATION_ENABLED', 'CRYPTO_CHECKOUT_ENABLED'] as const) {
      expect(await isFlagEnabled(sql, flag)).toBe(false);
    }
    expect(await isFlagEnabled(sql, 'REQUESTS_ENABLED')).toBe(true);

    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, accept_terms: 'on' });
    expect(booked.status).toBe(422);
    expect(booked.body.error).toBe(CLOSED);

    // Setting up still works: a service draft and a campaign brief.
    const draft = await command(creator, { command: 'create_service', idempotency_key: key('svc'), title: 'Launch thread', description: 'One launch thread with a clear call to action and one revision.', taxonomy: 'CREATE', price: '40', turnaround_hours: '24' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);

    // Item auctions: listing works, locking collateral and bidding wait for payments.
    const now = Date.now();
    const utc = (date: Date) => date.toISOString().slice(0, 16);
    const listing = await command(creator, {
      command: 'create_item_listing', idempotency_key: key('item'), origin: 'RESALE', item_type: 'WL spot', title: `Launch mode WL ${randomUUID().slice(0, 6)}`,
      project_name: 'Nebula', network: 'Base', quantity: '1 spot', description: 'One whitelist spot for the Nebula public mint.',
      delivery_method: 'The project adds your wallet to the allowlist.', buyer_provides: 'EVM wallet address', starting_price: '100', min_increment: '10', collateral: '20',
      starts_at: utc(new Date(now - 60_000)), ends_at: utc(new Date(now + 2 * 3600_000)), delivery_due_at: utc(new Date(now + 26 * 3600_000)),
    });
    expect(listing.status, JSON.stringify(listing.body)).toBe(200);
    const collateral = await command(creator, { command: 'post_item_collateral', idempotency_key: key('col'), listing_id: String(listing.body.id) });
    expect(collateral.body.error).toBe(CLOSED);
    const bid = await command(buyer, { command: 'bid_item', idempotency_key: key('bid'), listing_id: String(listing.body.id), amount: '100' });
    expect(bid.body.error).toBe(CLOSED);

    // With payments open again the same booking goes through.
    vi.unstubAllEnvs();
    const reopened = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, accept_terms: 'on' });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
  });

  it('the scheduled jobs endpoint exists only with a secret, refuses a wrong one, and reports job names and counts', async () => {
    const call = (authorization?: string) => cron.GET(new Request(`${ORIGIN}/api/cron/jobs`, { headers: authorization ? { authorization } : {} }));
    vi.stubEnv('CRON_SECRET', '');
    expect((await call('Bearer anything')).status).toBe(404);
    const secret = `cron-${randomUUID()}-${randomUUID()}`;
    vi.stubEnv('CRON_SECRET', secret);
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${secret}x`)).status).toBe(401);
    funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_launch_mode_suite_1'] }));
    const ran = await call(`Bearer ${secret}`);
    const body = await ran.json() as { reports: Array<{ job: string; failed?: true }>; failed: number };
    expect(body.reports.length).toBe(19);
    expect(body.failed, JSON.stringify(body.reports.filter((report) => report.failed))).toBe(0);
    expect(ran.status).toBe(200);
  });

  it('password sign-in stops after ten failures for an address, even with the right password, until the window passes', async () => {
    const email = `launch-${randomUUID().slice(0, 8)}@example.test`;
    const password = 'a-long-launch-password';
    await sql`insert into app.users (email,display_name,password_hash,roles,is_test,status) values (${email},'Throttle Test',${hashPassword(password)},${['buyer']},true,'ACTIVE')`;
    const attempt = (value: string) => callRoute(auth.POST, '/api/auth', null, { action: 'login', email, password: value });
    expect((await attempt(password)).status).toBe(200);
    for (let index = 0; index < 10; index += 1) expect((await attempt('wrong-password-000')).body.error).toBe('The email or password is not correct.');
    const locked = await attempt(password);
    expect(locked.status).toBe(400);
    expect(locked.body.error).toBe('Too many sign-in attempts for this email. Try again in 15 minutes, or continue with X or Google.');
    // Only this address waits.
    await sql`update app.sign_in_attempts set created_at=now() - interval '16 minutes' where created_at > now() - interval '1 minute'
      and email_hash = (select email_hash from app.sign_in_attempts order by id desc limit 1)`;
    expect((await attempt(password)).status).toBe(200);
  });
});
