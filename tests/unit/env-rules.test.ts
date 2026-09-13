import { describe, expect, it } from 'vitest';
import { checkEnvironment, formatEnvironmentReport } from '../../scripts/lib/env-rules';

const row = (report: ReturnType<typeof checkEnvironment>, name: string) => report.rows.find((r) => r.name === name);

const productionEnv = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://market.example',
  DATABASE_URL: 'postgres://app:pw-app-secret@db.market.example:5432/app',
  DATABASE_MIGRATION_URL: 'postgres://owner:pw-owner-secret@db.market.example:5432/app',
  AUTH_MODE: 'supabase',
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
  DEV_SESSIONS: 'off',
  STORAGE_PROVIDER: 'supabase',
  PAYMENT_MODE: 'sandbox',
  LIVE_PAYMENTS_ENABLED: 'false',
};

describe('env:check — fail closed per environment (§19.2)', () => {
  it('local needs nothing and passes with defaults', () => {
    expect(checkEnvironment({}, 'local').ok).toBe(true);
  });

  it('production with a complete non-live config passes', () => {
    const report = checkEnvironment(productionEnv, 'production');
    expect(report.rows.filter((r) => r.status !== 'OK')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(row(report, 'DATABASE_URL')).toMatchObject({ status: 'OK', presence: 'set', host: 'remote' });
  });

  it('production refuses loopback databases, mock payments, dev sessions, local auth and nonzero fee', () => {
    const report = checkEnvironment({ ...productionEnv, DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/app', PAYMENT_MODE: 'mock', DEV_SESSIONS: 'on', AUTH_MODE: 'local', PLATFORM_FEE_BPS: '250' }, 'production');
    expect(report.ok).toBe(false);
    for (const name of ['DATABASE_URL', 'PAYMENT_MODE', 'DEV_SESSIONS', 'AUTH_MODE', 'PLATFORM_FEE_BPS']) expect(row(report, name)?.status).toBe('INVALID');
    expect(row(report, 'DATABASE_URL')?.host).toBe('loopback');
  });

  it('production refuses the local storage adapter and its signing/dir settings', () => {
    const report = checkEnvironment({ ...productionEnv, STORAGE_PROVIDER: 'local', STORAGE_SIGNING_SECRET: 'local_dev_only_storage_signing_fixture', LOCAL_STORAGE_DIR: '.local/storage' }, 'production');
    expect(report.ok).toBe(false);
    for (const name of ['STORAGE_PROVIDER', 'STORAGE_SIGNING_SECRET', 'LOCAL_STORAGE_DIR']) expect(row(report, name)?.status).toBe('INVALID');
    const { STORAGE_PROVIDER: _omit, ...withoutStorage } = productionEnv;
    expect(row(checkEnvironment(withoutStorage, 'production'), 'STORAGE_PROVIDER')?.status).toBe('MISSING');
  });

  it('live payments require an explicit fee payer policy and live provider keys', () => {
    const report = checkEnvironment({ ...productionEnv, LIVE_PAYMENTS_ENABLED: 'true', PAYMENT_MODE: 'live', PAYMENT_PROVIDER: 'stripe_connect' }, 'production');
    expect(report.ok).toBe(false);
    expect(row(report, 'FEE_PAYER_POLICY')?.status).toBe('MISSING');
    expect(row(report, 'STRIPE_SECRET_KEY')?.status).toBe('MISSING');
    const testKey = checkEnvironment({ ...productionEnv, LIVE_PAYMENTS_ENABLED: 'true', PAYMENT_MODE: 'live', PAYMENT_PROVIDER: 'stripe_connect', FEE_PAYER_POLICY: 'CREATOR_AT_COST', STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc', STRIPE_API_VERSION: '2026-01-01' }, 'production');
    expect(row(testKey, 'STRIPE_SECRET_KEY')?.status).toBe('INVALID');
  });

  it('staging refuses mock payments and missing deployment variables', () => {
    const report = checkEnvironment({ APP_ENV: 'staging', PAYMENT_MODE: 'mock' }, 'staging');
    expect(report.ok).toBe(false);
    expect(row(report, 'PAYMENT_MODE')?.status).toBe('INVALID');
    expect(row(report, 'DATABASE_URL')?.status).toBe('MISSING');
  });

  it('never prints values, only presence and host class', () => {
    const text = formatEnvironmentReport(checkEnvironment({ ...productionEnv, STRIPE_SECRET_KEY: 'sk_live_topsecret123', PAYMENT_PROVIDER: 'stripe_connect' }, 'production'));
    for (const secret of ['pw-app-secret', 'pw-owner-secret', 'db.market.example', 'sk_live_topsecret123', 'sb_publishable_example', 'proj.supabase.co']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toMatch(/DATABASE_URL \| OK \| set \| remote/);
  });
});
