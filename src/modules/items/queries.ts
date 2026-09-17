/**
 * Reads for web3 item auctions (drizzle/0033). Listings that are not open yet (collateral missing) or were cancelled
 * are visible to their seller only. Bidders are shown as "Bidder 1, 2…" in order of their first bid, and as "You" to
 * themselves. What the buyer gave for delivery and the seller's proof are visible to the two of them only.
 */
import type { Actor } from '@/lib/auth';
import { UUID_PATTERN, type Row } from '@/lib/commands';
import { sql } from '@/lib/db';
import type { XProfileView } from '@/lib/x-profile';
import { getXProfileViews } from '@/modules/x/service';

export type ListingCard = {
  id: string; title: string; itemType: string; origin: 'PROJECT' | 'RESALE'; projectName: string; network: string; quantity: string;
  startingPrice: number; currentBid: number | null; buyNowPrice: number | null; collateral: number; bidCount: number;
  startsAt: string; endsAt: string; upcoming: boolean; sellerName: string;
  /** The first picture's card copy (or the original when there is none), as an /api/item-images id. */
  coverId: string | null;
};

const iso = (value: unknown) => new Date(String(value)).toISOString();

/** The cover picture for a listing row `l`: its first picture's card copy, or the original; never a quarantined one. */
const COVER = sql`(select coalesce(t.id,o.id) from app.item_listing_images i join app.storage_assets o on o.id=i.asset_id and o.lifecycle_state='READY'
  left join app.storage_assets t on t.id=i.thumb_asset_id and t.lifecycle_state='READY' where i.listing_id=l.id order by i.position limit 1)`;
const num = (value: unknown) => Number(value ?? 0);

function card(row: Row): ListingCard {
  return {
    id: String(row.id), title: String(row.title), itemType: String(row.item_type), origin: row.origin as ListingCard['origin'],
    projectName: String(row.project_name), network: String(row.network), quantity: String(row.quantity),
    startingPrice: num(row.starting_price_minor), currentBid: row.current_bid_minor == null ? null : num(row.current_bid_minor),
    buyNowPrice: row.buy_now_price_minor == null ? null : num(row.buy_now_price_minor), collateral: num(row.collateral_minor),
    bidCount: num(row.bid_count), startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), upcoming: Boolean(row.upcoming), sellerName: String(row.seller_name),
    coverId: row.cover_id ? String(row.cover_id) : null,
  };
}

/** Open listings (live first, then upcoming), filter chips and recent sale prices. */
export async function getItemAuctionBoard(filters: { type?: string; origin?: string }) {
  const type = (filters.type ?? '').trim().slice(0, 40);
  const origin = filters.origin === 'PROJECT' || filters.origin === 'RESALE' ? filters.origin : '';
  const [listings, types, recent] = await Promise.all([
    sql<Row[]>`select l.*,u.display_name as seller_name,b.amount_minor as current_bid_minor,(now() < l.starts_at) as upcoming,${COVER} as cover_id
      from app.item_listings l join app.users u on u.id=l.seller_id left join app.item_bids b on b.id=l.current_bid_id
      where l.status='OPEN' and l.ends_at > now() and u.status='ACTIVE'
        and (${type} = '' or lower(l.item_type) = lower(${type})) and (${origin} = '' or l.origin = ${origin})
      order by (now() < l.starts_at), l.ends_at limit 60`,
    sql<Row[]>`select min(l.item_type) as item_type,count(*)::int as n from app.item_listings l
      where l.status='OPEN' and l.ends_at > now() group by lower(l.item_type) order by n desc, min(l.item_type) limit 12`,
    sql<Row[]>`select l.id,l.title,l.item_type,l.project_name,s.price_minor,s.kind,s.created_at from app.item_sales s join app.item_listings l on l.id=s.listing_id
      where s.status not in ('PAYMENT_EXPIRED') order by s.created_at desc limit 8`,
  ]);
  const cards = listings.map(card);
  return {
    live: cards.filter((listing) => !listing.upcoming),
    upcoming: cards.filter((listing) => listing.upcoming),
    types: types.map((row) => ({ type: String(row.item_type), count: num(row.n) })),
    recent: recent.map((row) => ({ id: String(row.id), title: String(row.title), itemType: String(row.item_type), projectName: String(row.project_name), price: num(row.price_minor), kind: String(row.kind), soldAt: iso(row.created_at) })),
    filters: { type, origin },
  };
}

/** The signed-in account's listings and the auctions it bid on or bought. */
export async function getMyItemActivity(actor: Actor) {
  const [listings, bids] = await Promise.all([
    sql<Row[]>`select l.id,l.title,l.status,l.ends_at,l.bid_count,b.amount_minor as current_bid_minor,s.status as sale_status,s.price_minor as sale_price_minor
      from app.item_listings l left join app.item_bids b on b.id=l.current_bid_id left join app.item_sales s on s.listing_id=l.id
      where l.seller_id=${actor.id} order by l.created_at desc limit 20`,
    sql<Row[]>`select l.id,l.title,l.status,l.ends_at,max(mine.amount_minor) as my_best_minor,cb.amount_minor as current_bid_minor,cb.bidder_id=${actor.id} as leading,
        s.status as sale_status,s.buyer_id=${actor.id} as won,s.price_minor as sale_price_minor
      from app.item_listings l
      left join app.item_bids mine on mine.listing_id=l.id and mine.bidder_id=${actor.id}
      left join app.item_bids cb on cb.id=l.current_bid_id
      left join app.item_sales s on s.listing_id=l.id
      where mine.id is not null or s.buyer_id=${actor.id}
      group by l.id,cb.amount_minor,cb.bidder_id,s.status,s.buyer_id,s.price_minor order by l.ends_at desc limit 20`,
  ]);
  return {
    listings: listings.map((row) => ({ id: String(row.id), title: String(row.title), status: String(row.status), endsAt: iso(row.ends_at), bidCount: num(row.bid_count), currentBid: row.current_bid_minor == null ? null : num(row.current_bid_minor), salePrice: row.sale_price_minor == null ? null : num(row.sale_price_minor), saleStatus: row.sale_status ? String(row.sale_status) : null })),
    bids: bids.map((row) => ({ id: String(row.id), title: String(row.title), status: String(row.status), endsAt: iso(row.ends_at), myBest: row.my_best_minor == null ? null : num(row.my_best_minor), currentBid: row.current_bid_minor == null ? null : num(row.current_bid_minor), leading: Boolean(row.leading), salePrice: row.sale_price_minor == null ? null : num(row.sale_price_minor), saleStatus: row.sale_status ? String(row.sale_status) : null, won: Boolean(row.won) })),
  };
}

export type ItemListingDetail = NonNullable<Awaited<ReturnType<typeof getItemListing>>>;

export async function getItemListing(id: string, actor: Actor | null) {
  if (!UUID_PATTERN.test(id)) return null;
  const [row] = await sql<Row[]>`select l.*,${COVER} as cover_id,u.display_name as seller_name,u.roles as seller_roles,p.handle as seller_handle,p.avatar_asset_id as seller_avatar,
      b.amount_minor as current_bid_minor,b.bidder_id as current_bidder_id,now() as db_now
    from app.item_listings l join app.users u on u.id=l.seller_id left join app.profiles p on p.user_id=l.seller_id
    left join app.item_bids b on b.id=l.current_bid_id where l.id=${id}`;
  if (!row) return null;
  const seller = actor?.id === String(row.seller_id);
  if (!seller && (row.status === 'AWAITING_COLLATERAL' || row.status === 'CANCELLED')) return null;
  const operator = Boolean(actor?.roles.some((role) => ['finance', 'admin', 'support'].includes(role)));
  const [bidRows, [saleRow], xProfiles, imageRows] = await Promise.all([
    sql<Row[]>`select amount_minor,sequence,created_at,bidder_id from app.item_bids where listing_id=${id} order by sequence desc limit 100`,
    sql<Row[]>`select * from app.item_sales where listing_id=${id}`,
    getXProfileViews([String(row.seller_id)]),
    sql<Row[]>`select i.asset_id,i.thumb_asset_id from app.item_listing_images i join app.storage_assets a on a.id=i.asset_id and a.lifecycle_state='READY'
      where i.listing_id=${id} order by i.position`,
  ]);
  const order: string[] = [];
  for (const bid of [...bidRows].reverse()) if (!order.includes(String(bid.bidder_id))) order.push(String(bid.bidder_id));
  const now = new Date(String(row.db_now));
  const role = !actor ? 'visitor' : seller ? 'seller' : saleRow && String(saleRow.buyer_id) === actor.id ? 'buyer' : operator ? 'operator' : 'visitor';
  const party = role === 'seller' || role === 'buyer' || role === 'operator';
  const current = row.current_bid_minor == null ? null : num(row.current_bid_minor);
  const live = row.status === 'OPEN' && now >= new Date(String(row.starts_at)) && now < new Date(String(row.ends_at));
  return {
    role: role as 'visitor' | 'seller' | 'buyer' | 'operator',
    images: imageRows.map((image) => ({ id: String(image.asset_id), thumbId: image.thumb_asset_id ? String(image.thumb_asset_id) : null })),
    listing: {
      ...card({ ...row, upcoming: now < new Date(String(row.starts_at)) }),
      status: String(row.status),
      projectUrl: row.project_url ? String(row.project_url) : null,
      description: String(row.description),
      deliveryMethod: String(row.delivery_method),
      buyerProvides: String(row.buyer_provides),
      deliveryDueAt: iso(row.delivery_due_at),
      minIncrement: num(row.min_increment_minor),
      nextMinimum: current == null ? num(row.starting_price_minor) : current + num(row.min_increment_minor),
      collateralPostedAt: row.collateral_posted_at ? iso(row.collateral_posted_at) : null,
      collateralReleasedAt: row.collateral_released_at ? iso(row.collateral_released_at) : null,
      cancelReason: row.cancel_reason ? String(row.cancel_reason) : null,
      live,
      ended: now >= new Date(String(row.ends_at)) || ['SOLD', 'NO_BIDS', 'CANCELLED'].includes(String(row.status)),
      leading: Boolean(actor && row.current_bidder_id && String(row.current_bidder_id) === actor.id),
      buyNowAvailable: live && row.buy_now_price_minor != null && num(row.bid_count) === 0,
      serverNow: now.toISOString(),
    },
    seller: {
      name: String(row.seller_name),
      accountType: (row.seller_roles as string[]).includes('creator') ? 'Creator' : 'Buyer',
      handle: row.seller_handle ? String(row.seller_handle) : null,
      avatarAssetId: row.seller_avatar ? String(row.seller_avatar) : null,
      x: xProfiles.get(String(row.seller_id)) ?? null as XProfileView | null,
    },
    bids: bidRows.map((bid) => ({
      amount: num(bid.amount_minor), sequence: num(bid.sequence), at: iso(bid.created_at),
      bidder: actor && String(bid.bidder_id) === actor.id ? 'You' : `Bidder ${order.indexOf(String(bid.bidder_id)) + 1}`,
    })),
    sale: saleRow ? {
      id: String(saleRow.id), kind: String(saleRow.kind), status: String(saleRow.status), price: num(saleRow.price_minor), collateral: num(saleRow.collateral_minor),
      paymentDueAt: iso(saleRow.payment_due_at), paidAt: saleRow.paid_at ? iso(saleRow.paid_at) : null,
      deliveredAt: saleRow.delivered_at ? iso(saleRow.delivered_at) : null, confirmBy: saleRow.confirm_by ? iso(saleRow.confirm_by) : null,
      completedAt: saleRow.completed_at ? iso(saleRow.completed_at) : null, disputedAt: saleRow.disputed_at ? iso(saleRow.disputed_at) : null,
      resolution: saleRow.resolution ? String(saleRow.resolution) : null,
      buyerDetails: party && saleRow.buyer_details ? String(saleRow.buyer_details) : null,
      deliveryProof: party && saleRow.delivery_proof ? String(saleRow.delivery_proof) : null,
      disputeReason: party && saleRow.dispute_reason ? String(saleRow.dispute_reason) : null,
      paymentOverdue: saleRow.status === 'AWAITING_PAYMENT' && now > new Date(String(saleRow.payment_due_at)),
      deliveryOverdue: saleRow.status === 'AWAITING_DELIVERY' && now > new Date(String(row.delivery_due_at)),
    } : null,
  };
}

/** Disputed item sales for the operator console. */
export async function getItemDisputes() {
  const rows = await sql<Row[]>`select s.*,l.title,l.item_type,l.delivery_due_at,l.buyer_provides,bu.display_name as buyer_name,se.display_name as seller_name
    from app.item_sales s join app.item_listings l on l.id=s.listing_id join app.users bu on bu.id=s.buyer_id join app.users se on se.id=s.seller_id
    where s.status='DISPUTED' order by s.disputed_at`;
  return rows.map((row) => ({
    id: String(row.id), listingId: String(row.listing_id), title: String(row.title), itemType: String(row.item_type),
    buyerName: String(row.buyer_name), sellerName: String(row.seller_name), price: num(row.price_minor), collateral: num(row.collateral_minor),
    buyerProvides: String(row.buyer_provides), buyerDetails: row.buyer_details ? String(row.buyer_details) : null,
    deliveryProof: row.delivery_proof ? String(row.delivery_proof) : null, disputeReason: String(row.dispute_reason ?? ''),
    disputedAt: iso(row.disputed_at), deliveryDueAt: iso(row.delivery_due_at),
  }));
}
