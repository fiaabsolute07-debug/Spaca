import Link from 'next/link';
import { GoalArt } from './goal-art';
import { Badge, money, num, rows, str } from '../ui';
import { CampaignBy } from './campaign-by';
import { closesIn } from './campaign-time';
import { goalByValue } from '@/modules/requests/goals';

/**
 * Open campaigns on a goal tab, as cards rather than board rows. A tab usually holds one or two campaigns, where a
 * five-column board reads like a spreadsheet with a single line in it; a card gives the project's own picture the room
 * it already has and puts pay, spots and the closing time where the eye lands. `/requests` keeps the board, because a
 * long list is easier to scan down a column than across a wall of cards.
 *
 * Every figure comes from the campaign row. A campaign with no picture shows its goal's drawing, never a stand-in
 * photograph, and a closing date nobody set is left out instead of invented.
 */
function CampaignCard({ item }: { item: Record<string, unknown> }) {
  const goal = goalByValue(item.campaign_goal);
  // Cards load the small copy made at upload; the full pictures stay on the campaign's own page.
  const thumbs = Array.isArray(item.thumb_ids) && item.thumb_ids.length
    ? item.thumb_ids.map(String)
    : Array.isArray(item.image_ids) ? item.image_ids.map(String) : [];
  const perCreator = num(item.per_creator_cap_minor);
  const needed = num(item.target_hires);
  const hired = num(item.hired_count);
  const closes = closesIn(item.application_deadline);

  return <li>
    <Link className="campaign-card" href={`/requests/${str(item.id)}`}>
      <span className="campaign-card-cover">
        {thumbs[0]
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed redirect, not a static asset
          ? <img src={`/api/request-images/${thumbs[0]}`} alt="" loading="lazy" />
          : goal ? <GoalArt goal={goal.value} /> : null}
        <span className="campaign-card-tags">
          <Badge>{str(item.status).toLowerCase()}</Badge>
          {goal ? <span className="badge badge-goal">{goal.title}</span> : null}
        </span>
      </span>
      <span className="campaign-card-body">
        <strong className="campaign-card-title">{str(item.title)}</strong>
        <span className="campaign-card-by"><CampaignBy name={item.buyer_name} avatarAssetId={item.buyer_avatar_asset_id} /></span>
        <span className="campaign-card-figures">
          <span>
            <b className="is-pay">{money(perCreator > 0 ? perCreator : item.budget_minor)}</b>
            <small>{perCreator > 0 ? 'per creator' : 'budget'}</small>
          </span>
          <span>
            <b>{hired}/{needed}</b>
            <small>spots</small>
          </span>
          <span>
            <b>{closes ?? '—'}</b>
            <small>{item.application_deadline ? 'to apply' : 'no closing date'}</small>
          </span>
        </span>
      </span>
    </Link>
  </li>;
}

export function CampaignCards({ items, label }: { items: unknown; label: string }) {
  const list = rows(items);
  if (!list.length) return null;
  // One or two cards in a three-up grid leave most of the row empty, so they lie down and fill it instead.
  return <ul className={`campaign-cards${list.length <= 2 ? ' is-few' : ''}`} aria-label={label}>
    {list.map((item) => <CampaignCard key={str(item.id)} item={item} />)}
  </ul>;
}
