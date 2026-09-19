import Link from 'next/link';
import { GoalArt } from './goal-art';
import { Badge, money, num, rows, str } from '../ui';
import { CampaignBy } from './campaign-by';
import { closesIn, shortDate } from './campaign-time';
import { goalByValue } from '@/modules/requests/goals';

/** Filled spots first, then the empty ones; the row of slanted marks echoes the three bars of the logo. */
function Spots({ hired, needed }: { hired: number; needed: number }) {
  if (needed <= 0) return null;
  const shown = Math.min(needed, 10);
  return <span className="spots" aria-hidden>
    {Array.from({ length: shown }, (_, index) => <i key={index} className={index < hired ? 'is-filled' : ''} />)}
  </span>;
}

function BoardRow({ item }: { item: Record<string, unknown> }) {
  const goal = goalByValue(item.campaign_goal);
  // Rows load the small copy made at upload; a campaign without one shows its goal's drawing instead.
  const thumbs = Array.isArray(item.thumb_ids) && item.thumb_ids.length
    ? item.thumb_ids.map(String)
    : Array.isArray(item.image_ids) ? item.image_ids.map(String) : [];
  const perCreator = num(item.per_creator_cap_minor);
  const needed = num(item.target_hires);
  const hired = num(item.hired_count);
  const closes = closesIn(item.application_deadline);

  return <li>
    <Link className="board-row" href={`/requests/${str(item.id)}`}>
      <span className="board-campaign">
        <span className="board-mark">
          {thumbs[0]
            ? <img src={`/api/request-images/${thumbs[0]}`} alt="" loading="lazy" />
            : goal ? <GoalArt goal={goal.value} size={22} /> : null}
        </span>
        <span className="board-name">
          <strong>{str(item.title)}</strong>
          <small>
            <CampaignBy name={item.buyer_name} avatarAssetId={item.buyer_avatar_asset_id} />
            {goal ? <span className="badge badge-goal">{goal.title}</span> : null}
          </small>
        </span>
      </span>
      <span className="board-figure board-pay">
        <span className="board-value is-pay">{money(perCreator > 0 ? perCreator : item.budget_minor)}</span>
        <small>{perCreator > 0 ? 'per creator' : 'budget'}</small>
      </span>
      <span className="board-figure board-spots">
        <span className="board-value">{hired}/{needed}</span>
        <small>spots</small>
        <Spots hired={hired} needed={needed} />
      </span>
      <span className="board-figure board-closes">
        <span className="board-value">{closes ?? '—'}</span>
        <small>{item.application_deadline ? shortDate(item.application_deadline) : 'no closing date'}</small>
      </span>
      <span className="board-status"><Badge>{str(item.status).toLowerCase()}</Badge></span>
    </Link>
  </li>;
}

/**
 * A long list of campaigns as a board: one row each, with pay, spots, closing time and status always in the same
 * column, so a creator can scan a column instead of reading every card. The goal tabs, which usually hold one or two
 * campaigns, use `CampaignCards` instead. Nothing here is computed from data the database does not hold, and the full
 * project images stay on the campaign's own page.
 */
export function CampaignBoard({ items, label }: { items: unknown; label: string }) {
  const list = rows(items);
  if (!list.length) return null;
  return <div className="board">
    <div className="board-head" aria-hidden>
      <span>Campaign</span><span>Pay</span><span>Spots</span><span>Closes</span><span>Status</span>
    </div>
    <ul className="board-rows" aria-label={label}>
      {list.map((item) => <BoardRow key={str(item.id)} item={item} />)}
    </ul>
  </div>;
}
