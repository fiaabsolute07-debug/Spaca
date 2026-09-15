/**
 * PAY-16 cost policy `cost-v1`: who bears a provider cost that changes after capture.
 *
 * - The creator can bear a late increase only before their payout is sent, only under CREATOR_AT_COST, only up to a cap
 *   (a share of the order amount, cumulative per order), and never so much that their net would stop being positive.
 * - A late decrease before payout lowers the cost the creator bears (never below zero).
 * - After the payout is sent nothing is taken back: increases are a platform expense; decreases the creator had paid
 *   become a credit owed to them, decided by an operator.
 * - PLATFORM_SUBSIDIZED: the platform bears every change.
 */
export const COST_POLICY_VERSION = 'cost-v1';
export const DEFAULT_LATE_COST_CAP_BPS = 100;

export type CostPhase = 'BEFORE_RELEASE' | 'AFTER_RELEASE' | 'NO_CREATOR_SETTLEMENT';

export type LateCostInput = {
  /** actual − previously known provider cost. */
  delta: bigint;
  feePayer: 'CREATOR_AT_COST' | 'PLATFORM_SUBSIDIZED';
  phase: CostPhase;
  /** What the creator is entitled to before costs (order amount minus any agreed refund). */
  creatorGross: bigint;
  /** Provider cost currently deducted from the creator. */
  creatorBorne: bigint;
  /** Cap on the creator's cumulative late increases, and what they already bore of it. */
  capMinor: bigint;
  creatorLateIncreasesSoFar: bigint;
};

export type LateCostShares = { creatorShare: bigint; platformShare: bigint; creatorCredit: bigint };

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

export function lateCostShares(input: LateCostInput): LateCostShares {
  const { delta, feePayer, phase } = input;
  if (delta === 0n || feePayer === 'PLATFORM_SUBSIDIZED' || phase === 'NO_CREATOR_SETTLEMENT') {
    return { creatorShare: 0n, platformShare: delta, creatorCredit: 0n };
  }
  if (phase === 'AFTER_RELEASE') {
    // Never a retroactive debit. A lower final cost the creator already paid is owed back to them.
    const creatorCredit = delta < 0n ? min(-delta, input.creatorBorne) : 0n;
    return { creatorShare: 0n, platformShare: delta, creatorCredit };
  }
  if (delta > 0n) {
    const capRemaining = max(0n, input.capMinor - input.creatorLateIncreasesSoFar);
    const keepsNetPositive = max(0n, input.creatorGross - input.creatorBorne - 1n);
    const creatorShare = min(delta, min(capRemaining, keepsNetPositive));
    return { creatorShare, platformShare: delta - creatorShare, creatorCredit: 0n };
  }
  const creatorShare = -min(-delta, input.creatorBorne);
  return { creatorShare, platformShare: delta - creatorShare, creatorCredit: 0n };
}

/** Cap in basis points of the order amount from `LATE_COST_CAP_BPS` (0–1000), default 1%. */
export function lateCostCapBps(): number {
  const raw = process.env.LATE_COST_CAP_BPS;
  if (raw === undefined || raw === '') return DEFAULT_LATE_COST_CAP_BPS;
  const bps = Number(raw);
  return Number.isInteger(bps) && bps >= 0 && bps <= 1000 ? bps : DEFAULT_LATE_COST_CAP_BPS;
}
