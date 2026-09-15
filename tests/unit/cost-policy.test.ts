import { afterEach, describe, expect, it, vi } from 'vitest';
import { lateCostCapBps, lateCostShares, type LateCostInput } from '@/modules/payments/cost-policy';

const base: LateCostInput = { delta: 0n, feePayer: 'CREATOR_AT_COST', phase: 'BEFORE_RELEASE', creatorGross: 65000n, creatorBorne: 1950n, capMinor: 650n, creatorLateIncreasesSoFar: 0n };
const shares = (overrides: Partial<LateCostInput>) => lateCostShares({ ...base, ...overrides });

afterEach(() => vi.unstubAllEnvs());

describe('PAY-16 cost-v1 late provider costs', () => {
  it('before payout the creator bears an increase up to the cumulative cap; the rest is a platform expense', () => {
    expect(shares({ delta: 400n })).toEqual({ creatorShare: 400n, platformShare: 0n, creatorCredit: 0n });
    expect(shares({ delta: 1000n })).toEqual({ creatorShare: 650n, platformShare: 350n, creatorCredit: 0n });
    expect(shares({ delta: 1000n, creatorLateIncreasesSoFar: 650n })).toEqual({ creatorShare: 0n, platformShare: 1000n, creatorCredit: 0n });
  });

  it('never leaves the creator with a zero or negative net', () => {
    expect(shares({ delta: 5000n, creatorGross: 3000n, creatorBorne: 2500n, capMinor: 10_000n })).toEqual({ creatorShare: 499n, platformShare: 4501n, creatorCredit: 0n });
    expect(shares({ delta: 5000n, creatorGross: 2500n, creatorBorne: 2500n, capMinor: 10_000n })).toEqual({ creatorShare: 0n, platformShare: 5000n, creatorCredit: 0n });
  });

  it('a decrease before payout lowers the creator’s cost, never below zero', () => {
    expect(shares({ delta: -500n })).toEqual({ creatorShare: -500n, platformShare: 0n, creatorCredit: 0n });
    expect(shares({ delta: -3000n })).toEqual({ creatorShare: -1950n, platformShare: -1050n, creatorCredit: 0n });
  });

  it('after payout nothing is taken back; a lower final cost the creator paid becomes a credit owed to them', () => {
    expect(shares({ phase: 'AFTER_RELEASE', delta: 900n })).toEqual({ creatorShare: 0n, platformShare: 900n, creatorCredit: 0n });
    expect(shares({ phase: 'AFTER_RELEASE', delta: -500n })).toEqual({ creatorShare: 0n, platformShare: -500n, creatorCredit: 500n });
    expect(shares({ phase: 'AFTER_RELEASE', delta: -5000n })).toEqual({ creatorShare: 0n, platformShare: -5000n, creatorCredit: 1950n });
  });

  it('a subsidized policy or an order with nothing to settle to the creator puts every change on the platform', () => {
    expect(shares({ feePayer: 'PLATFORM_SUBSIDIZED', delta: 900n })).toEqual({ creatorShare: 0n, platformShare: 900n, creatorCredit: 0n });
    expect(shares({ feePayer: 'PLATFORM_SUBSIDIZED', phase: 'AFTER_RELEASE', delta: -900n })).toEqual({ creatorShare: 0n, platformShare: -900n, creatorCredit: 0n });
    expect(shares({ phase: 'NO_CREATOR_SETTLEMENT', delta: 900n })).toEqual({ creatorShare: 0n, platformShare: 900n, creatorCredit: 0n });
  });

  it('reads the cap from LATE_COST_CAP_BPS within 0–10%, defaulting to 1%', () => {
    expect(lateCostCapBps()).toBe(100);
    vi.stubEnv('LATE_COST_CAP_BPS', '250');
    expect(lateCostCapBps()).toBe(250);
    vi.stubEnv('LATE_COST_CAP_BPS', '5000');
    expect(lateCostCapBps()).toBe(100);
    vi.stubEnv('LATE_COST_CAP_BPS', '0');
    expect(lateCostCapBps()).toBe(0);
  });
});
