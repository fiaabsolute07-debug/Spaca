import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const localUrl = 'postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace';
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production');
}
export const sql = postgres(process.env.DATABASE_URL ?? localUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});
export const db = drizzle(sql);
