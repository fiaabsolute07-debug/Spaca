/**
 * Google account access for "Connect Google" and "Continue with Google" (drizzle/0036). Two implementations share one
 * shape, like Connect X:
 *
 * - `LiveGoogleProvider` uses Google's OAuth 2.0 authorization code flow with PKCE (scopes `openid email profile`): the
 *   code is exchanged at oauth2.googleapis.com and the account is read once from the OpenID userinfo endpoint over that
 *   back channel. The access token is used for that one read and revoked; nothing from Google is stored but the account
 *   id, its verified email and its name.
 * - `MockGoogleProvider` is the local sandbox: a consent page on this site where any address can be chosen. Identities
 *   from it are stored with source MOCK. It is never used in production.
 */
import { createHash } from 'node:crypto';

export type GoogleSource = 'MOCK' | 'GOOGLE_API';

export type GoogleProfile = { sub: string; email: string; name: string };

export type GoogleProviderErrorCode = 'DENIED' | 'UNVERIFIED' | 'UNAVAILABLE' | 'INVALID_RESPONSE';

/** Messages are written for people and never carry tokens, codes or response bodies. */
export class GoogleProviderError extends Error {
  constructor(message: string, readonly code: GoogleProviderErrorCode) {
    super(message);
  }
}

export interface GoogleProvider {
  readonly source: GoogleSource;
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** Exchanges the authorization code and reads the signed-in Google account once. */
  signedInProfile(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleProfile>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Maps an OpenID userinfo response to a profile, or throws when the account id or a verified email is missing. */
export function profileFromUserinfo(input: unknown): GoogleProfile {
  const user = (input ?? {}) as Record<string, unknown>;
  const sub = String(user.sub ?? '');
  const email = String(user.email ?? '').trim().toLowerCase();
  if (!/^[0-9A-Za-z_-]{1,255}$/.test(sub) || !EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new GoogleProviderError('Google returned an account spaca could not read', 'INVALID_RESPONSE');
  }
  if (user.email_verified !== true && user.email_verified !== 'true') {
    throw new GoogleProviderError('Google has not verified the email of this account, so it cannot be connected.', 'UNVERIFIED');
  }
  return { sub, email, name: (String(user.name ?? '').trim() || email.split('@')[0]!).slice(0, 100) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Live: accounts.google.com

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const TIMEOUT_MS = 10_000;

type LiveConfig = { clientId: string; clientSecret: string; fetch?: typeof fetch };

export class LiveGoogleProvider implements GoogleProvider {
  readonly source = 'GOOGLE_API' as const;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: LiveConfig) {
    this.fetcher = config.fetch ?? fetch;
  }

  authorizeUrl({ state, codeChallenge, redirectUri }: { state: string; codeChallenge: string; redirectUri: string }) {
    const url = new URL(GOOGLE_AUTHORIZE);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: this.config.clientId, redirect_uri: redirectUri, scope: 'openid email profile',
      state, code_challenge: codeChallenge, code_challenge_method: 'S256', prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  private static failure(status: number): GoogleProviderError {
    if (status === 400 || status === 401 || status === 403) return new GoogleProviderError('Google did not accept the sign-in. Try again.', 'DENIED');
    return new GoogleProviderError('Google could not be reached. Try again later.', 'UNAVAILABLE');
  }

  async signedInProfile({ code, codeVerifier, redirectUri }: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleProfile> {
    const token = await this.fetcher(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier,
        client_id: this.config.clientId, client_secret: this.config.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!token.ok) throw LiveGoogleProvider.failure(token.status);
    const accessToken = String(((await token.json().catch(() => ({}))) as { access_token?: unknown }).access_token ?? '');
    if (!accessToken) throw new GoogleProviderError('Google did not complete the sign-in. Try again.', 'INVALID_RESPONSE');
    try {
      const me = await this.fetcher(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!me.ok) throw LiveGoogleProvider.failure(me.status);
      return profileFromUserinfo(await me.json().catch(() => ({})));
    } finally {
      // spaca needs the token for this one read only.
      await this.fetcher(GOOGLE_REVOKE, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken }).toString(), signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Mock: local sandbox

export const MOCK_GOOGLE_CODE_PATTERN = /^mock\.([A-Za-z0-9_-]{4,400})$/;

/** The sandbox code for an address: the address, base64url-encoded, so the callback can read it back. */
export const mockGoogleCode = (email: string) => `mock.${Buffer.from(email.trim().toLowerCase()).toString('base64url')}`;

/** A stable sandbox Google account for an address: the same address always has the same account id. */
export function mockGoogleProfile(email: string): GoogleProfile {
  const address = email.trim().toLowerCase();
  const digits = BigInt(`0x${createHash('sha256').update(`google:${address}`).digest('hex').slice(0, 20)}`).toString().padStart(21, '1').slice(0, 21);
  const name = address.split('@')[0]!.split(/[._-]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ');
  return { sub: digits, email: address, name: name || address };
}

export class MockGoogleProvider implements GoogleProvider {
  readonly source = 'MOCK' as const;

  authorizeUrl({ state, codeChallenge, redirectUri }: { state: string; codeChallenge: string; redirectUri: string }) {
    return `/dev/google-authorize?${new URLSearchParams({ state, code_challenge: codeChallenge, redirect_uri: redirectUri }).toString()}`;
  }

  async signedInProfile({ code }: { code: string; codeVerifier: string; redirectUri: string }) {
    const match = MOCK_GOOGLE_CODE_PATTERN.exec(code);
    const email = match ? Buffer.from(match[1]!, 'base64url').toString('utf8') : '';
    if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new GoogleProviderError('Google did not accept the sign-in. Try again.', 'DENIED');
    return mockGoogleProfile(email);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Selection

export type GoogleMode = 'mock' | 'live' | 'off';

/** live with GOOGLE_PROVIDER=live and a client id and secret; mock by default outside production; otherwise off. */
export function googleMode(): GoogleMode {
  if (process.env.GOOGLE_PROVIDER === 'off') return 'off';
  if (process.env.GOOGLE_PROVIDER === 'live') return process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? 'live' : 'off';
  return process.env.NODE_ENV === 'production' ? 'off' : 'mock';
}

const store = globalThis as typeof globalThis & { __spacaGoogleProvider?: GoogleProvider | null };

export function getGoogleProvider(): GoogleProvider | null {
  if (store.__spacaGoogleProvider !== undefined) return store.__spacaGoogleProvider;
  const mode = googleMode();
  if (mode === 'live') return new LiveGoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! });
  return mode === 'mock' ? new MockGoogleProvider() : null;
}

/** Tests swap the provider; `undefined` returns to the environment's choice. */
export function setGoogleProviderForTests(provider: GoogleProvider | null | undefined) {
  if (provider === undefined) delete store.__spacaGoogleProvider;
  else store.__spacaGoogleProvider = provider;
}
