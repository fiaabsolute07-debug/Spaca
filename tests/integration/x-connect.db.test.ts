import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { MockXProvider, XProviderError, mockProfile, type XProvider } from '@/modules/x/provider';
import { ORIGIN, RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const connectRoute = await import('@/app/api/x/connect/route');
const callbackRoute = await import('@/app/api/x/callback/route');
const refreshRoute = await import('@/app/api/x/refresh/route');
const seenRoute = await import('@/app/api/x/seen/route');
const funding = await import('@/modules/payments/funding');
const provider = await import('@/modules/x/provider');
const service = await import('@/modules/x/service');
const { getExploreData } = await import('@/lib/read-model');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
/** A sandbox username unique to this run (X usernames are at most 15 characters). */
const username = () => `t${randomUUID().replaceAll('-', '').slice(0, 12)}`;

type Redirect = { status: number; location: URL; notice: string | null; error: string | null };
const redirectOf = (response: Response): Redirect => {
  const location = new URL(response.headers.get('location') ?? '/', ORIGIN);
  return { status: response.status, location, notice: location.searchParams.get('message'), error: location.searchParams.get('error') };
};

async function startConnect(actor: TestUser, returnTo = '/settings/profile'): Promise<Redirect> {
  const form = new FormData();
  form.set('return_to', returnTo);
  sessionState.token = actor.token;
  return redirectOf(await connectRoute.POST(new Request(`${ORIGIN}/api/x/connect`, { method: 'POST', headers: { origin: ORIGIN }, body: form })));
}

async function callback(actor: TestUser, params: Record<string, string>): Promise<Redirect> {
  sessionState.token = actor.token;
  const response = await callbackRoute.GET(new Request(`${ORIGIN}/api/x/callback?${new URLSearchParams(params).toString()}`));
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  return redirectOf(response);
}

/** Connect through the sandbox the way the browser does: start, "authorize", come back. */
async function connect(actor: TestUser, name: string, returnTo?: string) {
  const started = await startConnect(actor, returnTo);
  const state = started.location.searchParams.get('state') ?? '';
  return { state, result: await callback(actor, { state, code: `mock.${name}` }) };
}

const profileOf = async (userId: string) => (await sql`select * from app.x_profiles where user_id=${userId}`)[0];
const usage = async (userId: string | null = null) => Number((await sql`select coalesce(sum(resources),0)::int as n from app.x_api_usage
  where source='MOCK' and (${userId}::uuid is null or user_id=${userId})`)[0]!.n);

const DAY = Date.parse('2026-09-17T09:00:00Z');
let lookups: { xUserId: string; username: string }[][] = [];

beforeEach(() => {
  if (!RUN_DB) return;
  lookups = [];
  const mock = new MockXProvider(() => DAY);
  const counting: XProvider = {
    source: 'MOCK',
    authorizeUrl: (input) => mock.authorizeUrl(input),
    signedInProfile: async (input) => {
      // "private_*" stands for an account the owner made protected.
      const match = /^mock\.(private_\w+)$/.exec(input.code);
      return match ? { ...mockProfile(match[1]!, DAY), protected: true } : mock.signedInProfile(input);
    },
    lookup: async (accounts) => {
      lookups.push(accounts);
      if (accounts.some((account) => account.username.startsWith('ratelimit'))) throw new XProviderError('X is limiting requests right now. Try again later.', 'RATE_LIMITED');
      return mock.lookup(accounts);
    },
  };
  provider.setXProviderForTests(counting);
  // The test database keeps usage from earlier runs this month; only the ceiling test uses a real limit.
  vi.stubEnv('X_READS_MONTHLY_CAP', '3000000');
  funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_x_connect_suite_secret_1'] }));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (!RUN_DB) return;
  provider.setXProviderForTests(undefined);
  funding.setMockPaymentProviderForTests(undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('Connect X (drizzle/0032)', () => {
  it('a creator connects once: one read, a saved copy, and the linked X account marked verified', async () => {
    const creator = await createUser('x-creator', ['creator']);
    const name = username();
    const started = await startConnect(creator, '/welcome');
    expect(started.status).toBe(303);
    expect(started.location.pathname).toBe('/dev/x-authorize');
    const state = started.location.searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only a hash of the state is stored.
    expect((await sql`select 1 from app.x_oauth_states where state_hash=${state}`).length).toBe(0);

    const done = await callback(creator, { state, code: `mock.${name}` });
    expect(done.location.pathname).toBe('/welcome');
    expect(done.notice).toBe(`X account @${name} connected.`);
    const saved = await profileOf(creator.id);
    expect(saved).toMatchObject({ source: 'MOCK', username: name, name: expect.any(String), profile_image_url: `/api/dev/x/avatar/${name}`, refresh_requested_at: null, unavailable_at: null });
    expect(Number(saved!.followers_count)).toBe(mockProfile(name, DAY).followers);
    expect(await usage(creator.id)).toBe(1);
    const [linked] = await sql`select handle,canonical_url,verification_status,verification_method,verified_by from app.social_accounts where id=${saved!.social_account_id}`;
    expect(linked).toEqual({ handle: name, canonical_url: `https://x.com/${name}`, verification_status: 'VERIFIED', verification_method: 'X_OAUTH', verified_by: creator.id });

    // The same sign-in cannot be used twice.
    const replay = await callback(creator, { state, code: `mock.${name}` });
    expect(replay.error).toBe('This X sign-in expired or was already used. Start again from your profile.');
    expect(await usage(creator.id)).toBe(1);
  });

  it('refuses sign-ins that are not this account’s, cancelled, expired, protected or already someone else’s', async () => {
    const creator = await createUser('x-owner', ['creator']);
    const other = await createUser('x-other', ['creator']);
    const buyer = await createUser('x-buyer', ['buyer']);

    const buyerTry = await startConnect(buyer);
    expect(buyerTry.error).toBe('Connecting X is for creator accounts');

    const started = await startConnect(creator);
    const stolen = await callback(other, { state: started.location.searchParams.get('state')!, code: `mock.${username()}` });
    expect(stolen.error).toMatch(/^This X sign-in expired or was already used/);
    expect(await profileOf(other.id)).toBeUndefined();

    const cancelled = await startConnect(creator);
    expect((await callback(creator, { state: cancelled.location.searchParams.get('state')!, error: 'access_denied' })).error).toBe('X sign-in was cancelled. Nothing was connected.');

    const expired = await startConnect(creator);
    await sql`update app.x_oauth_states set expires_at=now() - interval '1 minute' where user_id=${creator.id} and used_at is null`;
    expect((await callback(creator, { state: expired.location.searchParams.get('state')!, code: `mock.${username()}` })).error).toMatch(/^This X sign-in expired/);

    const locked = await connect(creator, `private_${randomUUID().slice(0, 6)}`);
    expect(locked.result.error).toMatch(/is a protected account/);
    expect(await profileOf(creator.id)).toBeUndefined();

    const shared = username();
    expect((await connect(creator, shared)).result.notice).toBe(`X account @${shared} connected.`);
    const second = await connect(other, shared);
    expect(second.result.error).toBe(`@${shared} is already connected to another spaca account. Contact support if it is yours.`);
    expect(await profileOf(other.id)).toBeUndefined();

    // A handle another creator listed as their own (self-reported) is not taken over silently.
    const claimed = username();
    expect((await command(other, { command: 'add_social_account', idempotency_key: key('x-claim'), platform: 'X', account: `@${claimed}` })).status).toBe(200);
    expect((await connect(creator, claimed)).result.error).toBe(`Another spaca account listed @${claimed} as its own. Contact support if this X account is yours.`);
  });

  it('connecting verifies a handle the creator already listed; disconnecting keeps it, self-reported again', async () => {
    const creator = await createUser('x-listed', ['creator']);
    const name = username();
    const added = await command(creator, { command: 'add_social_account', idempotency_key: key('x-list'), platform: 'X', account: `https://x.com/${name}` });
    expect(added.status).toBe(200);
    expect((await connect(creator, name)).result.notice).toMatch(/connected/);
    const [row] = await sql`select id,verification_status from app.social_accounts where creator_id=${creator.id} and removed_at is null`;
    expect(row).toEqual({ id: added.body.id, verification_status: 'VERIFIED' });

    const gone = await command(creator, { command: 'disconnect_x', idempotency_key: key('x-off') });
    expect(gone.body).toMatchObject({ message: `@${name} disconnected. The linked account shows as self-reported again.` });
    expect(await profileOf(creator.id)).toBeUndefined();
    const [after] = await sql`select verification_status,verified_at,verification_method from app.social_accounts where id=${added.body.id as string}`;
    expect(after).toEqual({ verification_status: 'SELF_REPORTED', verified_at: null, verification_method: null });
    expect((await command(creator, { command: 'disconnect_x', idempotency_key: key('x-off') })).status).toBe(404);
  });

  it('buyers viewing never read X; an old copy is queued once and refreshed in one batched lookup', async () => {
    const fresh = await createUser('x-fresh', ['creator']);
    const stale = await createUser('x-stale', ['creator']);
    const gone = await createUser('x-gone', ['creator']);
    await connect(fresh, username());
    await connect(stale, username());
    await connect(gone, `gone_${randomUUID().slice(0, 8)}`);
    await sql`update app.x_profiles set fetched_at=now() - interval '9 days',followers_count=1 where user_id in (${stale.id},${gone.id})`;
    // Copies queued by earlier runs would join this batch.
    await sql`update app.x_profiles set refresh_requested_at=null where refresh_requested_at is not null`;
    const before = await usage();

    const seen = (creatorId: string) => callRoute(seenRoute.POST, '/api/x/seen', null, { creator_id: creatorId });
    expect((await seen(fresh.id)).body).toEqual({ queued: false });
    expect((await seen(stale.id)).body).toEqual({ queued: true });
    expect((await seen(stale.id)).body).toEqual({ queued: false });
    expect((await seen(gone.id)).body).toEqual({ queued: true });
    expect((await seen('not-a-uuid')).body).toEqual({ queued: false });
    expect(lookups).toHaveLength(0);
    expect(await usage()).toBe(before);

    // The explore read model shows the saved copy and says whether it is due.
    const { serviceId } = await createPublishedService(command, stale);
    const explore = await getExploreData({ selected: serviceId, sort: 'newest' });
    const item = explore.items.find((entry) => String(entry.id) === serviceId);
    expect(item?.x).toMatchObject({ source: 'MOCK', followers: 1, refreshDue: false });

    const report = await service.refreshRequestedXProfiles();
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.map((account) => account.xUserId).sort()).toEqual([String((await profileOf(stale.id))!.x_user_id), String((await profileOf(gone.id))!.x_user_id)].sort());
    expect(report.outcomes).toMatchObject({ REFRESHED: 1, UNAVAILABLE: 1 });
    const refreshed = await profileOf(stale.id);
    expect(Number(refreshed!.followers_count)).toBeGreaterThan(1);
    expect(refreshed!.refresh_requested_at).toBeNull();
    expect((await profileOf(gone.id))!.unavailable_at).not.toBeNull();
    // X bills the profiles it returned: one.
    expect(await usage()).toBe(before + 1);
    expect((await service.refreshRequestedXProfiles()).examined).toBe(0);
  });

  it('stops reading X at the monthly ceiling and keeps failures for a later retry', async () => {
    const creator = await createUser('x-cap', ['creator']);
    await connect(creator, username());
    await sql`update app.x_profiles set fetched_at=now() - interval '30 days',refresh_requested_at=now() where user_id=${creator.id}`;
    vi.stubEnv('X_READS_MONTHLY_CAP', String(await usage()));
    const capped = await service.refreshRequestedXProfiles();
    expect(capped.outcomes.SKIPPED_MONTHLY_CAP).toBeGreaterThanOrEqual(1);
    expect(lookups).toHaveLength(0);
    const blocked = await startConnect(await createUser('x-cap-new', ['creator']));
    expect(blocked.error).toMatch(/^X reads are paused until next month/);
    vi.stubEnv('X_READS_MONTHLY_CAP', '3000000');

    const limited = await createUser('x-limited', ['creator']);
    await connect(limited, `ratelimit${randomUUID().slice(0, 5)}`);
    await sql`update app.x_profiles set refresh_requested_at=null where refresh_requested_at is not null and user_id<>${limited.id}`;
    await sql`update app.x_profiles set fetched_at=now() - interval '30 days',refresh_requested_at=now() where user_id=${limited.id}`;
    const failed = await service.refreshRequestedXProfiles();
    expect(failed.outcomes).toEqual({ FAILED: 1 });
    expect(await profileOf(limited.id)).toMatchObject({ refresh_failures: 1, last_refresh_error: 'X is limiting requests right now. Try again later.' });
    expect((await profileOf(limited.id))!.refresh_requested_at).not.toBeNull();
  });

  it('the creator can refresh their own profile at most once a day', async () => {
    const creator = await createUser('x-own', ['creator']);
    await connect(creator, username());
    const post = async () => {
      sessionState.token = creator.token;
      return redirectOf(await refreshRoute.POST(new Request(`${ORIGIN}/api/x/refresh`, { method: 'POST', headers: { origin: ORIGIN }, body: new FormData() })));
    };
    expect((await post()).error).toBe('Your X profile was updated less than a day ago. You can refresh again in 24 hours.');
    await sql`update app.x_profiles set fetched_at=now() - interval '25 hours',followers_count=2 where user_id=${creator.id}`;
    expect((await post()).notice).toBe('X profile updated');
    expect(Number((await profileOf(creator.id))!.followers_count)).toBeGreaterThan(2);
    expect(await usage(creator.id)).toBe(2);
    expect(await service.hoursUntilOwnRefresh(creator.id)).toBe(24);
  });
});
