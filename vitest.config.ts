import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// DB suites run against an isolated database (prepare with `tsx scripts/test-db.ts`), never the dev database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace_test';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: { DATABASE_URL: testDatabaseUrl },
  },
});
