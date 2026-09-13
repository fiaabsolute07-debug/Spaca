import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? 'postgres://postgres:local_dev_only@127.0.0.1:55432/creator_marketplace';
const client = postgres(migrationUrl, { max: 1, connect_timeout: 10 });

try {
  await client`create table if not exists public.schema_migrations (id text primary key, applied_at timestamptz not null default now())`;
  // Ordered, append-only migrations: drizzle/NNNN_name.sql.
  const files = (await readdir(resolve('drizzle'))).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  for (const file of files) {
    const [existing] = await client`select id from public.schema_migrations where id=${file}`;
    if (existing) {
      console.log(`skip ${file}`);
      continue;
    }
    const source = await readFile(resolve('drizzle', file), 'utf8');
    await client.begin(async (tx) => {
      await tx.unsafe(source);
      await tx`insert into public.schema_migrations (id) values (${file})`;
    });
    console.log(`applied ${file}`);
  }
} finally {
  await client.end();
}
