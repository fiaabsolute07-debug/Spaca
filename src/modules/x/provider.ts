/**
 * X (Twitter) account access for "Connect X" (drizzle/0032). Two implementations share one shape:
 *
 * - `LiveXProvider` talks to api.x.com: OAuth 2.0 authorization code with PKCE (scopes `users.read tweet.read`), one
 *   `GET /2/users/me` right after sign-in, and `GET /2/users?ids=` with the app's bearer token for later refreshes.
 *   The user's access token is used once and revoked; it is never stored or logged.
 * - `MockXProvider` is the local sandbox: a consent page on this site and profiles generated from the username. Its
 *   rows are stored with source MOCK and shown as sandbox data. It is never used in production.
 *
 * X bills each profile returned ($0.010 per user read at the time of writing, docs.x.com/x-api/getting-started/pricing),
 * which is why callers read a profile once and refresh it rarely.
 */
import { createHash } from 'node:crypto';
import type { XSource } from '@/lib/x-profile';

export const USER_FIELDS = 'id,name,username,profile_image_url,description,location,verified,verified_type,protected,public_metrics,created_at';

/** A profile as stored in app.x_profiles, already checked and trimmed. */
export type XProfile = {
  xUserId: string;
  username: string;
  name: string;
  profileImageUrl: string | null;
  description: string;
  location: string;
  verified: boolean;
  verifiedType: 'blue' | 'business' | 'government' | 'none' | null;
  protected: boolean;
  followers: number;
  following: number;
  posts: number;
  listed: number;
  createdAt: string | null;
};

export type XProviderErrorCode = 'DENIED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID_RESPONSE';

/** Messages are written for people and never carry tokens, codes or response bodies. */
export class XProviderError extends Error {
  constructor(message: string, readonly code: XProviderErrorCode) {
    super(message);
  }
}

export interface XProvider {
  readonly source: XSource;
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** Exchanges the authorization code and reads the signed-in account once. */
  signedInProfile(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<XProfile>;
  /** Current profiles for connected accounts. `missing` lists X user ids that X no longer returns. */
  lookup(accounts: { xUserId: string; username: string }[]): Promise<{ found: XProfile[]; missing: string[] }>;
}

const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const VERIFIED_TYPES = new Set(['blue', 'business', 'government', 'none']);

/** Maps an X API v2 user object to a stored profile, or throws when the essentials are missing or malformed. */
export function profileFromApi(input: unknown): XProfile {
  const user = (input ?? {}) as Record<string, unknown>;
  const id = String(user.id ?? '');
  const username = String(user.username ?? '');
  if (!/^[0-9]{1,20}$/.test(id) || !/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new XProviderError('X returned an account spaca could not read', 'INVALID_RESPONSE');
  const metrics = (user.public_metrics ?? {}) as Record<string, unknown>;
  const image = typeof user.profile_image_url === 'string' && user.profile_image_url.startsWith('https://pbs.twimg.com/')
    // X serves a 48 px "_normal" image by default; the 400 px copy is the same file at a size worth showing.
    ? user.profile_image_url.replace(/_normal(\.[a-z]+)$/i, '_400x400$1').slice(0, 500)
    : null;
  const created = typeof user.created_at === 'string' && !Number.isNaN(Date.parse(user.created_at)) ? new Date(user.created_at).toISOString() : null;
  const verifiedType = typeof user.verified_type === 'string' && VERIFIED_TYPES.has(user.verified_type) ? user.verified_type as XProfile['verifiedType'] : null;
  return {
    xUserId: id,
    username,
    name: (String(user.name ?? '').trim() || username).slice(0, 100),
    profileImageUrl: image,
    description: String(user.description ?? '').slice(0, 500),
    location: String(user.location ?? '').slice(0, 100),
    verified: user.verified === true || (verifiedType !== null && verifiedType !== 'none'),
    verifiedType,
    protected: user.protected === true,
    followers: count(metrics.followers_count),
    following: count(metrics.following_count),
    posts: count(metrics.tweet_count),
    listed: count(metrics.listed_count),
    createdAt: created,
  };
}

const base64url = (buffer: Buffer) => buffer.toString('base64url');
export const codeChallengeFor = (verifier: string) => base64url(createHash('sha256').update(verifier).digest());

// ---------------------------------------------------------------------------------------------------------------------
// Live: api.x.com

const X_AUTHORIZE = 'https://x.com/i/oauth2/authorize';
const X_API = 'https://api.x.com';
const TIMEOUT_MS = 10_000;

type LiveConfig = { clientId: string; clientSecret?: string; bearerToken?: string; fetch?: typeof fetch };

export class LiveXProvider implements XProvider {
  readonly source = 'X_API' as const;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: LiveConfig) {
    this.fetcher = config.fetch ?? fetch;
  }

  authorizeUrl({ state, codeChallenge, redirectUri }: { state: string; codeChallenge: string; redirectUri: string }) {
    const url = new URL(X_AUTHORIZE);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: this.config.clientId, redirect_uri: redirectUri, scope: 'users.read tweet.read',
      state, code_challenge: codeChallenge, code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /** Confidential clients authenticate with Basic auth; public clients send client_id in the body. */
  private tokenRequest(body: Record<string, string>) {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const form = new URLSearchParams(body);
    if (this.config.clientSecret) headers.authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`;
    else form.set('client_id', this.config.clientId);
    return { method: 'POST', headers, body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) };
  }

  private static failure(status: number): XProviderError {
    if (status === 429) return new XProviderError('X is limiting requests right now. Try again later.', 'RATE_LIMITED');
    if (status === 400 || status === 401 || status === 403) return new XProviderError('X did not accept the sign-in. Try connecting again.', 'DENIED');
    return new XProviderError('X could not be reached. Try again later.', 'UNAVAILABLE');
  }

  async signedInProfile({ code, codeVerifier, redirectUri }: { code: string; codeVerifier: string; redirectUri: string }): Promise<XProfile> {
    const token = await this.fetcher(`${X_API}/2/oauth2/token`, this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }));
    if (!token.ok) throw LiveXProvider.failure(token.status);
    const accessToken = String(((await token.json().catch(() => ({}))) as { access_token?: unknown }).access_token ?? '');
    if (!accessToken) throw new XProviderError('X did not complete the sign-in. Try connecting again.', 'INVALID_RESPONSE');
    try {
      const me = await this.fetcher(`${X_API}/2/users/me?user.fields=${USER_FIELDS}`, {
        headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!me.ok) throw LiveXProvider.failure(me.status);
      return profileFromApi(((await me.json().catch(() => ({}))) as { data?: unknown }).data);
    } finally {
      // spaca needs the token for this one read only.
      await this.fetcher(`${X_API}/2/oauth2/revoke`, this.tokenRequest({ token: accessToken, token_type_hint: 'access_token' })).catch(() => undefined);
    }
  }

  async lookup(accounts: { xUserId: string; username: string }[]) {
    if (!accounts.length) return { found: [], missing: [] };
    if (!this.config.bearerToken) throw new XProviderError('Refreshing X profiles needs the app bearer token (X_BEARER_TOKEN).', 'UNAVAILABLE');
    const ids = accounts.slice(0, 100).map((account) => account.xUserId);
    const response = await this.fetcher(`${X_API}/2/users?ids=${ids.join(',')}&user.fields=${USER_FIELDS}`, {
      headers: { authorization: `Bearer ${this.config.bearerToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw LiveXProvider.failure(response.status);
    const body = (await response.json().catch(() => ({}))) as { data?: unknown[] };
    const found = (Array.isArray(body.data) ? body.data : []).map(profileFromApi).filter((profile) => ids.includes(profile.xUserId));
    return { found, missing: ids.filter((id) => !found.some((profile) => profile.xUserId === id)) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Mock: local sandbox

const unit = (key: string, salt: string) => createHash('sha256').update(`${salt}:${key}`).digest().readUInt32BE(0) / 0xffffffff;
const pick = <T,>(items: readonly T[], key: string, salt: string) => items[Math.floor(unit(key, salt) * items.length) % items.length]!;

const MOCK_BIOS = [
  'Threads on DeFi, restaking and the L2s worth watching.',
  'Explaining testnets before they trend. Research at the edge of crypto.',
  'Airdrop hunter, community builder, Spaces host every Thursday.',
  'Memes, art and launches. Building on-chain culture one post at a time.',
  'Security notes and plain-language breakdowns of new protocols.',
];
const MOCK_PLACES = ['Ho Chi Minh City', 'Singapore', 'Lisbon', 'Remote', 'Dubai', ''];
const MOCK_EPOCH = Date.UTC(2026, 0, 1);

/** The sandbox's stand-in for an X account: stable for a username, with followers that grow a little each day. */
export function mockProfile(username: string, now = Date.now()): XProfile {
  const key = username.toLowerCase();
  const baseFollowers = Math.round(10 ** (2.5 + unit(key, 'followers') * 3)); // about 300 to 300K
  const days = Math.max(0, Math.floor((now - MOCK_EPOCH) / 86_400_000));
  const followers = baseFollowers + Math.floor(days * baseFollowers * 0.002 * unit(key, 'growth'));
  const blue = unit(key, 'verified') < 0.4;
  const created = new Date(Date.UTC(2009 + Math.floor(unit(key, 'year') * 15), Math.floor(unit(key, 'month') * 12), 1));
  const id = String(1_000_000_000 + Math.floor(unit(key, 'id') * 8_000_000_000));
  return {
    xUserId: id,
    username,
    name: username.split('_').filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ') || username,
    profileImageUrl: `/api/dev/x/avatar/${key}`,
    description: pick(MOCK_BIOS, key, 'bio'),
    location: pick(MOCK_PLACES, key, 'place'),
    verified: blue,
    verifiedType: blue ? 'blue' : 'none',
    protected: false,
    followers,
    following: Math.round(80 + unit(key, 'following') * 1900),
    posts: Math.round(300 + unit(key, 'posts') * 40_000),
    listed: Math.floor(followers / 180),
    createdAt: created.toISOString(),
  };
}

export const MOCK_CODE_PATTERN = /^mock\.([A-Za-z0-9_]{1,15})$/;

export class MockXProvider implements XProvider {
  readonly source = 'MOCK' as const;
  constructor(private readonly clock: () => number = Date.now) {}

  authorizeUrl({ state, codeChallenge, redirectUri }: { state: string; codeChallenge: string; redirectUri: string }) {
    return `/dev/x-authorize?${new URLSearchParams({ state, code_challenge: codeChallenge, redirect_uri: redirectUri }).toString()}`;
  }

  async signedInProfile({ code }: { code: string; codeVerifier: string; redirectUri: string }) {
    const match = MOCK_CODE_PATTERN.exec(code);
    if (!match) throw new XProviderError('X did not accept the sign-in. Try connecting again.', 'DENIED');
    return mockProfile(match[1]!, this.clock());
  }

  /** Usernames starting with "gone_" stand for accounts X no longer returns. */
  async lookup(accounts: { xUserId: string; username: string }[]) {
    const live = accounts.slice(0, 100).filter((account) => !account.username.toLowerCase().startsWith('gone_'));
    return {
      found: live.map((account) => ({ ...mockProfile(account.username, this.clock()), xUserId: account.xUserId })),
      missing: accounts.slice(0, 100).filter((account) => !live.includes(account)).map((account) => account.xUserId),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Selection

export type XMode = 'mock' | 'live' | 'off';

/** live with X_PROVIDER=live and a client id; mock by default outside production; otherwise off. */
export function xMode(): XMode {
  if (process.env.X_PROVIDER === 'off') return 'off';
  if (process.env.X_PROVIDER === 'live') return process.env.X_CLIENT_ID ? 'live' : 'off';
  return process.env.NODE_ENV === 'production' ? 'off' : 'mock';
}

const store = globalThis as typeof globalThis & { __spacaXProvider?: XProvider | null };

export function getXProvider(): XProvider | null {
  if (store.__spacaXProvider !== undefined) return store.__spacaXProvider;
  const mode = xMode();
  if (mode === 'live') return new LiveXProvider({ clientId: process.env.X_CLIENT_ID!, clientSecret: process.env.X_CLIENT_SECRET || undefined, bearerToken: process.env.X_BEARER_TOKEN || undefined });
  return mode === 'mock' ? new MockXProvider() : null;
}

/** Tests swap the provider; `undefined` returns to the environment's choice. */
export function setXProviderForTests(provider: XProvider | null | undefined) {
  if (provider === undefined) delete store.__spacaXProvider;
  else store.__spacaXProvider = provider;
}
