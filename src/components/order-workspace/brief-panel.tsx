import { date, money, num, str, type Row } from '../ui';

export function OrderBriefPanel({ order: o }: { order: Row }) {
  return <div className="panel">
    <h2>Project brief</h2>
    <p className="prewrap">{o.brief_ready_at ? str(o.brief) : 'The buyer has not completed the brief yet.'}</p>
    <ul className="facts">
      <li><span>Work clock started</span><strong>{date(o.work_start_at)}</strong></li>
      <li><span>Delivery due</span><strong>{date(o.delivery_due_at)}</strong></li>
      {Boolean(o.revision_due_at) && <li><span>Revision due</span><strong>{date(o.revision_due_at)}</strong></li>}
      <li><span>Review deadline</span><strong>{date(o.review_due_at)}</strong></li>
      <li><span>Included revisions</span><strong>{num(o.revision_count)} / {num(o.revision_limit)} used</strong></li>
      <li><span>Auto-accept after review window</span><strong>{o.auto_accept_consent ? 'Agreed at checkout' : 'Not agreed'}</strong></li>
      <li><span>Settlement</span><strong>{str(o.settlement_status, 'NOT_READY')}</strong></li>
      {o.cancellation_refund_minor != null && <li><span>Agreed cancellation refund</span><strong>{money(o.cancellation_refund_minor)}</strong></li>}
    </ul>
  </div>;
}
