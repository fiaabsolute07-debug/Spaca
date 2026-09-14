import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizeXHandle, parseSignup, sanitizeSource } from '../../waitlist/lib/validate';

describe('waitlist input rules', () => {
  it('requires a valid email, a known role and explicit consent', () => {
    expect(parseSignup({ email: ' Founder@Proto.xyz ', role: 'project', consent: true })).toMatchObject({ ok: true, value: { email: 'founder@proto.xyz', role: 'project', honeypot: false } });
    expect(parseSignup({ email: 'nope', role: 'project', consent: true })).toMatchObject({ ok: false });
    expect(parseSignup({ email: 'a@b.co', role: 'investor', consent: true })).toMatchObject({ ok: false });
    expect(parseSignup({ email: 'a@b.co', role: 'creator', consent: 'true' })).toMatchObject({ ok: false });
    expect(parseSignup(null)).toMatchObject({ ok: false });
  });

  it('flags the honeypot without rejecting, so bots see a normal success', () => {
    expect(parseSignup({ email: 'a@b.co', role: 'creator', consent: true, website: 'http://spam' })).toMatchObject({ ok: true, value: { honeypot: true } });
  });

  it('normalizes emails and X handles', () => {
    expect(normalizeEmail('x'.repeat(250) + '@b.co')).toBeNull();
    expect(normalizeXHandle('@spaca_xyz')).toBe('spaca_xyz');
    expect(normalizeXHandle('https://x.com/SpacaXYZ?s=20')).toBe('SpacaXYZ');
    expect(normalizeXHandle('twitter.com/abc_1')).toBe('abc_1');
    expect(normalizeXHandle('has space')).toBeNull();
    expect(normalizeXHandle('waytoolonghandle123')).toBeNull();
  });

  it('keeps only short allow-listed attribution fields', () => {
    expect(sanitizeSource({ utm_source: ' x ', utm_campaign: 'launch', evil: 'drop', referrer: 'r'.repeat(500) }))
      .toEqual({ utm_source: 'x', utm_campaign: 'launch', referrer: 'r'.repeat(200) });
    expect(sanitizeSource('nope')).toEqual({});
  });
});
