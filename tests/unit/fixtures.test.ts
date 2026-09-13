import { describe, expect, it } from 'vitest';
import { FIXTURE_PERSONAS, assertLocalDatabaseTarget, isFixturePersonaKey } from '../../src/lib/fixtures';

describe('FND-07 — fixture/reset writes fail closed outside local/test databases', () => {
  const local = 'postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace';

  it('allows loopback databases in local/test environments', () => {
    expect(assertLocalDatabaseTarget(local, { NODE_ENV: 'test' })).toEqual({ host: '127.0.0.1', database: 'creator_marketplace' });
    expect(assertLocalDatabaseTarget('postgres://u:p@localhost:5432/app_test', {})).toEqual({ host: 'localhost', database: 'app_test' });
  });

  it('refuses production or staging environments even on loopback', () => {
    expect(() => assertLocalDatabaseTarget(local, { NODE_ENV: 'production' })).toThrowError(/not local\/test/);
    expect(() => assertLocalDatabaseTarget(local, { APP_ENV: 'staging' })).toThrowError(/not local\/test/);
    expect(() => assertLocalDatabaseTarget(local, { APP_ENV: 'production' })).toThrowError(/not local\/test/);
  });

  it('refuses remote databases unless an explicitly named *_test database is allowed', () => {
    const remote = 'postgres://u:p@db.example.com:5432/creator_marketplace';
    expect(() => assertLocalDatabaseTarget(remote, {})).toThrowError(/not a local or explicitly allowed/);
    const remoteTest = 'postgres://u:p@db.example.com:5432/creator_marketplace_test';
    expect(() => assertLocalDatabaseTarget(remoteTest, {})).toThrowError(/not a local or explicitly allowed/);
    expect(() => assertLocalDatabaseTarget(remoteTest, { ALLOW_REMOTE_TEST_DATABASE: 'other_test' })).toThrowError();
    expect(assertLocalDatabaseTarget(remoteTest, { ALLOW_REMOTE_TEST_DATABASE: 'creator_marketplace_test' }).database).toBe('creator_marketplace_test');
    expect(() => assertLocalDatabaseTarget('postgres://u:p@db.example.com/prod', { ALLOW_REMOTE_TEST_DATABASE: 'prod' })).toThrowError();
  });

  it('rejects unparseable URLs and odd database names', () => {
    expect(() => assertLocalDatabaseTarget('not a url', {})).toThrowError(/not parseable/);
    expect(() => assertLocalDatabaseTarget('postgres://u:p@127.0.0.1/db;drop', {})).toThrowError(/allowed form/);
  });

  it('personas match master §17.3 and are recognised by key only', () => {
    expect(Object.keys(FIXTURE_PERSONAS).sort()).toEqual(['admin', 'buyer_a', 'buyer_b', 'creator_c', 'creator_d', 'dual_e', 'finance', 'moderator', 'suspended']);
    expect(new Set(Object.values(FIXTURE_PERSONAS).map((p) => p.id)).size).toBe(9);
    expect(Object.values(FIXTURE_PERSONAS).every((p) => p.email.endsWith('@example.test'))).toBe(true);
    expect(isFixturePersonaKey('admin')).toBe(true);
    expect(isFixturePersonaKey('toString')).toBe(false);
    expect(isFixturePersonaKey('__proto__')).toBe(false);
  });
});
