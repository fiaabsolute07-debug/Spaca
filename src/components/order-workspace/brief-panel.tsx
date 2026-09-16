import { date, money, num, row, str, type Row, humanize } from '../ui';

/** What was hired beyond the brief: the length of a live session, or the rights a commissioned file comes with. */
function AgreedTerms({ terms }: { terms: unknown }) {
  const agreed = (terms ?? {}) as { access?: unknown; license?: unknown };
  const access = agreed.access ? row(agreed.access) : null;
  const license = agreed.license ? row(agreed.license) : null;
  if (!access && !license) return null;
  return <>
    {access && <>
      <li><span>Live session</span><strong>{num(access.session_minutes)} minutes</strong></li>
      <li><span>Time</span><strong>Agreed here in the messages</strong></li>
    </>}
    {license && <>
      <li><span>License</span><strong>{str(license.kind) === 'EXCLUSIVE' ? 'Exclusive to the buyer' : 'Non-exclusive'}</strong></li>
      <li><span>Rights</span><strong className="prewrap">{str(license.rights_text)}</strong></li>
    </>}
  </>;
}

export function OrderBriefPanel({ order: o, digital = false }: { order: Row; digital?: boolean }) {
  // A DIGITAL purchase has no brief, work clock or revisions: the files are delivered on payment.
  if (digital) return <div className="panel">
    <h2>Purchase</h2>
    <ul className="facts">
      <li><span>Paid</span><strong>{date(o.funded_at)}</strong></li>
      <li><span>Review deadline</span><strong>{date(o.review_due_at)}</strong></li>
      <li><span>Auto-accept after review window</span><strong>{o.auto_accept_consent ? 'Agreed at checkout' : 'Not agreed'}</strong></li>
      <li><span>Settlement</span><strong>{humanize(str(o.settlement_status, 'NOT_READY'))}</strong></li>
      {o.cancellation_refund_minor != null && <li><span>Agreed cancellation refund</span><strong>{money(o.cancellation_refund_minor)}</strong></li>}
    </ul>
  </div>;
  return <div className="panel">
    <h2>Project brief</h2>
    <p className="prewrap">{o.brief_ready_at ? str(o.brief) : 'The buyer has not completed the brief yet.'}</p>
    <ul className="facts">
      <li><span>Work clock started</span><strong>{date(o.work_start_at)}</strong></li>
      <li><span>Delivery due</span><strong>{date(o.delivery_due_at)}</strong></li>
      {Boolean(o.revision_due_at) && <li><span>Revision due</span><strong>{date(o.revision_due_at)}</strong></li>}
      <li><span>Review deadline</span><strong>{date(o.review_due_at)}</strong></li>
      <li><span>Included revisions</span><strong>{num(o.revision_count)} / {num(o.revision_limit)} used</strong></li>
      <AgreedTerms terms={o.terms} />
      <li><span>Auto-accept after review window</span><strong>{o.auto_accept_consent ? 'Agreed at checkout' : 'Not agreed'}</strong></li>
      <li><span>Settlement</span><strong>{humanize(str(o.settlement_status, 'NOT_READY'))}</strong></li>
      {o.cancellation_refund_minor != null && <li><span>Agreed cancellation refund</span><strong>{money(o.cancellation_refund_minor)}</strong></li>}
    </ul>
  </div>;
}
