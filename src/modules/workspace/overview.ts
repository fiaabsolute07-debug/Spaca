/**
 * The workspace overview (2026-09-17): what needs the account's action now, a few numbers, and its latest orders.
 * "Needs your action" is worked out from the same states the order, campaign and item-auction pages act on, so every
 * entry links to the page where the action is.
 */
import type { Actor } from '@/lib/auth';
import { isCreator } from '@/lib/account';
import { sql } from '@/lib/db';

export type ActionItem = {
  key: string;
  kind: 'order' | 'offer' | 'campaign' | 'auction';
  title: string;
  action: string;
  href: string;
  dueAt: string | null;
  /** Waiting on the other side rather than on this account; shown after the real to-dos. */
  waiting?: boolean;
};

export type RecentOrder = { id: string; title: string; status: string; amountMinor: number; counterpart: string; createdAt: string; dueAt: string | null };

const iso = (value: unknown) => (value ? new Date(String(value)).toISOString() : null);
type Row = Record<string, unknown>;

/** The order states that can ask something of the buyer or the creator (see orderAction). */
const ACTION_STATUSES = ['AWAITING_PAYMENT', 'FUNDED', 'IN_PROGRESS', 'REVISION_REQUESTED', 'DELIVERED', 'DISPUTED'];

/** What each order state asks of the buyer, or of the creator. */
function orderAction(row: Row, creator: boolean): Omit<ActionItem, 'key' | 'kind' | 'title' | 'href'> | null {
  const status = String(row.status);
  const briefReady = Boolean(row.brief_ready_at);
  if (creator) {
    if (status === 'FUNDED' && briefReady) return { action: 'Start work', dueAt: iso(row.delivery_due_at) };
    if (status === 'IN_PROGRESS') return { action: 'Deliver the work', dueAt: iso(row.delivery_due_at) };
    if (status === 'REVISION_REQUESTED') return { action: 'Deliver the revision', dueAt: iso(row.revision_due_at ?? row.delivery_due_at) };
    if (status === 'DISPUTED') return { action: 'Dispute under review', dueAt: null, waiting: true };
    return null;
  }
  if (status === 'AWAITING_PAYMENT') return { action: briefReady ? 'Pay for the order' : 'Pay and complete the brief', dueAt: null };
  if (status === 'FUNDED' && !briefReady) return { action: 'Complete the brief', dueAt: null };
  if (status === 'DELIVERED') return { action: 'Review the delivery', dueAt: iso(row.review_due_at) };
  if (status === 'DISPUTED') return { action: 'Dispute under review', dueAt: null, waiting: true };
  return null;
}

export async function getOverview(actor: Actor) {
  const creator = isCreator(actor);
  const [orders, latest, offers, applications, sales, listings, stats] = await Promise.all([
    // Every order in a state that can ask something of either side, however old; the latest few separately.
    sql<Row[]>`select id,title,status,brief_ready_at,delivery_due_at,review_due_at,revision_due_at,buyer_id,creator_id from app.orders
      where (buyer_id=${actor.id} or creator_id=${actor.id}) and status = any(${ACTION_STATUSES}) order by created_at desc limit 500`,
    sql<Row[]>`select o.id,o.title,o.status,o.amount_minor,o.delivery_due_at,o.review_due_at,o.created_at,
        bu.display_name as buyer_name,cu.display_name as creator_name
      from app.orders o join app.users bu on bu.id=o.buyer_id join app.users cu on cu.id=o.creator_id
      where o.buyer_id=${actor.id} or o.creator_id=${actor.id} order by o.created_at desc limit 6`,
    creator ? sql<Row[]>`select h.id,h.expires_at,h.amount_minor,r.id as request_id,r.title from app.hire_offers h join app.requests r on r.id=h.request_id
      where h.creator_id=${actor.id} and h.status='OFFERED' and h.expires_at > now() order by h.expires_at` : Promise.resolve([] as Row[]),
    creator ? Promise.resolve([] as Row[]) : sql<Row[]>`select r.id,r.title,r.application_deadline,count(a.id)::int as waiting from app.requests r
      join app.applications a on a.request_id=r.id and a.status='SUBMITTED' where r.buyer_id=${actor.id} and r.status='OPEN' group by r.id order by r.application_deadline`,
    sql<Row[]>`select s.id,s.status,s.payment_due_at,s.confirm_by,s.buyer_id,s.seller_id,l.id as listing_id,l.title,l.delivery_due_at
      from app.item_sales s join app.item_listings l on l.id=s.listing_id
      where (s.buyer_id=${actor.id} and s.status in ('AWAITING_PAYMENT','DELIVERED')) or (s.seller_id=${actor.id} and s.status='AWAITING_DELIVERY')`,
    sql<Row[]>`select id,title,ends_at from app.item_listings where seller_id=${actor.id} and status='AWAITING_COLLATERAL' and ends_at > now()`,
    sql<Row[]>`select count(*)::int as total,
        count(*) filter (where status not in ('COMPLETED','CANCELLED','REFUNDED'))::int as active,
        count(*) filter (where status='COMPLETED')::int as completed,
        coalesce(sum(amount_minor) filter (where creator_id=${actor.id} and status='COMPLETED'),0)::bigint as earned_minor,
        coalesce(sum(amount_minor) filter (where buyer_id=${actor.id} and funded_at is not null and status not in ('CANCELLED','REFUNDED')),0)::bigint as funded_minor
      from app.orders where buyer_id=${actor.id} or creator_id=${actor.id}`,
  ]);

  const actions: ActionItem[] = [];
  for (const row of orders) {
    const mine = creator ? String(row.creator_id) === actor.id : String(row.buyer_id) === actor.id;
    const next = mine ? orderAction(row, creator) : null;
    if (next) actions.push({ key: `order-${String(row.id)}`, kind: 'order', title: String(row.title ?? 'Order'), href: `/orders/${String(row.id)}`, ...next });
  }
  for (const row of offers) actions.push({ key: `offer-${String(row.id)}`, kind: 'offer', title: String(row.title), action: 'Answer the hire offer', href: `/requests/${String(row.request_id)}`, dueAt: iso(row.expires_at) });
  for (const row of applications) {
    const count = Number(row.waiting);
    actions.push({ key: `campaign-${String(row.id)}`, kind: 'campaign', title: String(row.title), action: `Review ${count} ${count === 1 ? 'application' : 'applications'}`, href: `/requests/${String(row.id)}`, dueAt: iso(row.application_deadline) });
  }
  for (const row of sales) {
    const buyer = String(row.buyer_id) === actor.id;
    const action = buyer ? (row.status === 'AWAITING_PAYMENT' ? 'Pay into escrow' : 'Confirm you received it') : 'Deliver the item';
    const dueAt = buyer ? iso(row.status === 'AWAITING_PAYMENT' ? row.payment_due_at : row.confirm_by) : iso(row.delivery_due_at);
    actions.push({ key: `sale-${String(row.id)}`, kind: 'auction', title: String(row.title), action, href: `/auctions/${String(row.listing_id)}`, dueAt });
  }
  for (const row of listings) actions.push({ key: `listing-${String(row.id)}`, kind: 'auction', title: String(row.title), action: 'Lock collateral to open bidding', href: `/auctions/${String(row.id)}`, dueAt: iso(row.ends_at) });

  // Real to-dos first, soonest deadline first; things waiting on someone else last.
  actions.sort((a, b) => Number(Boolean(a.waiting)) - Number(Boolean(b.waiting))
    || (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));

  const [numbers] = stats;
  const recent: RecentOrder[] = latest.map((row) => ({
    id: String(row.id), title: String(row.title ?? 'Order'), status: String(row.status), amountMinor: Number(row.amount_minor),
    counterpart: String(creator ? row.buyer_name : row.creator_name), createdAt: String(iso(row.created_at)),
    dueAt: iso(row.status === 'DELIVERED' ? row.review_due_at : row.delivery_due_at),
  }));
  return {
    creator,
    actions,
    todo: actions.filter((item) => !item.waiting).length,
    stats: {
      active: Number(numbers?.active ?? 0),
      completed: Number(numbers?.completed ?? 0),
      moneyMinor: Number(creator ? numbers?.earned_minor ?? 0 : numbers?.funded_minor ?? 0),
    },
    recent,
    totalOrders: Number(numbers?.total ?? 0),
  };
}
