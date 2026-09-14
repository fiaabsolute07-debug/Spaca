/**
 * Applies waitlist/migrations/NNNN_name.sql to the waitlist database (separate from the product database).
 * Locally it also creates the `spaca_waitlist` database on the embedded PostgreSQL if it is missing.
 * For Supabase, set WAITLIST_MIGRATION_URL to the project's direct or session-pooler connection string
 * (not the transaction pooler on port 6543).
 *
 *   tsx waitlist/scripts/migrate.ts
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.WAITLIST_MIGRATION_URL ?? 'postgres://postgres:local_dev_only@127.0.0.1:55432/spaca_waitlist';
const target = new URL(url);
const databaseName = target.pathname.slice(1);
const isLocal = ['127.0.0.1', 'localhost'].includes(target.hostname);
if (target.port === '6543') throw new Error('Use the direct or session connection for migrations, not the transaction pooler (6543).');

if (isLocal) {
  if (!/^[a-z_][a-z0-9_]*$/.test(databaseName)) throw new Error(`Refusing unusual database name: ${databaseName}`);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    const [found] = await admin`select 1 from pg_database where datname=${databaseName}`;
    if (!found) {
      await admin.unsafe(`CREATE DATABASE ${databaseName}`);
      console.log(`created database ${databaseName}`);
    }
  } finally {
    await admin.end();
  }
}

const client = postgres(url, { max: 1, connect_timeout: 15, ssl: isLocal ? false : 'require' });
try {
  await client`create table if not exists public.waitlist_migrations (id text primary key, applied_at timestamptz not null default now())`;
  if (!isLocal) await client.unsafe('alter table public.waitlist_migrations enable row level security');
  const dir = resolve(here, '../migrations');
  const files = (await readdir(dir)).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  for (const file of files) {
    const [existing] = await client`select id from public.waitlist_migrations where id=${file}`;
    if (existing) { console.log(`skip ${file}`); continue; }
    const source = await readFile(resolve(dir, file), 'utf8');
    await client.begin(async (tx) => {
      await tx.unsafe(source);
      await tx`insert into public.waitlist_migrations (id) values (${file})`;
    });
    console.log(`applied ${file}`);
  }
} finally {
  await client.end();
}
