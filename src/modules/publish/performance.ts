/**
 * Performance campaign arithmetic (master §9.6). Pure functions over integers, so every payout is reproducible from
 * the terms frozen at hire:
 *
 *   views_cap    = floor(baseline_median × median_multiplier)
 *   views_payable = min(views_measured, views_cap)
 *   view_bonus   = min(floor(views_payable / 1000) × rpm_rate, bonus_cap)
 *   payout       = base_fee + view_bonus
 *
 * The cap is what protects the buyer: a post that goes viral far beyond the creator's own median pays the cap, not the
 * views. Nothing here promises a return, and no value is invented when a measurement is missing.
 */
export const PERFORMANCE_POLICY_VERSION = 'performance-v1';
/** A creator needs this many recent original posts before a view bonus can be priced from their median. */
export const MIN_ELIGIBLE_POSTS = 10;
export const DEFAULT_MEDIAN_MULTIPLIER = 3;
export const DEFAULT_MEASURE_AFTER_DAYS = 7;
export const DEFAULT_VERIFY_DAYS = 7;
export const VIEWS_PER_RPM_UNIT = 1000n;

/** `floor(median × multiplier)`, with the multiplier carried as hundredths so no float rounding creeps in. */
export function viewsCap(medianViews: bigint, multiplier: number): bigint {
  const hundredths = BigInt(Math.round(multiplier * 100));
  if (hundredths <= 0n || medianViews < 0n) return 0n;
  return (medianViews * hundredths) / 100n;
}

export const viewsPayable = (measuredViews: bigint, cap: bigint) => (measuredViews < cap ? measuredViews : cap);

/** `min(floor(views / 1000) × rpm_rate, bonus_cap)`; whole thousands only, never above the cap. */
export function viewBonusMinor(payableViews: bigint, rpmRateMinor: bigint, bonusCapMinor: bigint): bigint {
  if (payableViews <= 0n || rpmRateMinor <= 0n || bonusCapMinor <= 0n) return 0n;
  const earned = (payableViews / VIEWS_PER_RPM_UNIT) * rpmRateMinor;
  return earned < bonusCapMinor ? earned : bonusCapMinor;
}

/** What the campaign holds for one hire: the fixed fee plus the whole bonus cap. */
export const maxPayoutMinor = (baseFeeMinor: bigint, bonusCapMinor: bigint) => baseFeeMinor + bonusCapMinor;

export type BonusOutcome = { viewsPayable: bigint; bonusMinor: bigint; payoutMinor: bigint; refundMinor: bigint };

/** The whole settlement for one measured post, from the frozen terms. */
export function settleMeasurement(input: { measuredViews: bigint; viewsCap: bigint; rpmRateMinor: bigint; bonusCapMinor: bigint; baseFeeMinor: bigint }): BonusOutcome {
  const payable = viewsPayable(input.measuredViews, input.viewsCap);
  const bonus = viewBonusMinor(payable, input.rpmRateMinor, input.bonusCapMinor);
  const payout = input.baseFeeMinor + bonus;
  return { viewsPayable: payable, bonusMinor: bonus, payoutMinor: payout, refundMinor: input.bonusCapMinor - bonus };
}
