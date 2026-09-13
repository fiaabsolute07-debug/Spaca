import { describe, expect, it } from 'vitest';
import { atomicToUsdMinor, formatAtomic, parseDecimalToAtomic, settlementReference, usdMinorToAtomic } from '@/modules/crypto/registry';

describe('CRY-04 — exact atomic units', () => {
  it('converts USD cents to 6- and 18-decimal assets and back without rounding', () => {
    expect(usdMinorToAtomic(65000n, 6)).toBe(650_000_000n);
    expect(usdMinorToAtomic(65000n, 18)).toBe(650n * 10n ** 18n);
    expect(usdMinorToAtomic(1n, 18)).toBe(10n ** 16n);
    expect(atomicToUsdMinor(650n * 10n ** 18n, 18)).toBe(65000n);
    expect(atomicToUsdMinor(650_000_001n, 6)).toBeNull();
    expect(() => usdMinorToAtomic(100n, 0)).toThrow(/2 decimals/);
    const huge = 123_456_789_012_345_678_901_234n;
    expect(atomicToUsdMinor(usdMinorToAtomic(huge, 18), 18)).toBe(huge);
  });

  it('formats and parses decimals exactly', () => {
    expect(formatAtomic(650_000_000n, 6)).toBe('650.00');
    expect(formatAtomic(1n, 18)).toBe('0.000000000000000001');
    expect(formatAtomic(10n ** 18n + 5n * 10n ** 17n, 18)).toBe('1.50');
    expect(formatAtomic(0n, 6)).toBe('0.00');
    expect(parseDecimalToAtomic('650.000001', 6)).toBe(650_000_001n);
    expect(parseDecimalToAtomic('0.000000000000000001', 18)).toBe(1n);
    expect(() => parseDecimalToAtomic('1.0000001', 6)).toThrow(/decimal places/);
    expect(() => parseDecimalToAtomic('-1', 6)).toThrow();
    expect(() => parseDecimalToAtomic('1e6', 6)).toThrow();
  });

  it('builds an opaque bytes32 settlement reference', () => {
    const reference = settlementReference('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    expect(reference).toMatch(/^0x[0-9a-f]{64}$/);
    expect(reference).not.toContain('1111');
    expect(settlementReference('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333')).not.toBe(reference);
  });
});
