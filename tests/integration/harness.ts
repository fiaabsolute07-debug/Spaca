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

export const key = (label: string) => `it-${runId}-${label}-${randomUUID().slice(0, 8)}`;

/** Local wall-clock ISO without zone; the command parser appends `Z`. */
export const commandInstant = (date: Date) => date.toISOString().slice(0, 19);

export async function createPublishedService(
  command: (actor: TestUser, fields: Record<string, string>) => Promise<JsonResult>,
  creator: TestUser,
  options: { capacity?: number; price?: string; taxonomy?: string } = {},
): Promise<{ serviceId: string; poolId: string }> {
  const created = await command(creator, {
    command: 'create_service',
    idempotency_key: key('create-service'),
    title: `IT service ${runId}`,
    description: 'A complete integration-test scope with deliverables and exclusions.',
    taxonomy: options.taxonomy ?? 'CREATE',
    price: options.price ?? '650',
    capacity: String(options.capacity ?? 1),
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
  const [service] = await sql<{ pool_id: string }[]>`select pool_id from app.services where id=${serviceId}`;
  return { serviceId, poolId: service!.pool_id };
}
