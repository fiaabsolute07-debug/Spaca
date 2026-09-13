/**
 * Prepares the isolated integration-test database so DB suites never write into the dev database.
 * Creates `creator_marketplace_test` on the local server if missing, applies every migration and seeds fixtures.
 * Refuses non-local targets (FND-07).
 */
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { assertLocalDatabaseTarget } from '../src/lib/fixtures';

export const TEST_DATABASE = process.env.TEST_DATABASE_NAME ?? 'creator_marketplace_test';
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:local_dev_only@127.0.0.1:55432/postgres';
const migrationUrl = adminUrl.replace(/\/[^/]*$/, `/${TEST_DATABASE}`);

assertLocalDatabaseTarget(migrationUrl);
if (!/^[a-z0-9_]+_test$/.test(TEST_DATABASE)) throw new Error('TEST_DATABASE_NAME must end with _test');

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  const [existing] = await admin`select 1 from pg_database where datname=${TEST_DATABASE}`;
  if (!existing) {
    await admin.unsafe(`create database ${TEST_DATABASE}`);
    console.log(`created ${TEST_DATABASE}`);
  }
} finally {
  await admin.end();
}

const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
});
if (result.status !== 0) process.exit(result.status ?? 1);
// Fixture personas are needed by the dev-session and E2E suites.
const seeded = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: migrationUrl.replace('postgres:local_dev_only@', 'app_server:local_dev_only@') },
});
if (seeded.status !== 0) process.exit(seeded.status ?? 1);
console.log(`integration database ready: ${TEST_DATABASE}`);
