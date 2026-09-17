/**
 * DB-backed integration harness. Tests call the real Next route handlers against the real
 * local PostgreSQL schema; only `next/headers` cookies are substituted (see `sessionState`).
 *
 * Opt-in: set RUN_DB_INTEGRATION=1 with PostgreSQL running (`db:start`, `db:migrate`).
 * Without it the suites are reported as skipped, never as passed.
 */
import { randomUUID } from 'node:crypto';
import { createSession } from '@/lib/auth';
import { sql } from '@/lib/db';

export const RUN_DB = process.env.RUN_DB_INTEGRATION === '1';
export const ORIGIN = 'http://localhost:3000';
export const runId = randomUUID().slice(0, 8);

/** Read synchronously by the mocked `cookies()` at call time, so concurrent requests keep their own actor. */
export const sessionState: { token: string | null } = { token: null };

export type TestUser = { id: string; email: string; token: string };

export async function createUser(label: string, roles: string[] = ['buyer', 'creator']): Promise<TestUser> {
  const email = `it-${runId}-${label}-${randomUUID().slice(0, 6)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status)
    values (${email},${`IT ${label}`},${roles},true,'ACTIVE') returning id`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}

/** The routes a sign-up with X goes through; each suite imports them after mocking `next/headers`. */
export type XSignUpRoutes = { start: (request: Request) => Promise<Response>; callback: (request: Request) => Promise<Response> };

/**
 * "Continue with X" the way the dialogs do it (drizzle/0035): the start route with the intent (and type for sign-up), the
 * sandbox X "authorizes" as `username`, X comes back to the callback. Returns where the callback sends the browser.
 */
export async function continueWithX(routes: XSignUpRoutes, input: { intent: 'signin' | 'signup'; username: string; role?: string; returnTo?: string; code?: string }) {
  const form = new FormData();
  form.set('intent', input.intent);
  if (input.role !== undefined) form.set('role', input.role);
  form.set('return_to', input.returnTo ?? '/dashboard');
  sessionState.token = null;
  const started = await routes.start(new Request(`${ORIGIN}/api/auth/x`, { method: 'POST', headers: { origin: ORIGIN }, body: form }));
  const startedAt = new URL(started.headers.get('location') ?? '/', ORIGIN);
  const state = startedAt.searchParams.get('state') ?? '';
  const response = await routes.callback(new Request(`${ORIGIN}/api/x/callback?${new URLSearchParams({ state, code: input.code ?? `mock.${input.username}` }).toString()}`));
  const location = new URL(response.headers.get('location') ?? '/', ORIGIN);
  return { started, startedAt, state, response, location, error: location.searchParams.get('error'), message: location.searchParams.get('message') };
}

/** The account a sandbox X username signs in to, if any. */
export async function accountForX(username: string) {
  const { mockProfile } = await import('@/modules/x/provider');
  const [user] = await sql<{ id: string; display_name: string; roles: string[]; email: string | null; is_test: boolean; onboarded_at: Date | null }[]>`select u.id,u.display_name,u.roles,u.email,u.is_test,u.onboarded_at
    from app.user_identities i join app.users u on u.id=i.user_id where i.provider='X' and i.source='MOCK' and i.subject=${mockProfile(username).xUserId}`;
  return user ?? null;
}

/**
 * Sign-up with X, then a session for the new account, because the test cookie jar keeps no cookies. `user` and `actor`
 * are null when no account was created (the redirect's `error` says why).
 */
export async function signUpWithX(routes: XSignUpRoutes, role: string, username = `t${randomUUID().replaceAll('-', '').slice(0, 12)}`, returnTo = '/dashboard') {
  const result = await continueWithX(routes, { intent: 'signup', role, username, returnTo });
  const user = await accountForX(username);
  return { ...result, username, user, actor: user ? { id: user.id, email: user.email ?? '', token: await createSession(user.id) } satisfies TestUser : null };
}

export type JsonResult = { status: number; body: Record<string, unknown> };

export async function callRoute(
  handler: (request: Request) => Promise<Response>,
  path: string,
  actor: TestUser | null,
  fields: Record<string, string>,
  options: { origin?: string } = {},
): Promise<JsonResult> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  sessionState.token = actor?.token ?? null;
  const response = await handler(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { origin: options.origin ?? ORIGIN, accept: 'application/json' },
      body: form,
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** The creator's active-order counters (drizzle/0012); zeros before the creator's first claim. */
export async function workloadCounters(creatorId: string): Promise<{ held_units: number; active_units: number; accepting_orders: boolean }> {
  const [row] = await sql<{ held_units: number; active_units: number; accepting_orders: boolean }[]>`select held_units,active_units,accepting_orders
    from app.creator_workloads where creator_id=${creatorId}`;
  return row ?? { held_units: 0, active_units: 0, accepting_orders: true };
}

/** Invariant after every scenario: counters equal the sum of claims for every creator. */
export async function workloadDrift(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from app.workload_counter_drift`;
  return row!.n;
}

export const key = (label: string) => `it-${runId}-${label}-${randomUUID().slice(0, 8)}`;

/** A unique X handle (≤15 chars) for PUBLISH fixtures; accounts are unique across the marketplace. */
export const xHandle = () => `t${randomUUID().replaceAll('-', '').slice(0, 13)}`;

export async function linkXAccount(command: (actor: TestUser, fields: Record<string, string>) => Promise<JsonResult>, creator: TestUser, handle = xHandle()): Promise<{ accountId: string; handle: string }> {
  const linked = await command(creator, { command: 'add_social_account', idempotency_key: key('social'), platform: 'X', account: `https://x.com/${handle}` });
  if (linked.status !== 200) throw new Error(`add_social_account failed: ${JSON.stringify(linked.body)}`);
  return { accountId: String(linked.body.id), handle: handle.toLowerCase() };
}

/** Local wall-clock ISO without zone; the command parser appends `Z`. */
export const commandInstant = (date: Date) => date.toISOString().slice(0, 19);

export async function createPublishedService(
  command: (actor: TestUser, fields: Record<string, string>) => Promise<JsonResult>,
  creator: TestUser,
  // `capacity` is ignored: there is no limit on orders at once since drizzle/0017. Kept so older call sites compile.
  options: { capacity?: number; price?: string; taxonomy?: string; unitsPerOrder?: number; minLiveHours?: number } = {},
): Promise<{ serviceId: string; creatorId: string; publishHandle?: string }> {
  const channel = options.taxonomy === 'PUBLISH' ? await linkXAccount(command, creator) : null;
  const created = await command(creator, {
    ...(channel ? { publish_account_id: channel.accountId, publish_format: 'THREAD', min_live_hours: String(options.minLiveHours ?? 48), disclosure_text: '#ad' } : {}),
    command: 'create_service',
    idempotency_key: key('create-service'),
    title: `IT service ${runId}`,
    description: 'A complete integration-test scope with deliverables and exclusions.',
    taxonomy: options.taxonomy ?? 'CREATE',
    price: options.price ?? '650',
    ...(options.unitsPerOrder ? { units_per_order: String(options.unitsPerOrder) } : {}),
    turnaround_hours: '72',
    sample_url_1: 'https://example.com/1',
    sample_title_1: 'Sample one',
    sample_url_2: 'https://example.com/2',
    sample_title_2: 'Sample two',
    sample_url_3: 'https://example.com/3',
    sample_title_3: 'Sample three',
  });
  if (created.status !== 200) throw new Error(`create_service failed: ${JSON.stringify(created.body)}`);
  const serviceId = String(created.body.id);
  const published = await command(creator, { command: 'publish_service', idempotency_key: key('publish'), service_id: serviceId });
  if (published.status !== 200) throw new Error(`publish_service failed: ${JSON.stringify(published.body)}`);
  return { serviceId, creatorId: creator.id, ...(channel ? { publishHandle: channel.handle } : {}) };
}
