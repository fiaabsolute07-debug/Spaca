import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword, hashSessionToken, isSameOrigin, localAuthEnabled } from '../src/lib/auth';

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
  it('never enables local credentials in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try { expect(localAuthEnabled()).toBe(false); } finally { vi.unstubAllEnvs(); }
  });
});
