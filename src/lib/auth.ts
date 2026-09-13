import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { sql } from './db';

export type ActorStatus = 'ACTIVE' | 'SUSPENDED';
export type Actor = { id: string; email: string; display_name: string; roles: string[]; is_test: boolean; status: ActorStatus; timezone: string };
export const SESSION_COOKIE = 'creator_session';
export function localAuthEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.AUTH_MODE !== 'supabase';
}
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, encoded: string): boolean {
  if (password.length > 256) return false;
  const [algorithm, salt, digest] = encoded.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(digest ?? '')) return false;
  return timingSafeEqual(scryptSync(password, salt!, 64), Buffer.from(digest!, 'hex'));
}
export function hashSessionToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
/**
 * Origins this request may legitimately come from: the URL Next resolved, the Host/X-Forwarded-Host the
 * browser actually targeted, and the configured APP_BASE_URL. Cross-site browser requests cannot set
 * X-Forwarded-Host without a CORS preflight, which these routes never grant.
 */
export function requestOrigins(request: Request): Set<string> {
  const url = new URL(request.url);
  const origins = new Set<string>([url.origin]);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host && /^[A-Za-z0-9.:\[\]-]+$/.test(host)) {
    const proto = (request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')).split(',')[0]!.trim();
    if (proto === 'http' || proto === 'https') origins.add(`${proto}://${host.toLowerCase()}`);
  }
  if (process.env.APP_BASE_URL) {
    try { origins.add(new URL(process.env.APP_BASE_URL).origin); } catch { /* invalid config is ignored, never widened */ }
  }
  return origins;
}
/** CSRF guard for cookie-authenticated mutations: the browser Origin must match this request's own origin. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return false;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  return requestOrigins(request).has(parsed.origin);
}
/**
 * Absolute URL on the origin the browser actually used. Redirects built from `request.url` can switch
 * hosts (e.g. 127.0.0.1 → localhost under Next dev), which drops host-scoped session cookies.
 */
export function publicUrl(request: Request, path: string): URL {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  let base = url.origin;
  if (host && /^[A-Za-z0-9.:\[\]-]+$/.test(host)) {
    const proto = (request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')).split(',')[0]!.trim();
    if (proto === 'http' || proto === 'https') base = `${proto}://${host.toLowerCase()}`;
  }
  const safePath = path.startsWith('/') && !path.startsWith('//') ? path : '/';
  return new URL(safePath, base);
}
/** Hostname the client targeted (Host header), falling back to the resolved URL. */
export function requestHostname(request: Request): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) {
    try { return new URL(`http://${host}`).hostname; } catch { /* fall through */ }
  }
  return new URL(request.url).hostname;
}
export async function createSession(userId: string): Promise<string> {
  if (!localAuthEnabled()) throw new Error('Local sessions disabled');
  const token = randomBytes(32).toString('hex');
  await sql`insert into app.sessions (token_hash, user_id, expires_at) values (${hashSessionToken(token)}, ${userId}, now() + interval '7 days')`;
  return token;
}
export async function supabaseAuth() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase authentication is not configured');
  const jar = await cookies();
  return createServerClient(url, key, { cookies: {
    getAll: () => jar.getAll(),
    setAll: (values) => { for (const { name, value, options } of values) { try { jar.set(name, value, options); } catch { /* Server component: refresh on next route request. */ } } },
  } });
}
export async function getActor(): Promise<Actor | null> {
  if (!localAuthEnabled()) {
    const client = await supabaseAuth();
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) return null;
    // SUSPENDED users keep access to existing obligations; the command envelope blocks new activity (SEC-10).
    const [actor] = await sql<Actor[]>`select id,email,display_name,roles,is_test,status,timezone from app.users where auth_user_id=${user.id} and status in ('ACTIVE','SUSPENDED')`;
    return actor ?? null;
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [actor] = await sql<Actor[]>`select u.id,u.email,u.display_name,u.roles,u.is_test,u.status,u.timezone from app.sessions s join app.users u on u.id=s.user_id where s.token_hash=${hashSessionToken(token)} and s.expires_at>now() and u.status in ('ACTIVE','SUSPENDED')`;
  return actor ?? null;
}
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/sign-in');
  return actor;
}
