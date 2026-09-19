import { describe, expect, it, vi } from 'vitest';
import { appSessionsEnabled, DECOY_PASSWORD_HASH, devSessionsEnabled, hashPassword, verifyPassword, hashSessionToken, isSameOrigin } from '../src/lib/auth';

describe('local development password and session primitives', () => {
  it('uses randomized salts and rejects incorrect passwords', () => {
    const a = hashPassword('correct horse battery');
    const b = hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(verifyPassword('correct horse battery',a)).toBe(true);
    expect(verifyPassword('incorrect horse battery',a)).toBe(false);
  });
  it('rejects malformed digests and oversized inputs', () => {
    expect(verifyPassword('password','scrypt:bad:bad')).toBe(false);
    // The decoy an unknown address is verified against must look like a stored hash, or verifyPassword bails on the
    // format and skips the scrypt work the timing fix depends on (audit F8).
    expect(DECOY_PASSWORD_HASH).toMatch(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
    expect(verifyPassword('anything at all', DECOY_PASSWORD_HASH)).toBe(false);
    expect(verifyPassword('x'.repeat(257),hashPassword('password'))).toBe(false);
  });
  it('stores a one-way fixed length digest of a token', () => {
    const token = 'a'.repeat(64);
    expect(hashSessionToken(token)).toHaveLength(64);
    expect(hashSessionToken(token)).not.toBe(token);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });
  it('requires exact same origin for cookie authenticated mutations', () => {
    expect(isSameOrigin(new Request('http://localhost:3000/api/auth',{headers:{origin:'http://localhost:3000'}}))).toBe(true);
    expect(isSameOrigin(new Request('http://localhost:3000/api/auth',{headers:{origin:'https://attacker.test'}}))).toBe(false);
    expect(isSameOrigin(new Request('http://localhost:3000/api/auth'))).toBe(false);
  });
  it('never enables fixture sessions in production; first-party sessions there only with AUTH_MODE=app', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(appSessionsEnabled()).toBe(false);
      expect(devSessionsEnabled()).toBe(false);
      vi.stubEnv('AUTH_MODE', 'app');
      expect(appSessionsEnabled()).toBe(true);
      expect(devSessionsEnabled()).toBe(false);
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('AUTH_MODE', 'supabase');
      expect(appSessionsEnabled()).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
});
