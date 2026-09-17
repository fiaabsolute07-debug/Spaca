import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEnvironment } from '../../scripts/lib/env-rules';
import { GoogleProviderError, LiveGoogleProvider, MockGoogleProvider, googleMode, mockGoogleCode, mockGoogleProfile, profileFromUserinfo } from '@/modules/google/provider';

const USERINFO = { sub: '110248495921238986420', email: 'Linh.Tran@gmail.com', email_verified: true, name: 'Linh Tran', picture: 'https://lh3.googleusercontent.com/a/x' };

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

const config = { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'test-only-secret' };

describe('Google profile mapping', () => {
  it('keeps the account id, the lower-cased verified email and the name, and nothing else', () => {
    expect(profileFromUserinfo(USERINFO)).toEqual({ sub: USERINFO.sub, email: 'linh.tran@gmail.com', name: 'Linh Tran' });
    expect(profileFromUserinfo({ ...USERINFO, name: '' }).name).toBe('linh.tran');
  });

  it('refuses an account whose email Google has not verified, or a response without an id or email', () => {
    expect(() => profileFromUserinfo({ ...USERINFO, email_verified: false })).toThrow(GoogleProviderError);
    expect(() => profileFromUserinfo({ ...USERINFO, email_verified: false })).toThrow(/not verified/);
    expect(() => profileFromUserinfo({ ...USERINFO, sub: '' })).toThrow(/could not read/);
    expect(() => profileFromUserinfo({ ...USERINFO, email: 'not-an-email' })).toThrow(/could not read/);
  });
});

describe('LiveGoogleProvider (Google OAuth, fetch stubbed)', () => {
  it('asks only for openid, email and profile, with a PKCE challenge and the account chooser', () => {
    const url = new URL(new LiveGoogleProvider(config).authorizeUrl({ state: 'st', codeChallenge: 'ch', redirectUri: 'https://spaca.test/api/auth/google/callback' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code', client_id: config.clientId, redirect_uri: 'https://spaca.test/api/auth/google/callback', scope: 'openid email profile',
      state: 'st', code_challenge: 'ch', code_challenge_method: 'S256', prompt: 'select_account',
    });
  });

  it('exchanges the code, reads the account once, and revokes the token without keeping it', async () => {
    const { calls, fetcher } = stubFetch({
      'https://oauth2.googleapis.com/token': { status: 200, body: { access_token: 'access-abc', id_token: 'ignored' } },
      'https://openidconnect.googleapis.com/v1/userinfo': { status: 200, body: USERINFO },
      'https://oauth2.googleapis.com/revoke': { status: 200, body: {} },
    });
    const profile = await new LiveGoogleProvider({ ...config, fetch: fetcher }).signedInProfile({ code: 'code-1', codeVerifier: 'v'.repeat(43), redirectUri: 'https://spaca.test/cb' });
    expect(profile.email).toBe('linh.tran@gmail.com');
    expect(calls.map((call) => call.url)).toEqual(['https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', 'https://oauth2.googleapis.com/revoke']);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({
      grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://spaca.test/cb', code_verifier: 'v'.repeat(43), client_id: config.clientId, client_secret: config.clientSecret,
    });
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer access-abc');
    expect(String(calls[2]!.init.body)).toBe('token=access-abc');
  });

  it('turns Google failures into plain messages, and still revokes when the read fails', async () => {
    const denied = stubFetch({ 'https://oauth2.googleapis.com/token': { status: 400, body: { error: 'invalid_grant', error_description: 'secret detail' } } });
    const refusal = await new LiveGoogleProvider({ ...config, fetch: denied.fetcher }).signedInProfile({ code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: 'https://spaca.test/cb' }).catch((error) => error);
    expect(refusal).toBeInstanceOf(GoogleProviderError);
    expect(refusal.message).toBe('Google did not accept the sign-in. Try again.');

    const down = stubFetch({
      'https://oauth2.googleapis.com/token': { status: 200, body: { access_token: 'access-xyz' } },
      'https://openidconnect.googleapis.com/v1/userinfo': { status: 503, body: {} },
      'https://oauth2.googleapis.com/revoke': { status: 200, body: {} },
    });
    const outage = await new LiveGoogleProvider({ ...config, fetch: down.fetcher }).signedInProfile({ code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: 'https://spaca.test/cb' }).catch((error) => error);
    expect(outage.message).toBe('Google could not be reached. Try again later.');
    expect(down.calls.at(-1)!.url).toBe('https://oauth2.googleapis.com/revoke');
  });
});

describe('Sandbox Google and environment selection', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('gives the same address the same sandbox account, and reads it back from the sandbox code', async () => {
    const first = mockGoogleProfile('Minh.Le@gmail.com');
    expect(first).toEqual(mockGoogleProfile('minh.le@gmail.com'));
    expect(first.sub).toMatch(/^[0-9]{21}$/);
    expect(first.name).toBe('Minh Le');
    expect(mockGoogleProfile('other@gmail.com').sub).not.toBe(first.sub);
    const mock = new MockGoogleProvider();
    expect(mock.authorizeUrl({ state: 's', codeChallenge: 'c', redirectUri: 'r' })).toMatch(/^\/dev\/google-authorize\?/);
    expect(await mock.signedInProfile({ code: mockGoogleCode('minh.le@gmail.com'), codeVerifier: '', redirectUri: '' })).toEqual(first);
    await expect(mock.signedInProfile({ code: 'mock.bm90LWFuLWVtYWls', codeVerifier: '', redirectUri: '' })).rejects.toThrow(GoogleProviderError);
  });

  it('is the sandbox locally, live only with a client id and secret, and never the sandbox in a deployment', () => {
    vi.stubEnv('GOOGLE_PROVIDER', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(googleMode()).toBe('mock');
    vi.stubEnv('GOOGLE_PROVIDER', 'live');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-123.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    expect(googleMode()).toBe('off');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-only-secret');
    expect(googleMode()).toBe('live');
    vi.stubEnv('GOOGLE_PROVIDER', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(googleMode()).toBe('off');

    expect(checkEnvironment({ GOOGLE_PROVIDER: 'mock' }, 'staging').rows.find((row) => row.name === 'GOOGLE_PROVIDER')?.status).toBe('INVALID');
    const live = checkEnvironment({ GOOGLE_PROVIDER: 'live', GOOGLE_CLIENT_ID: 'not-a-google-client' }, 'local').rows
      .filter((row) => row.name.startsWith('GOOGLE_') && row.status !== 'OK').map((row) => [row.name, row.status]);
    expect(live).toEqual([['GOOGLE_CLIENT_ID', 'INVALID'], ['GOOGLE_CLIENT_SECRET', 'MISSING']]);
  });
});
