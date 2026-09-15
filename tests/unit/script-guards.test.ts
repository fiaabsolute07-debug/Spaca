import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** FND-07: every script that writes, resets or restores data refuses production-like targets before connecting. */
function run(script: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('FND-07 — reset, seed, restore and benchmark scripts fail closed', () => {
  it('seed refuses production and staging environments and remote databases', () => {
    const targets: Record<string, string>[] = [{ APP_ENV: 'production' }, { NODE_ENV: 'production' }, { APP_ENV: 'staging' }, { DATABASE_URL: 'postgres://u:p@db.example.com:5432/creator_marketplace' }];
    for (const env of targets) {
      const result = run('scripts/seed.ts', env);
      expect(result.status, JSON.stringify(env)).not.toBe(0);
      expect(result.output).toMatch(/not local\/test|not a local or explicitly allowed|DATABASE_URL is required in production/);
      expect(result.output).not.toMatch(/seeded local fixtures/);
    }
  });

  it('the test-database reset refuses remote servers and names that are not *_test', () => {
    const remote = run('scripts/test-db.ts', { TEST_DATABASE_ADMIN_URL: 'postgres://postgres:x@db.example.com:5432/postgres' });
    expect(remote.status).not.toBe(0);
    expect(remote.output).toMatch(/not a local or explicitly allowed/);
    const badName = run('scripts/test-db.ts', { TEST_DATABASE_NAME: 'creator_marketplace' });
    expect(badName.status).not.toBe(0);
    expect(badName.output).toMatch(/must end with _test/);
    const production = run('scripts/test-db.ts', { APP_ENV: 'production' });
    expect(production.status).not.toBe(0);
  });

  it('the restore rehearsal and the discovery benchmark refuse production environments and remote targets', () => {
    const productionLike: Record<string, string>[] = [{ NODE_ENV: 'production' }, { APP_ENV: 'production' }];
    for (const env of productionLike) {
      const restore = run('scripts/restore-rehearsal.ts', env);
      expect(restore.status, JSON.stringify(env)).not.toBe(0);
      expect(restore.output).not.toMatch(/OPS-02 restore rehearsal:/);
    }
    const benchmark = run('scripts/discovery-benchmark.ts', { BENCHMARK_DATABASE_URL: 'postgres://postgres:x@db.example.com:5432/creator_marketplace_test' });
    expect(benchmark.status).not.toBe(0);
    expect(benchmark.output).toMatch(/not a local or explicitly allowed/);
  });

  it('the local job loop only targets a loopback dev server', () => {
    const result = run('scripts/jobs-dev.ts', { JOBS_DEV_URL: 'https://market.example.com' });
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/only targets a loopback dev server/);
  });
});
