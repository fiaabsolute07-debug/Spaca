import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockGoogleProvider, mockGoogleCode, mockGoogleProfile } from '@/modules/google/provider';
import { MockXProvider } from '@/modules/x/provider';
import { ORIGIN, RUN_DB, callRoute, continueWithX, createUser, key, sessionState, signUpWithX, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const googleStart = await import('@/app/api/auth/google/route');
const googleCallback = await import('@/app/api/auth/google/callback/route');
const xStart = await import('@/app/api/auth/x/route');
const xCallback = await import('@/app/api/x/callback/route');
const googleProvider = await import('@/modules/google/provider');
const xProvider = await import('@/modules/x/provider');
const { sql } = await import('@/lib/db');

const X = { start: xStart.POST, callback: xCallback.GET };
const gmail = () => `it.${randomUUID().slice(0, 8)}@gmail.com`;
const command = (actor: TestUser, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);

type Result = { location: URL; state: string; error: string | null; message: string | null };

/** Start (Connect Google when `actor` is given, otherwise Continue with Google), choose `email` on sandbox Google, come back. */
async function google(actor: TestUser | null, email: string, options: { code?: string; callbackActor?: TestUser | null; returnTo?: string } = {}): Promise<Result> {
  const form = new FormData();
  form.set('intent', actor ? 'connect' : 'signin');
  form.set('return_to', options.returnTo ?? (actor ? '/settings/profile' : '/explore'));
  sessionState.token = actor?.token ?? null;
  const started = await googleStart.POST(new Request(`${ORIGIN}/api/auth/google`, { method: 'POST', headers: { origin: ORIGIN }, body: form }));
  const state = new URL(started.headers.get('location') ?? '/', ORIGIN).searchParams.get('state') ?? '';
  return back(state, options.code ?? mockGoogleCode(email), options.callbackActor === undefined ? actor : options.callbackActor);
}

async function back(state: string, code: string, actor: TestUser | null): Promise<Result> {
  sessionState.token = actor?.token ?? null;
  const response = await googleCallback.GET(new Request(`${ORIGIN}/api/auth/google/callback?${new URLSearchParams({ state, ...(code ? { code } : { error: 'access_denied' }) })}`));
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const location = new URL(response.headers.get('location') ?? '/', ORIGIN);
  return { location, state, error: location.searchParams.get('error'), message: location.searchParams.get('message') };
}

const googleOf = async (userId: string) => (await sql`select source,subject,email from app.user_identities where user_id=${userId} and provider='GOOGLE'`)[0];

beforeEach(() => {
  if (!RUN_DB) return;
  googleProvider.setGoogleProviderForTests(new MockGoogleProvider());
  xProvider.setXProviderForTests(new MockXProvider());
});
afterAll(async () => {
  if (!RUN_DB) return;
  googleProvider.setGoogleProviderForTests(undefined);
  xProvider.setXProviderForTests(undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('Connect Google and Continue with Google (drizzle/0036)', () => {
  it('an account made with X connects Google from settings, then signs in with it; an unknown Google account is sent to sign-up with X', async () => {
    const { actor } = await signUpWithX(X, 'creator');
    const email = gmail();
    const connected = await google(actor!, email);
    expect(connected.error).toBeNull();
    expect(connected.location.pathname).toBe('/settings/profile');
    expect(connected.message).toBe(`Google account ${email} connected. You can now sign in with Google.`);
    expect(await googleOf(actor!.id)).toMatchObject({ source: 'MOCK', subject: mockGoogleProfile(email).sub, email });
    // Only Google's account id and verified address are kept; the account's own email stays unset.
    expect((await sql`select email from app.users where id=${actor!.id}`)[0]?.email).toBeNull();

    const signIn = await google(null, email);
    expect(signIn.error).toBeNull();
    expect(signIn.location.pathname).toBe('/welcome');
    expect(signIn.location.searchParams.get('return_to')).toBe('/explore');
    expect((await sql`select last_sign_in_at from app.user_identities where user_id=${actor!.id} and provider='GOOGLE'`)[0]?.last_sign_in_at).not.toBeNull();

    const stranger = gmail();
    const unknown = await google(null, stranger);
    expect(unknown.location.pathname).toBe('/sign-up');
    expect(unknown.error).toBe(`No spaca account signs in with ${stranger} yet. Sign up with X, then connect Google from your account settings.`);
  });

  it('one Google account stays with one spaca account; connecting another Google account replaces the first', async () => {
    const owner = (await signUpWithX(X, 'buyer')).actor!;
    const other = await createUser('google-other', ['creator']);
    const email = gmail();
    expect((await google(owner, email)).error).toBeNull();
    const taken = await google(other, email);
    expect(taken.error).toBe(`${email} is already connected to another spaca account. Contact support if it is yours.`);
    expect(await googleOf(other.id)).toBeUndefined();

    const second = gmail();
    expect((await google(owner, second)).error).toBeNull();
    expect((await googleOf(owner.id))?.email).toBe(second);
    // The first address is free again and no longer signs in.
    expect((await google(null, email)).error).toMatch(/^No spaca account signs in with/);
  });

  it('a connection belongs to the account that started it; cancelled, reused and cross-site attempts change nothing', async () => {
    const owner = (await signUpWithX(X, 'creator')).actor!;
    const intruder = await createUser('google-intruder', ['buyer']);
    const hijack = await google(owner, gmail(), { callbackActor: intruder });
    expect(hijack.error).toMatch(/expired or was already used/);
    expect(await googleOf(owner.id)).toBeUndefined();
    expect(await googleOf(intruder.id)).toBeUndefined();

    const cancelled = await google(owner, gmail(), { code: '' });
    expect(cancelled.error).toBe('Google sign-in was cancelled. Nothing was connected.');

    const email = gmail();
    const done = await google(owner, email);
    expect((await back(done.state, mockGoogleCode(gmail()), owner)).error).toMatch(/expired or was already used/);
    expect((await googleOf(owner.id))?.email).toBe(email);

    const form = new FormData();
    form.set('intent', 'signin');
    expect((await googleStart.POST(new Request(`${ORIGIN}/api/auth/google`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: form }))).status).toBe(403);
    // Connecting needs a signed-in account.
    const anonymous = new FormData();
    anonymous.set('intent', 'connect');
    sessionState.token = null;
    const redirected = await googleStart.POST(new Request(`${ORIGIN}/api/auth/google`, { method: 'POST', headers: { origin: ORIGIN }, body: anonymous }));
    expect(new URL(redirected.headers.get('location')!, ORIGIN).pathname).toBe('/sign-in');
  });

  it('whichever of X, Google and email is left last cannot be disconnected', async () => {
    const { actor, username } = await signUpWithX(X, 'creator');
    const email = gmail();
    expect((await google(actor!, email)).error).toBeNull();

    // Google keeps a way in, so X can go; then Google is the last way in and stays.
    expect((await command(actor!, { command: 'disconnect_x', idempotency_key: key('x-off') })).status).toBe(200);
    expect((await continueWithX(X, { intent: 'signin', username })).error).toMatch(/^No spaca account signs in with/);
    const last = await command(actor!, { command: 'disconnect_google', idempotency_key: key('g-off') });
    expect(last.status).toBe(422);
    expect(last.body.error).toBe('Google is how you sign in to this account. Connect X or add an email and password first, then disconnect Google.');
    expect((await google(null, email)).error).toBeNull();

    // An account that still has X can drop Google.
    const other = (await signUpWithX(X, 'buyer')).actor!;
    const otherEmail = gmail();
    expect((await google(other, otherEmail)).error).toBeNull();
    const dropped = await command(other, { command: 'disconnect_google', idempotency_key: key('g-off') });
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);
    expect(dropped.body.message).toBe(`${otherEmail} disconnected. It no longer signs in to this account.`);
    expect((await google(null, otherEmail)).error).toMatch(/^No spaca account signs in with/);
    expect((await command(other, { command: 'disconnect_google', idempotency_key: key('g-off') })).status).toBe(404);
  });
});
