import { date, num, str, type Row } from '../ui';

export function OrderBriefPanel({
  order: o
}: {
  order: Row;
}) {
  return <div className="panel">
    <h2>Project brief</h2>
    <p className="prewrap">
      {str(o.brief)}
    </p>
    <ul className="facts">
      <li>
        <span>Delivery due</span>
        <strong>
          {date(o.delivery_due_at)}
        </strong>
      </li>
      <li>
        <span>Review deadline</span>
        <strong>
          {date(o.review_due_at)}
        </strong>
      </li>
      <li>
        <span>Included revisions</span>
        <strong>
          {num(o.revision_count)}
          {" / 1 used"}
        </strong>
      </li>
      <li>
        <span>Settlement</span>
        <strong>
          {str(o.settlement_status, 'NOT_READY')}
        </strong>
      </li>
    </ul>
  </div>;
}
