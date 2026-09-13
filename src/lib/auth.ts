import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { sql } from './db';

export type Actor = { id: string; email: string; display_name: string; roles: string[]; is_test: boolean };
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
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !!origin && origin === new URL(request.url).origin;
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
    const [actor] = await sql<Actor[]>`select id,email,display_name,roles,is_test from app.users where auth_user_id=${user.id} and status='ACTIVE'`;
    return actor ?? null;
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [actor] = await sql<Actor[]>`select u.id,u.email,u.display_name,u.roles,u.is_test from app.sessions s join app.users u on u.id=s.user_id where s.token_hash=${hashSessionToken(token)} and s.expires_at>now() and u.status='ACTIVE'`;
  return actor ?? null;
}
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/sign-in');
  return actor;
}
