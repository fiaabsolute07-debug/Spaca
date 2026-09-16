import Link from 'next/link';
import { GoalArt } from './goal-art';
import { Badge, money, num, rows, str } from '../ui';
import { goalByValue } from '@/modules/requests/goals';

const DAY = 24 * 60 * 60 * 1000;
/** The column is narrow, so the date under it is the day alone; the full time is on the campaign's page. */
const shortDate = (value: unknown) => new Date(String(value)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** How long is left to apply, in the words a creator scanning the board would use. */
function closesIn(deadline: unknown): string | null {
  if (!deadline) return null;
  const left = new Date(String(deadline)).getTime() - Date.now();
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return 'Closed';
  const days = Math.floor(left / DAY);
  if (days >= 2) return `${days} days left`;
  const hours = Math.max(1, Math.floor(left / (60 * 60 * 1000)));
  return hours >= 24 ? '1 day left' : `${hours}h left`;
}

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
            {item.buyer_name ? `by ${str(item.buyer_name)}` : null}
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
 * Campaigns as a board rather than a wall of cards: one row each, with pay, spots, closing time and status always in
 * the same column, so a creator can scan a column instead of reading every card. Nothing here is computed from data
 * the database does not hold, and the full project images stay on the campaign's own page.
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
