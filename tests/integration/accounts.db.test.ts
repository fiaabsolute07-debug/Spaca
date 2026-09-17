import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, accountForX, callRoute, continueWithX, createPublishedService, createUser, key, runId, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const xStart = await import('@/app/api/auth/x/route');
const xCallback = await import('@/app/api/x/callback/route');
const funding = await import('@/modules/payments/funding');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const xName = () => `a${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const signup = (username: string, role: string) => continueWithX({ start: xStart.POST, callback: xCallback.GET }, { intent: 'signup', username, role });
const brief = 'Account separation brief with the audience, the goal and three headline options.';

beforeEach(() => {
  if (RUN_DB) funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_accounts_suite_secret_1'] }));
});
afterAll(async () => {
  if (RUN_DB) {
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('Separate buyer and creator accounts (drizzle/0019)', () => {
  it('sign-up creates exactly one account type and never grants anything else from the form', async () => {
    const creator = xName();
    expect((await signup(creator, 'creator')).error).toBeNull();
    expect((await accountForX(creator))!.roles).toEqual(['creator']);
    const buyer = xName();
    expect((await signup(buyer, 'buyer')).error).toBeNull();
    expect((await accountForX(buyer))!.roles).toEqual(['buyer']);

    // Anything else is refused before X is even asked, and no account is made.
    for (const role of ['', 'admin', 'buyer,creator']) {
      const username = xName();
      const refused = await signup(username, role);
      expect(refused.startedAt.pathname).toBe('/sign-up');
      expect(refused.startedAt.searchParams.get('error')).toBe('Choose Buyer or Creator first.');
      expect(await accountForX(username)).toBeNull();
    }
  });

  it('a creator account sells but cannot hire; a buyer account hires but cannot sell', async () => {
    const creator = await createUser('sell-only', ['creator']);
    const buyer = await createUser('hire-only', ['buyer']);

    const { serviceId } = await createPublishedService(command, creator);
    const creatorBooks = await command(creator, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, accept_terms: 'on' });
    expect(creatorBooks.status).toBe(403);
    expect(String(creatorBooks.body.error)).toMatch(/needs a buyer account/);
    const creatorPostsBrief = await command(creator, { command: 'create_request', idempotency_key: key('req'), title: 'Not allowed',
      brief: 'A creator account should not be able to post a campaign brief here.', taxonomy: 'CREATE', budget: '500', target_hires: '1' });
    expect(creatorPostsBrief.status).toBe(403);

    const buyerSells = await command(buyer, { command: 'create_service', idempotency_key: key('svc'), title: 'Not allowed', description: 'A buyer account should not list services.', taxonomy: 'CREATE', price: '100', turnaround_hours: '24' });
    expect(buyerSells.status).toBe(403);
    expect(String(buyerSells.body.error)).toMatch(/needs a creator account/);
    expect((await command(buyer, { command: 'apply', idempotency_key: key('apply'), request_id: randomUUID(), quote: '100', turnaround_hours: '24', note: 'Not allowed' })).status).toBe(403);
    expect((await sql`select 1 from app.services where creator_id=${buyer.id}`).length).toBe(0);

    // Both sides keep working on the order they share, and on their own profile.
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, accept_terms: 'on' });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    const orderId = String(booked.body.id);
    expect((await command(creator, { command: 'message', idempotency_key: key('msg'), order_id: orderId, body: 'Thanks, starting soon.' })).status).toBe(200);
    expect((await command(buyer, { command: 'message', idempotency_key: key('msg'), order_id: orderId, body: 'Great.' })).status).toBe(200);
    expect((await command(buyer, { command: 'update_profile', idempotency_key: key('p'), display_name: 'Hire Only', handle: `hire-${buyer.id.slice(0, 8)}`, bio: 'We hire creators.' })).status).toBe(200);
  });

  it('the database refuses a real account holding both roles; local test accounts may keep both', async () => {
    const email = `it-${runId}-both-${randomUUID().slice(0, 6)}@example.test`;
    await expect(sql`insert into app.users (email,display_name,roles,is_test,status) values (${email},'Both',${['buyer', 'creator']},false,'ACTIVE')`)
      .rejects.toThrow(/users_single_account_type/);
    const [real] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'Buyer',${['buyer']},false,'ACTIVE') returning id`;
    await expect(sql`update app.users set roles=${['buyer', 'creator']} where id=${real!.id}`).rejects.toThrow(/users_single_account_type/);
    const dual = await createUser('legacy-dual', ['buyer', 'creator']);
    expect((await sql<{ roles: string[] }[]>`select roles from app.users where id=${dual.id}`)[0]!.roles).toEqual(['buyer', 'creator']);
  });
});
