import Link from 'next/link';
import { CategoryBadge, categoryOf } from './category';
import { Badge, date, money, num, row, str } from './ui';
import { goalByValue } from '@/modules/requests/goals';

/** Campaign card: the buyer's first image (or the category's color and icon), what they need, budget and interest. */
export function RequestCard({
  item
}: {
  item: unknown;
}) {
  const r = row(item);
  // Cards load the small copy made at upload; a campaign without one falls back to the original.
  const images = Array.isArray(r.thumb_ids) && r.thumb_ids.length ? r.thumb_ids.map(String) : Array.isArray(r.image_ids) ? r.image_ids.map(String) : [];
  const category = categoryOf(r.taxonomy);
  const hires = num(r.target_hires);
  const brief = str(r.brief);
  return <Link className="panel campaign-card" href={`/requests/${str(r.id)}`}>
    <div className="campaign-cover">
      {images[0] ? <img src={`/api/request-images/${images[0]}`} alt="" loading="lazy" /> : category.icon}
      {images.length > 1 && <span className="campaign-cover-count">+{images.length - 1}</span>}
    </div>
    <div className="campaign-body">
      <div className="inline-actions">
        {goalByValue(r.campaign_goal) ? <span className="badge badge-goal">{goalByValue(r.campaign_goal)!.title}</span> : null}
        <CategoryBadge value={r.taxonomy} />
        <Badge>{str(r.status).toLowerCase()}</Badge>
      </div>
      <h3>{str(r.title)}</h3>
      {r.buyer_name ? <span className="campaign-by">by {str(r.buyer_name)}</span> : null}
      <p>{brief.length > 140 ? `${brief.slice(0, 140)}…` : brief}</p>
      <div className="campaign-meta">
        <span><strong className="campaign-budget">{money(r.budget_minor)}</strong> budget</span>
        <span>{hires} creator{hires !== 1 ? 's' : ''} · {num(r.application_count)} applications</span>
      </div>
      {r.application_deadline ? <small className="muted">Applications close {date(r.application_deadline)}</small> : null}
    </div>
  </Link>;
}
