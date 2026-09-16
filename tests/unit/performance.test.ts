import { describe, expect, it } from 'vitest';
import { MIN_ELIGIBLE_POSTS, maxPayoutMinor, settleMeasurement, viewBonusMinor, viewsCap, viewsPayable } from '@/modules/publish/performance';
import { baselineFor, postViews } from '@/modules/publish/metrics';

describe('§9.6 performance payouts: the creator is paid for reach, the buyer only up to the cap', () => {
  it('follows the worked example in the spec: 20 USD fee, 2 USD per 1000 views, 80 USD cap, median 8000', () => {
    const baseFeeMinor = 2000n, rpmRateMinor = 200n, bonusCapMinor = 8000n;
    const cap = viewsCap(8000n, 3);
    expect(cap).toBe(24_000n);
    // The post reaches 150,000 views, far past the creator's own median: only the capped views are paid.
    const outcome = settleMeasurement({ measuredViews: 150_000n, viewsCap: cap, rpmRateMinor, bonusCapMinor, baseFeeMinor });
    expect(outcome.viewsPayable).toBe(24_000n);
    expect(outcome.bonusMinor).toBe(4800n);
    expect(outcome.payoutMinor).toBe(6800n);
    // The campaign held 100 USD for this hire, so 32 USD goes back to the buyer.
    expect(maxPayoutMinor(baseFeeMinor, bonusCapMinor)).toBe(10_000n);
    expect(outcome.refundMinor).toBe(3200n);
  });

  it('rounds views down to whole thousands, never pays above the cap, and pays nothing without views', () => {
    expect(viewBonusMinor(1999n, 200n, 8000n)).toBe(200n);
    expect(viewBonusMinor(999n, 200n, 8000n)).toBe(0n);
    expect(viewBonusMinor(0n, 200n, 8000n)).toBe(0n);
    // 60 thousands × 2 USD = 120 USD of earnings, but the cap is 80 USD.
    expect(viewBonusMinor(60_000n, 200n, 8000n)).toBe(8000n);
    expect(viewsPayable(10n, 24_000n)).toBe(10n);
    expect(viewsPayable(24_001n, 24_000n)).toBe(24_000n);
  });

  it('takes the cap from the creator\'s own median, with fractional multipliers kept exact', () => {
    expect(viewsCap(8000n, 2.5)).toBe(20_000n);
    expect(viewsCap(333n, 1.5)).toBe(499n); // floor(499.5)
    expect(viewsCap(0n, 3)).toBe(0n);
    expect(viewsCap(8000n, 0)).toBe(0n);
  });

  it('settles a quiet post: the bonus is small and most of the hold returns to the buyer', () => {
    const outcome = settleMeasurement({ measuredViews: 1200n, viewsCap: 24_000n, rpmRateMinor: 200n, bonusCapMinor: 8000n, baseFeeMinor: 2000n });
    expect(outcome).toEqual({ viewsPayable: 1200n, bonusMinor: 200n, payoutMinor: 2200n, refundMinor: 7800n });
  });
});

describe('mock view metrics are deterministic and say when a creator cannot take a performance campaign', () => {
  it('gives one account the same history every time, and different accounts different ones', () => {
    const first = baselineFor({ handle: '@launchwriter', accountId: 'a1' });
    const again = baselineFor({ handle: '@launchwriter', accountId: 'a1' });
    const other = baselineFor({ handle: '@another', accountId: 'a2' });
    expect(again).toEqual(first);
    expect(first.source).toBe('mock-metrics-v1');
    expect(first.median_views).toBeGreaterThan(0n);
    expect(first.eligible).toBe(first.eligible_posts >= MIN_ELIGIBLE_POSTS);
    expect([other.median_views !== first.median_views, other.eligible_posts !== first.eligible_posts]).toContain(true);
  });

  it('reads a post the same way twice and reports the signals that must hold a bonus', () => {
    const post = { postUrl: 'https://x.com/launchwriter/status/1000000000001', baselineMedian: 8000n };
    const first = postViews(post);
    expect(postViews(post)).toEqual(first);
    expect(first.views).toBeGreaterThanOrEqual(0n);
    expect(first.source).toBe('mock-metrics-v1');
    for (const signal of first.signals) expect(['VIEWS_FAR_ABOVE_MEDIAN', 'ENGAGEMENT_TOO_LOW_FOR_VIEWS']).toContain(signal);
    // A tiny median cannot produce a huge count without raising the spike signal.
    const spike = postViews({ postUrl: 'https://x.com/someone/status/42', baselineMedian: 1n });
    expect(spike.views <= 20n || spike.signals.includes('VIEWS_FAR_ABOVE_MEDIAN')).toBe(true);
  });
});
