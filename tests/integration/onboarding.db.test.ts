import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { ORIGIN, RUN_DB, callRoute, commandInstant, continueWithX, createPublishedService, createUser, key, sessionState, signUpWithX, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const xStart = await import('@/app/api/auth/x/route');
const xCallback = await import('@/app/api/x/callback/route');
const intents = await import('@/app/api/assets/upload-intents/route');
const finalizeRoute = await import('@/app/api/assets/[id]/finalize/route');
const devUpload = await import('@/app/api/dev/storage/upload/[token]/route');
const funding = await import('@/modules/payments/funding');
const storage = await import('@/modules/storage/provider');
const { sql } = await import('@/lib/db');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('IHDR onboarding suite logo pixels')]);
let root = '';

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const X_ROUTES = { start: xStart.POST, callback: xCallback.GET };

/** Sign-up with sandbox X through the real routes, then a session for the new account. */
async function signUp(role: 'buyer' | 'creator', returnTo?: string) {
  const result = await signUpWithX(X_ROUTES, role, undefined, returnTo);
  expect(result.user, result.error ?? '').not.toBeNull();
  return { ...result, user: result.user!, actor: result.actor! };
}

async function avatar(actor: TestUser): Promise<string> {
  const intent = await callRoute(intents.POST, '/api/assets/upload-intents', actor, { purpose: 'AVATAR', filename: 'logo.png', mime: 'image/png', size: String(PNG.byteLength) });
  expect(intent.status, JSON.stringify(intent.body)).toBe(200);
  const { url } = intent.body.upload as { url: string };
  const put = await devUpload.PUT(new Request(`${ORIGIN}${url}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Blob([PNG.slice()]) }), params({ token: url.split('/').pop()! }));
  expect(put.status).toBe(200);
  const done = await callRoute((request) => finalizeRoute.POST(request, params({ id: String(intent.body.id) })), `/api/assets/${String(intent.body.id)}/finalize`, actor, {});
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return String(intent.body.id);
}

const setup = (actor: TestUser, fields: Record<string, string>) => command(actor, { command: 'complete_onboarding', idempotency_key: key('onboard'), ...fields });
const INTRO = 'We are building a restaking protocol and open our public testnet in October.';
const campaign = (buyer: TestUser) => command(buyer, {
  command: 'create_request', idempotency_key: key('req'), title: 'Testnet launch thread', brief: 'We need a launch thread and two follow-up posts for our public testnet.',
  taxonomy: 'CREATE', budget: '500', per_creator_cap: '300', target_hires: '1', deadline: commandInstant(new Date(Date.now() + 7 * 24 * 3600 * 1000)),
});

beforeAll(async () => {
  if (RUN_DB) root = await mkdtemp(join(tmpdir(), 'cm-onboarding-it-'));
});
beforeEach(() => {
  if (!RUN_DB) return;
  storage.setStorageProviderForTests(new storage.LocalStorageProvider({ root, secret: 'onboarding_suite_signing_secret_01' }));
  funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_onboarding_suite_secret_1'] }));
});
afterAll(async () => {
  if (!RUN_DB) return;
  storage.setStorageProviderForTests(undefined);
  funding.setMockPaymentProviderForTests(undefined);
  await rm(root, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('Account setup after sign-up (drizzle/0031)', () => {
  it('sign-up with X takes the X name, starts at setup, and keeps where the person was going', async () => {
    const plain = await signUp('creator');
    expect(plain.response.status).toBe(303);
    expect(plain.location.pathname).toBe('/welcome');
    expect(plain.message).toBe(`Signed up with X as @${plain.username}.`);
    expect(plain.user.onboarded_at).toBeNull();
    expect(plain.user.display_name).toBe(plain.username[0]!.toUpperCase() + plain.username.slice(1));

    const going = await signUp('buyer', '/buyer/requests/new?goal=launch');
    expect(going.location.pathname).toBe('/welcome');
    expect(going.location.searchParams.get('return_to')).toBe('/buyer/requests/new?goal=launch');

    // Signing in again before setup goes back to setup.
    const again = await continueWithX(X_ROUTES, { intent: 'signin', username: going.username, returnTo: '/explore' });
    expect(again.location.pathname).toBe('/welcome');
    expect(again.location.searchParams.get('return_to')).toBe('/explore');
    // Accounts made any other way (fixtures, operators, accounts from before setup existed) count as set up.
    const [existing] = await sql<{ onboarded_at: Date | null }[]>`select onboarded_at from app.users where id=${(await createUser('pre-setup', ['buyer'])).id}`;
    expect(existing!.onboarded_at).not.toBeNull();
  });

  it('what others would see waits for setup: posting a campaign, applying, publishing a service', async () => {
    const { actor: buyer } = await signUp('buyer');
    const posted = await campaign(buyer);
    expect(posted.status).toBe(422);
    expect(String(posted.body.error)).toBe('Finish setting up your project first: add a logo, the project name and a short introduction.');

    const { actor: creator } = await signUp('creator');
    const applied = await command(creator, { command: 'apply', idempotency_key: key('apply'), request_id: randomUUID(), quote: '100', turnaround_hours: '24', note: 'Not yet.' });
    expect(String(applied.body.error)).toMatch(/^Finish setting up your profile first/);
    const published = await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: randomUUID() });
    expect(String(published.body.error)).toMatch(/^Finish setting up your profile first/);
    // Looking around and private work are not blocked.
    const drafted = await command(creator, { command: 'create_service', idempotency_key: key('svc'), title: 'Launch thread', description: 'One launch thread with a clear call to action.', taxonomy: 'CREATE', price: '100', turnaround_hours: '24' });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(200);
  });

  it('setup asks for a logo, name, one line and an introduction; a buyer gets a handle from the project name', async () => {
    const { actor: buyer } = await signUp('buyer');
    const base = { display_name: 'Arcadia Protocol', headline: 'A restaking protocol opening its public testnet', bio: INTRO, next: '/buyer/requests/new' };

    expect((await setup(buyer, base)).body.error).toBe('Add your project logo');
    const logo = await avatar(buyer);
    expect((await setup(buyer, { ...base, asset_ids: logo, display_name: ' ' })).body.error).toBe('Add the project name');
    expect((await setup(buyer, { ...base, asset_ids: logo, bio: 'Too short.' })).body.error).toBe('Write at least 40 characters in the introduction');
    expect((await setup(buyer, { ...base, asset_ids: logo, link: 'javascript:alert(1)' })).body.error).toMatch(/must start with http/);
    const other = await createUser('not-mine', ['buyer']);
    expect((await setup(other, { ...base, asset_ids: logo })).status).toBe(404);
    // Nothing was saved by the refusals, and a buyer's sign-up seeds no profile from X: the project names itself.
    expect((await sql`select 1 from app.profiles where user_id=${buyer.id}`).length).toBe(0);

    const form = new FormData();
    for (const [name, value] of Object.entries({ ...base, command: 'complete_onboarding', idempotency_key: key('onboard'), asset_ids: logo, link: '@arcadiaxyz' })) form.set(name, value);
    form.append('focus', 'DeFi');
    form.append('focus', 'Infrastructure');
    form.append('focus', 'Not a real focus');
    sessionState.token = buyer.token;
    const response = await commands.POST(new Request(`${ORIGIN}/api/commands`, { method: 'POST', headers: { origin: ORIGIN, accept: 'application/json' }, body: form }));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ path: '/buyer/requests/new', message: 'Your project profile is ready' });

    const [saved] = await sql`select u.display_name,u.onboarded_at,p.handle,p.headline,p.bio,p.niche,p.social_url,p.avatar_asset_id
      from app.users u join app.profiles p on p.user_id=u.id where u.id=${buyer.id}`;
    expect(saved).toMatchObject({ display_name: 'Arcadia Protocol', headline: base.headline, bio: INTRO, niche: 'DeFi, Infrastructure', social_url: 'https://x.com/arcadiaxyz', avatar_asset_id: logo });
    expect(String(saved!.handle)).toMatch(/^arcadia-protocol(-[0-9a-f]{4})?$/);
    expect(saved!.onboarded_at).not.toBeNull();
    expect((await campaign(buyer)).status).toBe(200);

    // A second project with the same name gets its own handle.
    const { actor: twin } = await signUp('buyer');
    expect((await setup(twin, { ...base, asset_ids: await avatar(twin) })).status).toBe(200);
    const [twinProfile] = await sql<{ handle: string }[]>`select handle from app.profiles where user_id=${twin.id}`;
    expect(twinProfile!.handle).not.toBe(saved!.handle);
    expect(twinProfile!.handle).toMatch(/^arcadia-protocol-[0-9a-f]{4}$/);
  });

  it('a creator chooses a handle; a taken handle or an unsafe return path is refused or ignored', async () => {
    const taken = await createUser('handle-owner', ['creator']);
    const takenHandle = `taken-${randomUUID().slice(0, 8)}`;
    await sql`insert into app.profiles (user_id,handle) values (${taken.id},${takenHandle})`;
    const { actor: creator } = await signUp('creator');
    const photo = await avatar(creator);
    const base = { asset_ids: photo, display_name: 'Linh Tran', headline: 'Launch threads for DeFi teams', bio: 'I write launch threads for L2 testnets and host a weekly Spaces on restaking.' };

    expect((await setup(creator, { ...base, handle: 'x' })).body.error).toMatch(/^Your handle needs 3–32/);
    expect((await setup(creator, { ...base, handle: takenHandle })).body.error).toBe('That handle is already taken');
    const handle = `linh-${randomUUID().slice(0, 8)}`;
    const done = await setup(creator, { ...base, handle, next: '//evil.example/steal' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ path: '/dashboard', message: 'Your creator profile is ready' });
    const [profile] = await sql<{ handle: string; niche: string }[]>`select handle,niche from app.profiles where user_id=${creator.id}`;
    expect(profile).toEqual({ handle, niche: 'Independent creator' });

    // Set up, the creator can now apply and publish like anyone else.
    const { serviceId } = await createPublishedService(command, creator);
    expect(serviceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
