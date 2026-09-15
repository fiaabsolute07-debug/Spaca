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
