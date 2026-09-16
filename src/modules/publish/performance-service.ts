/**
 * Performance campaigns at work (master §9.6): schedule the checkpoint when the post goes live, measure it once, hold
 * anything that looks bought, and settle the bonus from the hold the campaign already paid.
 *
 * Money never appears from nowhere: the order was funded for the fixed fee plus the whole bonus cap, so settlement only
 * decides how that hold splits between the creator (fee + earned bonus) and the buyer (the unused rest).
 */
import type { Row, Tx } from '@/lib/commands';
import { openCase } from '@/modules/payments/funding';
import { postViews } from './metrics';
import { settleMeasurement } from './performance';

export type PerformanceTerms = {
  baseline_id: string;
  baseline_median: string;
  views_cap: string;
  base_fee_minor: string;
  rpm_rate_minor: string;
  bonus_cap_minor: string;
  max_payout_minor: string;
  measure_after_days: number;
  verify_days: number;
  baseline_source: string;
};

/** The frozen performance terms of an order, or null for every other kind of order. */
export function performanceTermsOf(terms: unknown): PerformanceTerms | null {
  const performance = (terms as { performance?: PerformanceTerms } | null)?.performance;
  return performance && typeof performance.baseline_id === 'string' ? performance : null;
}

/**
 * Books the checkpoint for a published post. Re-delivering before anything is measured replaces the schedule, because
 * the post that will be measured is the one that is live now; a measured checkpoint is never rewritten.
 */
export async function schedulePerformanceMeasurement(tx: Tx, order: Row, proof: { postUrl: string; publishedAt: Date }): Promise<boolean> {
  const performance = performanceTermsOf(order.terms);
  if (!performance) return false;
  const measureAt = new Date(proof.publishedAt.getTime() + performance.measure_after_days * 86_400_000);
  await tx`delete from app.performance_measurements where order_id=${String(order.id)} and status='SCHEDULED'`;
  await tx`insert into app.performance_measurements (order_id,baseline_id,baseline_median,views_cap,rpm_rate_minor,bonus_cap_minor,post_url,published_at,measure_at,source)
    values (${String(order.id)},${performance.baseline_id},${performance.baseline_median},${performance.views_cap},${performance.rpm_rate_minor},${performance.bonus_cap_minor},
      ${proof.postUrl},${proof.publishedAt.toISOString()},${measureAt.toISOString()},${performance.baseline_source})
    on conflict (order_id) do nothing`;
  return true;
}

export type MeasureOutcome = 'MEASURED' | 'HELD' | 'SKIPPED_STATE_CHANGED';

/**
 * Reads the post once at its checkpoint and writes the result as a fact. Views above the creator's frozen cap are not
 * paid, and a count that does not look earned is held for a person to review instead of paying it.
 */
export async function measurePerformancePost(tx: Tx, orderId: string): Promise<MeasureOutcome> {
  const [row] = await tx<Row[]>`select * from app.performance_measurements where order_id=${orderId} and status='SCHEDULED' and measure_at <= now() for update`;
  if (!row) return 'SKIPPED_STATE_CHANGED';
  const [order] = await tx<Row[]>`select id,terms from app.orders where id=${orderId} for update`;
  const performance = order ? performanceTermsOf(order.terms) : null;
  if (!performance) return 'SKIPPED_STATE_CHANGED';
  const metrics = postViews({ postUrl: String(row.post_url), baselineMedian: BigInt(String(row.baseline_median)) });
  const outcome = settleMeasurement({
    measuredViews: metrics.views,
    viewsCap: BigInt(String(row.views_cap)),
    rpmRateMinor: BigInt(String(row.rpm_rate_minor)),
    bonusCapMinor: BigInt(String(row.bonus_cap_minor)),
    baseFeeMinor: BigInt(String(performance.base_fee_minor)),
  });
  const held = metrics.signals.length > 0;
  const verifyUntil = new Date(Date.now() + performance.verify_days * 86_400_000);
  await tx`update app.performance_measurements set measured_views=${metrics.views.toString()},views_payable=${outcome.viewsPayable.toString()},
      bonus_minor=${outcome.bonusMinor.toString()},status=${held ? 'HELD' : 'MEASURED'},hold_reason=${held ? metrics.signals.join(',') : null},
      verify_until=${held ? null : verifyUntil.toISOString()},measured_at=now(),source=${metrics.source}
    where order_id=${orderId}`;
  if (held) {
    await openCase(tx, orderId, null, 'PERFORMANCE_BONUS_REVIEW', 'MEDIUM',
      `View bonus held for review (${metrics.signals.join(', ')}); decide the bonus before the order settles`);
  }
  return held ? 'HELD' : 'MEASURED';
}

export type SettleOutcome = 'SETTLED' | 'SKIPPED_STATE_CHANGED';

/**
 * Approves a measurement whose verification window has passed and records what the buyer gets back, so the release job
 * pays the creator the fee plus the earned bonus and the refund job returns the unused hold.
 */
export async function approvePerformanceBonus(tx: Tx, orderId: string): Promise<SettleOutcome> {
  const [row] = await tx<Row[]>`select * from app.performance_measurements where order_id=${orderId} and status='MEASURED' and verify_until <= now() for update`;
  if (!row) return 'SKIPPED_STATE_CHANGED';
  const unused = BigInt(String(row.bonus_cap_minor)) - BigInt(String(row.bonus_minor));
  await tx`update app.performance_measurements set status='APPROVED',settled_at=now() where order_id=${orderId}`;
  await tx`update app.orders set performance_refund_minor=${unused.toString()},version=version+1,updated_at=now() where id=${orderId}`;
  return 'SETTLED';
}
