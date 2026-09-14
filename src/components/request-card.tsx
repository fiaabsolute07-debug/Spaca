import Link from 'next/link';
import { Badge, money, num, row, str } from './ui';

export function RequestCard({
  item
}: {
  item: unknown;
}) {
  const r = row(item);
  return <Link className="panel" href={`/requests/${str(r.id)}`}>
    <div className="inline-actions">
      <Badge>
        {str(r.taxonomy).toLowerCase()}
      </Badge>
      <Badge>
        {str(r.status).toLowerCase()}
      </Badge>
    </div>
    <h3>
      {str(r.title)}
    </h3>
    <p>
      {str(r.brief).slice(0, 180)}
    </p>
    <div className="service-bottom">
      <strong>
        {money(r.budget_minor)}
        {" budget"}
      </strong>
      <span>
        {num(r.target_hires)}
        {" creator"}
        {num(r.target_hires) !== 1 ? 's' : ''}
        {" · "}
        {num(r.application_count)}
        {" applications"}
      </span>
    </div>
  </Link>;
}
