import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockXProvider, mockProfile, type XProvider } from '@/modules/x/provider';
import { ORIGIN, RUN_DB, accountForX, callRoute, continueWithX, createUser, key, sessionState, signUpWithX, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const auth = await import('@/app/api/auth/route');
const xStart = await import('@/app/api/auth/x/route');
const xCallback = await import('@/app/api/x/callback/route');
const connectRoute = await import('@/app/api/x/connect/route');
const provider = await import('@/modules/x/provider');
const { sql } = await import('@/lib/db');

const X = { start: xStart.POST, callback: xCallback.GET };
const xName = () => `s${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const command = (actor: TestUser, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const PASSWORD = 'a-long-local-password';
const identitiesOf = async (userId: string) => (await sql`select provider,source,subject from app.user_identities where user_id=${userId}`).map((row) => ({ ...row }));

beforeEach(() => {
  if (!RUN_DB) return;
  const mock = new MockXProvider();
  const withProtected: XProvider = {
    source: 'MOCK',
    authorizeUrl: (input) => mock.authorizeUrl(input),
    // "private_*" stands for a protected X account.
    signedInProfile: async (input) => {
      const match = /^mock\.(private_\w+)$/.exec(input.code);
      return match ? { ...mockProfile(match[1]!), protected: true } : mock.signedInProfile(input);
    },
    lookup: (accounts) => mock.lookup(accounts),
  };
  provider.setXProviderForTests(withProtected);
  vi.stubEnv('X_READS_MONTHLY_CAP', '3000000');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (!RUN_DB) return;
  provider.setXProviderForTests(undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('Sign up and sign in with X (drizzle/0035)', () => {
  it('sign-up with X makes an account of the chosen type with no email, its X profile and identity, and a verified linked account for creators', async () => {
    const name = xName();
    const signed = await signUpWithX(X, 'creator', name, '/explore');
    expect(signed.startedAt.pathname).toBe('/dev/x-authorize');
    expect(signed.response.status).toBe(303);
    expect(signed.response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(signed.location.pathname).toBe('/welcome');
    expect(signed.location.searchParams.get('return_to')).toBe('/explore');
    expect(signed.message).toBe(`Signed up with X as @${name}.`);
    expect(signed.user).toMatchObject({ roles: ['creator'], email: null, is_test: true, onboarded_at: null });

    const userId = signed.user!.id;
    expect(await identitiesOf(userId)).toEqual([{ provider: 'X', source: 'MOCK', subject: mockProfile(name).xUserId }]);
    expect((await sql`select username from app.x_profiles where user_id=${userId}`)[0]?.username).toBe(name);
    const [linked] = await sql`select verification_status,verification_method from app.social_accounts where creator_id=${userId} and removed_at is null`;
    expect(linked).toMatchObject({ verification_status: 'VERIFIED', verification_method: 'X_OAUTH' });
    // The state was single-use and its read was recorded, belonging to no account yet.
    expect((await sql`select used_at from app.x_oauth_states where purpose='SIGN_UP' and user_id is null and used_at is not null order by created_at desc limit 1`).length).toBe(1);

    // A buyer signed up with X keeps the X profile copy but has no linked accounts (those are for creators).
    const project = await signUpWithX(X, 'buyer');
    expect(project.user).toMatchObject({ roles: ['buyer'], email: null });
    expect((await sql`select 1 from app.x_profiles where user_id=${project.user!.id}`).length).toBe(1);
    expect((await sql`select 1 from app.social_accounts where creator_id=${project.user!.id}`).length).toBe(0);
  });

  it('an X account already on spaca signs in to it from either dialog; an unknown one is sent to sign-up', async () => {
    const name = xName();
    const first = await signUpWithX(X, 'buyer', name);
    const before = Number((await sql`select count(*)::int as n from app.users`)[0]!.n);

    const signIn = await continueWithX(X, { intent: 'signin', username: name, returnTo: '/explore' });
    expect(signIn.error).toBeNull();
    expect(signIn.location.pathname).toBe('/welcome');
    // Signing up again with the same X account signs in instead of making a second account.
    const again = await continueWithX(X, { intent: 'signup', role: 'creator', username: name });
    expect(again.message).toBe(`@${name} already has a spaca account, so you are signed in to it.`);
    expect(Number((await sql`select count(*)::int as n from app.users`)[0]!.n)).toBe(before);
    expect((await accountForX(name))!.roles).toEqual(['buyer']);
    expect((await sql`select last_sign_in_at from app.user_identities where user_id=${first.user!.id}`)[0]?.last_sign_in_at).not.toBeNull();

    const stranger = xName();
    const unknown = await continueWithX(X, { intent: 'signin', username: stranger });
    expect(unknown.location.pathname).toBe('/sign-up');
    expect(unknown.error).toBe(`No spaca account signs in with @${stranger} yet. Choose Buyer or Creator to create one.`);
    expect(await accountForX(stranger)).toBeNull();
  });

  it('cancelled, reused, forged and cross-site attempts sign nobody in', async () => {
    const cancelled = await continueWithX(X, { intent: 'signup', role: 'creator', username: xName(), code: '' });
    expect(cancelled.location.pathname).toBe('/sign-up');
    expect(cancelled.location.searchParams.get('role')).toBe('creator');

    const name = xName();
    const used = await signUpWithX(X, 'creator', name);
    const replay = await xCallback.GET(new Request(`${ORIGIN}/api/x/callback?${new URLSearchParams({ state: used.state, code: `mock.${xName()}` })}`));
    expect(new URL(replay.headers.get('location')!, ORIGIN).searchParams.get('error')).toMatch(/Start again|sign in again|expired or was already used/i);

    const forged = await xCallback.GET(new Request(`${ORIGIN}/api/x/callback?state=not-a-real-state&code=mock.${xName()}`));
    expect(new URL(forged.headers.get('location')!, ORIGIN).pathname).toBe('/sign-in');

    const form = new FormData();
    form.set('intent', 'signup');
    form.set('role', 'creator');
    expect((await xStart.POST(new Request(`${ORIGIN}/api/auth/x`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: form }))).status).toBe(403);

    // A creator needs a public X account; a protected one is refused and nothing is made.
    const hidden = `private_${randomUUID().slice(0, 6)}`;
    const refused = await continueWithX(X, { intent: 'signup', role: 'creator', username: hidden });
    expect(refused.error).toMatch(/is a protected account/);
    expect(await accountForX(hidden)).toBeNull();
  });

  it('email sign-up is gone; an email and password are added once from settings and then sign in', async () => {
    const refused = await callRoute(auth.POST, '/api/auth', null, { action: 'signup', email: `nobody-${randomUUID().slice(0, 6)}@example.test`, password: PASSWORD, role: 'buyer' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('New accounts sign up with X or Google. You can add an email and password later from your account settings.');

    const { actor, user, username } = await signUpWithX(X, 'creator');
    const email = `${username}@example.test`;
    expect((await callRoute(auth.POST, '/api/auth', actor, { action: 'add_email', email, password: 'short' })).body.error).toBe('Enter a valid email address and a password of at least 12 characters.');
    expect((await callRoute(auth.POST, '/api/auth', null, { action: 'add_email', email, password: PASSWORD })).body.error).toMatch(/Sign in first/);
    const added = await callRoute(auth.POST, '/api/auth', actor, { action: 'add_email', email, password: PASSWORD });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(String(added.body.redirect)).toMatch(/^\/settings\/profile\?message=Email\+added|^\/settings\/profile\?message=Email%20added/);
    expect((await sql`select email from app.users where id=${user!.id}`)[0]?.email).toBe(email);
    // Only once, and an email belongs to one account.
    expect((await callRoute(auth.POST, '/api/auth', actor, { action: 'add_email', email: `other-${email}`, password: PASSWORD })).body.error).toBe('This account already has an email.');
    const other = await signUpWithX(X, 'buyer');
    expect((await callRoute(auth.POST, '/api/auth', other.actor, { action: 'add_email', email: email.toUpperCase(), password: PASSWORD })).body.error).toBe('That email already belongs to another spaca account.');

    const login = await callRoute(auth.POST, '/api/auth', null, { action: 'login', email, password: PASSWORD, return_to: '/explore' });
    expect(login.body.redirect).toBe(`/welcome?return_to=${encodeURIComponent('/explore')}`);
  });

  it('X cannot be disconnected while it is the only way in; after adding an email it can, and then no longer signs in', async () => {
    const { actor, username } = await signUpWithX(X, 'creator');
    const blocked = await command(actor!, { command: 'disconnect_x', idempotency_key: key('x-off') });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe('X is how you sign in to this account. Add an email and password under Sign-in first, then disconnect X.');
    expect(await identitiesOf(actor!.id)).toHaveLength(1);

    expect((await callRoute(auth.POST, '/api/auth', actor, { action: 'add_email', email: `${username}@example.test`, password: PASSWORD })).status).toBe(200);
    expect((await command(actor!, { command: 'disconnect_x', idempotency_key: key('x-off') })).status).toBe(200);
    expect(await identitiesOf(actor!.id)).toEqual([]);
    expect((await continueWithX(X, { intent: 'signin', username })).error).toMatch(/^No spaca account signs in with/);
  });

  it('connecting X from settings also lets that account sign in with it, and one X account stays with one spaca account', async () => {
    const creator = await createUser('x-connect-signin', ['creator']);
    const name = xName();
    const form = new FormData();
    form.set('return_to', '/settings/profile');
    sessionState.token = creator.token;
    const started = await connectRoute.POST(new Request(`${ORIGIN}/api/x/connect`, { method: 'POST', headers: { origin: ORIGIN }, body: form }));
    const state = new URL(started.headers.get('location')!, ORIGIN).searchParams.get('state')!;
    sessionState.token = creator.token;
    const connected = await xCallback.GET(new Request(`${ORIGIN}/api/x/callback?${new URLSearchParams({ state, code: `mock.${name}` })}`));
    expect(new URL(connected.headers.get('location')!, ORIGIN).searchParams.get('message')).toBe(`X account @${name} connected.`);
    expect((await accountForX(name))!.id).toBe(creator.id);
    expect((await continueWithX(X, { intent: 'signin', username: name })).error).toBeNull();

    // The same X account cannot sign up a second spaca account.
    const twin = await continueWithX(X, { intent: 'signup', role: 'buyer', username: name });
    expect(twin.message).toMatch(/already has a spaca account/);
    expect((await accountForX(name))!.id).toBe(creator.id);
  });
});
