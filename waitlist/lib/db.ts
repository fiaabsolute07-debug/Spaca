import postgres from 'postgres';

const localUrl = 'postgres://postgres:local_dev_only@127.0.0.1:55432/spaca_waitlist';
if (process.env.NODE_ENV === 'production' && !process.env.WAITLIST_DATABASE_URL) {
  throw new Error('WAITLIST_DATABASE_URL is required in production');
}

const url = process.env.WAITLIST_DATABASE_URL ?? localUrl;
const host = new URL(url).hostname;
const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(host);
// Supabase's transaction pooler (Supavisor, port 6543) does not support prepared statements.
const isTransactionPooler = /pooler\.supabase\.com$/.test(host) && new URL(url).port === '6543';

/** Waitlist database only (local Postgres or Supabase); never the product database. Reused across dev hot reloads. */
const globalForDb = globalThis as unknown as { waitlistSql?: postgres.Sql };
export const sql = globalForDb.waitlistSql ?? postgres(url, {
  max: isTransactionPooler ? 1 : 5,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: !isTransactionPooler,
  ssl: isLocal ? false : 'require',
});
if (process.env.NODE_ENV !== 'production') globalForDb.waitlistSql = sql;
