import { Badge, date, money, num, row, str, type Row } from '../ui';

const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Waiting for the checkpoint',
  MEASURED: 'Counted, in the checking period',
  HELD: 'On hold for review',
  APPROVED: 'Bonus final',
  REJECTED: 'No bonus after review',
};

/**
 * §9.6: what a performance hire pays and where its bonus stands. The order held the fixed fee plus the whole bonus cap,
 * so this panel only ever says how that hold splits; it never predicts a bonus before the post is counted.
 */
export function OrderPerformancePanel({ order, terms, measurement }: { order: Row; terms: Row | null; measurement: Row | null }) {
  if (!terms) return null;
  const status = measurement ? str(measurement.status) : 'SCHEDULED';
  const refund = order.performance_refund_minor == null ? null : order.performance_refund_minor;
  return <section className="panel" aria-labelledby="performance-heading">
    <div className="inline-actions">
      <h2 id="performance-heading">View bonus</h2>
      <Badge tone={status === 'APPROVED' ? 'good' : status === 'HELD' || status === 'REJECTED' ? 'bad' : 'waiting'}>{STATUS_LABEL[status] ?? status}</Badge>
    </div>
    <ul className="facts">
      <li><span>Held for this hire</span><strong>{money(terms.max_payout_minor)}</strong></li>
      <li><span>Fixed fee</span><strong>{money(terms.base_fee_minor)}</strong></li>
      <li><span>Bonus per 1,000 views</span><strong>{money(terms.rpm_rate_minor)}</strong></li>
      <li><span>Most bonus</span><strong>{money(terms.bonus_cap_minor)}</strong></li>
      <li><span>Views that can be paid</span><strong>{num(terms.views_cap)}</strong></li>
      <li><span>Counted from the creator&apos;s median</span><strong>{num(terms.baseline_median)} views × {num(terms.median_multiplier)}</strong></li>
      {measurement ? <li><span>Counted on</span><strong>{date(measurement.measure_at)}</strong></li>
        : <li><span>Counted</span><strong>{num(terms.measure_after_days)} days after the post goes live</strong></li>}
      {measurement?.measured_views != null && <li><span>Views counted</span><strong>{num(measurement.measured_views)}</strong></li>}
      {measurement?.bonus_minor != null && <li><span>{status === 'REJECTED' ? 'Bonus after review' : 'Bonus earned'}</span><strong>{money(status === 'REJECTED' ? 0 : measurement.bonus_minor)}</strong></li>}
      {refund != null && <li><span>Returned to the buyer</span><strong>{money(refund)}</strong></li>}
    </ul>
    {status === 'HELD' && <p className="notice">This bonus is on hold for review ({str(measurement?.hold_reason).toLowerCase().replaceAll('_', ' ')}). Nothing is paid until a person decides.</p>}
    {status === 'REJECTED' && <p className="notice">A reviewer decided the count of {num(measurement?.measured_views)} views was not earned. Only the fixed fee is paid; the whole bonus hold goes back to the buyer.</p>}
    {status === 'MEASURED' && measurement?.verify_until ? <p className="muted">The count is checked until {date(measurement.verify_until)}. The fixed fee and the earned bonus are released after that.</p> : null}
    {status === 'SCHEDULED' && <p className="muted">Views are counted once, at the checkpoint, from the creator&apos;s own account. Screenshots are not accepted.</p>}
    <p className="muted">Source: {str(measurement?.source ?? terms.baseline_source)} (simulated metrics in this local sandbox).</p>
  </section>;
}

export const performanceTermsRow = (terms: unknown) => {
  const performance = (terms as { performance?: unknown } | null)?.performance;
  return performance ? row(performance) : null;
};
