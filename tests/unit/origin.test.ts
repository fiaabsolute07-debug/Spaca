import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSameOrigin, requestHostname } from '../../src/lib/auth';

const req = (url: string, headers: Record<string, string>) => new Request(url, { method: 'POST', headers });

afterEach(() => vi.unstubAllEnvs());

describe('SEC-08 — same-origin guard for cookie-authenticated mutations', () => {
  it('accepts the origin the browser actually targeted even when the framework resolved another host', () => {
    // Next dev resolves request.url to localhost while the browser is on 127.0.0.1.
    expect(isSameOrigin(req('http://localhost:3100/api/commands', { origin: 'http://127.0.0.1:3100', host: '127.0.0.1:3100' }))).toBe(true);
    expect(isSameOrigin(req('http://localhost:3000/api/commands', { origin: 'http://localhost:3000' }))).toBe(true);
  });

  it('honours X-Forwarded-Host/Proto behind a proxy and APP_BASE_URL', () => {
    expect(isSameOrigin(req('http://10.0.0.5:3000/api/commands', { origin: 'https://market.example', 'x-forwarded-host': 'market.example', 'x-forwarded-proto': 'https' }))).toBe(true);
    vi.stubEnv('APP_BASE_URL', 'https://app.example.com/');
    expect(isSameOrigin(req('http://10.0.0.5:3000/api/commands', { origin: 'https://app.example.com' }))).toBe(true);
  });

  it('rejects cross-site, missing, null and malformed origins', () => {
    expect(isSameOrigin(req('http://localhost:3000/api/commands', { origin: 'https://attacker.test', host: 'localhost:3000' }))).toBe(false);
    expect(isSameOrigin(req('http://localhost:3000/api/commands', { host: 'localhost:3000' }))).toBe(false);
    expect(isSameOrigin(req('http://localhost:3000/api/commands', { origin: 'null', host: 'localhost:3000' }))).toBe(false);
    expect(isSameOrigin(req('http://localhost:3000/api/commands', { origin: 'not a url', host: 'localhost:3000' }))).toBe(false);
    expect(isSameOrigin(req('http://localhost:3000/api/commands', { origin: 'http://localhost:3000.attacker.test', host: 'localhost:3000' }))).toBe(false);
    expect(isSameOrigin(req('http://localhost:3000/api/commands', { origin: 'https://localhost:3000', host: 'localhost:3000' }))).toBe(false);
  });

  it('ignores header values that are not hosts', () => {
    expect(isSameOrigin(req('http://localhost:3000/api/commands', { origin: 'http://evil', host: 'evil/path' }))).toBe(false);
    expect(requestHostname(req('http://localhost:3000/x', { host: '127.0.0.1:3000' }))).toBe('127.0.0.1');
  });
});

describe('redirects stay on the origin the browser used', () => {
  it('builds redirect URLs from Host, not the framework-resolved URL', async () => {
    const { publicUrl } = await import('../../src/lib/auth');
    expect(publicUrl(req('http://localhost:3100/api/commands', { host: '127.0.0.1:3100' }), '/orders/1?message=ok').toString()).toBe('http://127.0.0.1:3100/orders/1?message=ok');
    expect(publicUrl(req('http://10.0.0.5:3000/api/commands', { 'x-forwarded-host': 'market.example', 'x-forwarded-proto': 'https' }), '/dashboard').toString()).toBe('https://market.example/dashboard');
    expect(publicUrl(req('http://localhost:3100/api/commands', { host: '127.0.0.1:3100' }), '//evil.example/x').toString()).toBe('http://127.0.0.1:3100/');
    expect(publicUrl(req('http://localhost:3100/api/commands', { host: 'evil/path' }), '/x').toString()).toBe('http://localhost:3100/x');
  });
});
