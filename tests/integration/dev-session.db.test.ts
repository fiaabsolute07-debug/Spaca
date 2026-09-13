import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_DB } from './harness';

const { POST } = await import('@/app/api/dev/session/route');
const { sql } = await import('@/lib/db');
const { hashSessionToken } = await import('@/lib/auth');
const { FIXTURE_PERSONAS } = await import('@/lib/fixtures');

const call = (body: unknown, options: { host?: string; origin?: string | null } = {}) => {
  const base = `http://${options.host ?? '127.0.0.1:3000'}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (options.origin !== null) headers.origin = options.origin ?? base;
  return POST(new Request(`${base}/api/dev/session`, { method: 'POST', headers, body: JSON.stringify(body) }));
};

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (RUN_DB) await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('W1-S — local fixture sessions for E2E', () => {
  it('creates a real HttpOnly session for a seeded persona', async () => {
    const response = await call({ persona: 'buyer_b' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ persona: 'buyer_b', userId: FIXTURE_PERSONAS.buyer_b.id });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/creator_session=[a-f0-9]{64}/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    const token = /creator_session=([a-f0-9]{64})/.exec(cookie)![1]!;
    const [session] = await sql`select user_id from app.sessions where token_hash=${hashSessionToken(token)} and expires_at>now()`;
    expect(session!.user_id).toBe(FIXTURE_PERSONAS.buyer_b.id);
  });

  it('fails closed in production, with Supabase auth, when disabled, or off loopback', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await call({ persona: 'admin' })).status).toBe(404);
    vi.unstubAllEnvs();
    vi.stubEnv('AUTH_MODE', 'supabase');
    expect((await call({ persona: 'admin' })).status).toBe(404);
    vi.unstubAllEnvs();
    vi.stubEnv('DEV_SESSIONS', 'off');
    expect((await call({ persona: 'admin' })).status).toBe(404);
    vi.unstubAllEnvs();
    expect((await call({ persona: 'admin' }, { host: 'marketplace.example.com' })).status).toBe(404);
  });

  it('rejects cross-origin browser calls and unknown personas', async () => {
    expect((await call({ persona: 'admin' }, { origin: 'https://attacker.test' })).status).toBe(403);
    expect((await call({ persona: 'root' })).status).toBe(400);
    expect((await call({ persona: '__proto__' })).status).toBe(400);
    expect((await call({ persona: 'buyer_a' }, { origin: null })).status).toBe(200);
  });
});
