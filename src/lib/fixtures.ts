/**
 * Local/test fixture personas (master §17.3). Deterministic ids so seeds, E2E sessions and tests agree.
 * These accounts are `is_test=true` and exist only in local/test databases (see `assertLocalDatabaseTarget`).
 */
export type FixturePersona = {
  id: string;
  email: string;
  displayName: string;
  /** Marketplace roles stored on the user (buyer/creator). */
  roles: string[];
  /** Privileged roles granted through app.user_roles (moderator/finance/support/admin). */
  grants?: string[];
  status: 'ACTIVE' | 'SUSPENDED';
  handle?: string;
};

export const FIXTURE_PERSONAS = {
  creator_c: { id: '10000000-0000-4000-8000-000000000001', email: 'creator@example.test', displayName: 'Ari Nguyen', roles: ['buyer', 'creator'], status: 'ACTIVE', handle: 'ari-makes' },
  buyer_a: { id: '10000000-0000-4000-8000-000000000002', email: 'buyer@example.test', displayName: 'Sam Tran', roles: ['buyer', 'creator'], status: 'ACTIVE', handle: 'sam-builds' },
  buyer_b: { id: '10000000-0000-4000-8000-000000000003', email: 'buyer-b@example.test', displayName: 'Linh Pham', roles: ['buyer', 'creator'], status: 'ACTIVE' },
  creator_d: { id: '10000000-0000-4000-8000-000000000004', email: 'creator-d@example.test', displayName: 'Minh Le', roles: ['buyer', 'creator'], status: 'ACTIVE', handle: 'minh-frames' },
  dual_e: { id: '10000000-0000-4000-8000-000000000005', email: 'dual@example.test', displayName: 'Quinn Vo', roles: ['buyer', 'creator'], status: 'ACTIVE', handle: 'quinn-dual' },
  suspended: { id: '10000000-0000-4000-8000-000000000006', email: 'suspended@example.test', displayName: 'Suspended Creator', roles: ['buyer', 'creator'], status: 'SUSPENDED', handle: 'suspended-creator' },
  moderator: { id: '10000000-0000-4000-8000-000000000007', email: 'moderator@example.test', displayName: 'Mod Operator', roles: [], grants: ['moderator'], status: 'ACTIVE' },
  finance: { id: '10000000-0000-4000-8000-000000000008', email: 'finance@example.test', displayName: 'Finance Operator', roles: [], grants: ['finance'], status: 'ACTIVE' },
  admin: { id: '10000000-0000-4000-8000-000000000009', email: 'admin@example.test', displayName: 'Local Admin', roles: [], grants: ['admin'], status: 'ACTIVE' },
} as const satisfies Record<string, FixturePersona>;

export type FixturePersonaKey = keyof typeof FIXTURE_PERSONAS;

export function isFixturePersonaKey(value: string): value is FixturePersonaKey {
  return Object.prototype.hasOwnProperty.call(FIXTURE_PERSONAS, value);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Fail closed before any destructive or fixture write unless the target is a local/test database
 * (FND-07). Remote databases are allowed only when their name ends with `_test` and the operator
 * names it explicitly in `ALLOW_REMOTE_TEST_DATABASE`.
 */
export function assertLocalDatabaseTarget(databaseUrl: string, env: Record<string, string | undefined> = process.env): { host: string; database: string } {
  if (env.NODE_ENV === 'production' || env.APP_ENV === 'production' || env.APP_ENV === 'staging') {
    throw new Error(`Refusing fixture/reset writes: APP_ENV=${env.APP_ENV ?? ''} NODE_ENV=${env.NODE_ENV ?? ''} is not local/test`);
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Refusing fixture/reset writes: database URL is not parseable');
  }
  const host = parsed.hostname;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error('Refusing fixture/reset writes: database name is not in the allowed form');
  if (LOOPBACK_HOSTS.has(host)) return { host, database };
  if (database.endsWith('_test') && env.ALLOW_REMOTE_TEST_DATABASE === database) return { host, database };
  throw new Error(`Refusing fixture/reset writes: ${host}/${database} is not a local or explicitly allowed test database`);
}
