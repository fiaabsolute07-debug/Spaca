import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEnvironment } from '../../scripts/lib/env-rules';
import { compactCount, joinedLabel, updatedAgo } from '@/lib/x-profile';
import { LiveXProvider, MockXProvider, USER_FIELDS, XProviderError, codeChallengeFor, mockProfile, profileFromApi, xMode } from '@/modules/x/provider';

const API_USER = {
  id: '1580661436049203201',
  name: 'Linh Tran',
  username: 'linh_onchain',
  profile_image_url: 'https://pbs.twimg.com/profile_images/1/abc_normal.jpg',
  description: 'Threads on restaking.',
  location: 'Singapore',
  verified: false,
  verified_type: 'blue',
  protected: false,
  public_metrics: { followers_count: 12431, following_count: 820, tweet_count: 3100, listed_count: 42 },
  created_at: '2019-03-14T08:00:00.000Z',
};

type Call = { url: string; init: RequestInit };
function stubFetch(responses: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(responses).find((prefix) => String(url).startsWith(prefix));
    const response = key ? responses[key]! : { status: 404, body: {} };
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

afterEach(() => vi.unstubAllEnvs());

describe('X profile mapping', () => {
  it('keeps the fields buyers see, upgrades the photo to 400 px and drops anything off X’s image host', () => {
    expect(profileFromApi(API_USER)).toEqual({
      xUserId: '1580661436049203201', username: 'linh_onchain', name: 'Linh Tran',
      profileImageUrl: 'https://pbs.twimg.com/profile_images/1/abc_400x400.jpg',
      description: 'Threads on restaking.', location: 'Singapore', verified: true, verifiedType: 'blue', protected: false,
      followers: 12431, following: 820, posts: 3100, listed: 42, createdAt: '2019-03-14T08:00:00.000Z',
    });
    const odd = profileFromApi({ ...API_USER, profile_image_url: 'https://evil.example/a.png', verified_type: 'weird', public_metrics: { followers_count: -5, tweet_count: 1.5 }, created_at: 'nope', name: '' });
    expect(odd).toMatchObject({ profileImageUrl: null, verifiedType: null, verified: false, followers: 0, posts: 0, createdAt: null, name: 'linh_onchain' });
    expect(() => profileFromApi({ ...API_USER, id: 'abc' })).toThrow(XProviderError);
    expect(() => profileFromApi({ ...API_USER, username: 'has space' })).toThrow(XProviderError);
  });

  it('formats counts and ages the way the card shows them', () => {
    expect([950, 12_431, 1_250_000].map(compactCount)).toEqual(['950', '12.4K', '1.3M']);
    const now = Date.parse('2026-09-17T12:00:00Z');
    expect(updatedAgo('2026-09-17T01:00:00Z', now)).toBe('updated today');
    expect(updatedAgo('2026-09-16T01:00:00Z', now)).toBe('updated yesterday');
    expect(updatedAgo('2026-09-10T12:00:00Z', now)).toBe('updated 7 days ago');
    expect(updatedAgo('2026-07-01T12:00:00Z', now)).toBe('updated 2 months ago');
    expect(joinedLabel('2019-03-14T08:00:00.000Z')).toBe('Mar 2019');
  });

  it('uses the S256 PKCE challenge from RFC 7636', () => {
    expect(codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('LiveXProvider (api.x.com, fetch stubbed)', () => {
  const redirectUri = 'https://spaca.example/api/x/callback';

  it('asks only for users.read and tweet.read with a PKCE challenge', () => {
    const url = new URL(new LiveXProvider({ clientId: 'client-1' }).authorizeUrl({ state: 'st', codeChallenge: 'ch', redirectUri }));
    expect(`${url.origin}${url.pathname}`).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', client_id: 'client-1', redirect_uri: redirectUri, scope: 'users.read tweet.read', state: 'st', code_challenge: 'ch', code_challenge_method: 'S256' });
  });

  it('exchanges the code, reads the account once, and revokes the token without keeping it', async () => {
    const { calls, fetcher } = stubFetch({
      'https://api.x.com/2/oauth2/token': { status: 200, body: { access_token: 'user-token-123', token_type: 'bearer' } },
      'https://api.x.com/2/users/me': { status: 200, body: { data: API_USER } },
      'https://api.x.com/2/oauth2/revoke': { status: 200, body: { revoked: true } },
    });
    const provider = new LiveXProvider({ clientId: 'client-1', clientSecret: 'secret-1', fetch: fetcher });
    const profile = await provider.signedInProfile({ code: 'code-9', codeVerifier: 'verifier-9', redirectUri });
    expect(profile.username).toBe('linh_onchain');
    expect(calls.map((call) => call.url.split('?')[0])).toEqual(['https://api.x.com/2/oauth2/token', 'https://api.x.com/2/users/me', 'https://api.x.com/2/oauth2/revoke']);
    const token = calls[0]!;
    expect(Object.fromEntries(new URLSearchParams(String(token.init.body)))).toEqual({ grant_type: 'authorization_code', code: 'code-9', redirect_uri: redirectUri, code_verifier: 'verifier-9' });
    expect((token.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('client-1:secret-1').toString('base64')}`);
    expect(calls[1]!.url).toBe(`https://api.x.com/2/users/me?user.fields=${USER_FIELDS}`);
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer user-token-123');
    expect(new URLSearchParams(String(calls[2]!.init.body)).get('token')).toBe('user-token-123');
  });

  it('turns X failures into plain messages that carry no token, and still revokes when the read fails', async () => {
    const limited = stubFetch({ 'https://api.x.com/2/oauth2/token': { status: 429, body: { detail: 'Too Many Requests' } } });
    await expect(new LiveXProvider({ clientId: 'c', fetch: limited.fetcher }).signedInProfile({ code: 'x', codeVerifier: 'v', redirectUri }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', message: 'X is limiting requests right now. Try again later.' });
    // A public client sends its id in the body instead of Basic auth.
    expect(new URLSearchParams(String(limited.calls[0]!.init.body)).get('client_id')).toBe('c');

    const failedRead = stubFetch({
      'https://api.x.com/2/oauth2/token': { status: 200, body: { access_token: 'secret-token-abc' } },
      'https://api.x.com/2/users/me': { status: 401, body: { detail: 'Unauthorized secret-token-abc' } },
      'https://api.x.com/2/oauth2/revoke': { status: 200, body: {} },
    });
    const error = await new LiveXProvider({ clientId: 'c', fetch: failedRead.fetcher }).signedInProfile({ code: 'x', codeVerifier: 'v', redirectUri }).catch((caught) => caught);
    expect(error).toBeInstanceOf(XProviderError);
    expect(error.code).toBe('DENIED');
    expect(String(error.message)).not.toContain('secret-token');
    expect(failedRead.calls.at(-1)!.url).toBe('https://api.x.com/2/oauth2/revoke');
  });

  it('refreshes many accounts in one lookup with the app token and reports the ones X no longer returns', async () => {
    const { calls, fetcher } = stubFetch({ 'https://api.x.com/2/users?ids=': { status: 200, body: { data: [API_USER], errors: [{ resource_id: '42', title: 'Not Found Error' }] } } });
    const provider = new LiveXProvider({ clientId: 'c', bearerToken: 'app-bearer', fetch: fetcher });
    const result = await provider.lookup([{ xUserId: '1580661436049203201', username: 'linh_onchain' }, { xUserId: '42', username: 'gone' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.x.com/2/users?ids=1580661436049203201,42&user.fields=${USER_FIELDS}`);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer app-bearer');
    expect(result.found.map((profile) => profile.username)).toEqual(['linh_onchain']);
    expect(result.missing).toEqual(['42']);
    await expect(new LiveXProvider({ clientId: 'c', fetch: fetcher }).lookup([{ xUserId: '1', username: 'a' }])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('Sandbox X and environment selection', () => {
  it('generates a stable sandbox account whose followers grow a little each day', async () => {
    const day = Date.parse('2026-09-17T00:00:00Z');
    expect(mockProfile('ari_makes', day)).toEqual(mockProfile('ARI_MAKES'.toLowerCase(), day));
    expect(mockProfile('ari_makes', day).profileImageUrl).toBe('/api/dev/x/avatar/ari_makes');
    expect(mockProfile('ari_makes', day + 30 * 86_400_000).followers).toBeGreaterThanOrEqual(mockProfile('ari_makes', day).followers);
    const provider = new MockXProvider(() => day);
    await expect(provider.signedInProfile({ code: 'not-a-sandbox-code', codeVerifier: 'v', redirectUri: '/' })).rejects.toMatchObject({ code: 'DENIED' });
    const lookup = await provider.lookup([{ xUserId: '1', username: 'ari_makes' }, { xUserId: '2', username: 'gone_account' }]);
    expect(lookup.found.map((profile) => profile.xUserId)).toEqual(['1']);
    expect(lookup.missing).toEqual(['2']);
  });

  it('is the sandbox locally, live only with a client id, and never the sandbox in a deployment', () => {
    vi.stubEnv('X_PROVIDER', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(xMode()).toBe('mock');
    vi.stubEnv('NODE_ENV', 'production');
    expect(xMode()).toBe('off');
    vi.stubEnv('X_PROVIDER', 'live');
    vi.stubEnv('X_CLIENT_ID', '');
    expect(xMode()).toBe('off');
    vi.stubEnv('X_CLIENT_ID', 'client-1');
    expect(xMode()).toBe('live');

    expect(checkEnvironment({ X_PROVIDER: 'mock' }, 'local').ok).toBe(true);
    const staging = checkEnvironment({ X_PROVIDER: 'mock' }, 'staging').rows.find((row) => row.name === 'X_PROVIDER');
    expect(staging?.status).toBe('INVALID');
    const live = checkEnvironment({ X_PROVIDER: 'live' }, 'local').rows.filter((row) => row.name.startsWith('X_') && row.status !== 'OK').map((row) => [row.name, row.status]);
    expect(live).toEqual([['X_CLIENT_ID', 'MISSING'], ['X_BEARER_TOKEN', 'MISSING']]);
  });
});
