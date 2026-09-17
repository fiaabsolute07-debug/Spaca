import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const localUrl = 'postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace';
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production');
}

type Sql = ReturnType<typeof postgres>;
const databaseUrl = process.env.DATABASE_URL ?? localUrl;
const host = new URL(databaseUrl);
const local = ['127.0.0.1', 'localhost', '::1'].includes(host.hostname);
// Supabase's transaction pooler (Supavisor, port 6543) hands each transaction a different server connection, so it keeps
// no prepared statements; serverless functions also should not hold many connections each.
const transactionPooler = /pooler\.supabase\.com$/.test(host.hostname) && host.port === '6543';
const createPool = (): Sql => postgres(databaseUrl, {
  max: transactionPooler ? 3 : 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: !transactionPooler,
  // Hosted databases take TLS only; the local embedded server has none.
  ssl: local ? false : 'require',
});

/**
 * One pool per dev server process. `next dev` evaluates this module once per route bundle and again on every hot reload;
 * each copy used to open its own pool of up to 10 connections, and a busy session exhausted PostgreSQL's 100 slots
 * ("too many clients already"). Tests and scripts keep a module-scoped pool because they close it when they finish.
 */
const devGlobal = globalThis as typeof globalThis & { __spacaDevSql?: Sql };
export const sql: Sql = process.env.NODE_ENV === 'development' ? (devGlobal.__spacaDevSql ??= createPool()) : createPool();
export const db = drizzle(sql);
