import { CommandError, instant, money, orderEvent, text, type CommandHandler, type Row } from '@/lib/commands';
import type { Tx } from '@/lib/commands';
import { insertReservation, lockAvailableBucket, releaseAuctionReservation } from '@/modules/capacity';
import { ownedService } from '@/modules/catalog/commands';
import { assertFlags } from '@/modules/admin/policy';

/** Order terms for an auction sale come from the version the auction was created with (CAP-09 keeps the same claim). */
async function auctionTerms(tx: Tx, auction: Row, priceMinor: string, kind: 'BUY_NOW' | 'WINNER') {
  const [version] = await tx<Row[]>`select * from app.service_versions where id=${String(auction.service_version_id)}`;
  if (!version) throw new CommandError('Auction terms are missing; contact support', 'ORDER_STATE_CONFLICT');
  const [reservation] = await tx<Row[]>`select r.bucket_id,b.starts_at,b.ends_at,b.pool_id from app.reservations r join app.capacity_buckets b on b.id=r.bucket_id where r.id=${String(auction.reservation_id)}`;
  return {
    version,
    terms: {
      schema_version: 1,
      source: 'AUCTION',
      auction_id: String(auction.id),
      sale_kind: kind,
      service_version_id: String(version.id),
      service_version: Number(version.version),
      title: version.title,
      scope: version.description,
      taxonomy: version.taxonomy,
      price_minor: priceMinor,
      currency: version.currency,
      platform_fee_bps: 0,
      turnaround_hours: Number(version.turnaround_hours),
      revision_limit: Number(version.revision_limit),
      review_window_hours: Number(version.review_window_hours),
      auto_accept_consent: false,
      cancellation_policy_version: 'v1',
      capacity: reservation ? { pool_id: String(reservation.pool_id), bucket_id: String(reservation.bucket_id), week_starts_at: new Date(reservation.starts_at).toISOString(), week_ends_at: new Date(reservation.ends_at).toISOString() } : null,
    },
  };
}

const createAuction: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot create auctions', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['AUCTIONS_ENABLED']);
  const service = await ownedService(tx, actor, text(form, 'service_id'));
  if (String(service.status) !== 'PUBLISHED') throw new CommandError('Only a published service can be auctioned');
  const starting = money(text(form, 'starting_price'), 'starting_price');
  const increment = money(text(form, 'minimum_increment'), 'minimum_increment');
  const buyValue = text(form, 'buy_now_price', false);
  const buy = buyValue ? money(buyValue, 'buy_now_price') : null;
  if (buy !== null && buy < starting) throw new CommandError('Buy now must be at least the starting price');
  const starts = instant(text(form, 'starts_at'), 'starts_at');
  const ends = instant(text(form, 'ends_at'), 'ends_at');
  if (ends <= starts || ends <= new Date()) throw new CommandError('Auction end must be after its start and in the future');
  if (!service.published_version_id) throw new CommandError('Only a published service can be auctioned');
  const [version] = await tx<Row[]>`select * from app.service_versions where id=${String(service.published_version_id)}`;
  const bucket = await lockAvailableBucket(tx, String(version!.pool_id), Number(version!.turnaround_hours));
  const [auction] = await tx<Row[]>`insert into app.auctions (service_id,service_version_id,seller_id,title,starting_price_minor,minimum_increment_minor,buy_now_price_minor,starts_at,ends_at,status)
    values (${String(service.id)},${String(version!.id)},${actor.id},${version!.title},${starting.toString()},${increment.toString()},${buy?.toString() ?? null},${starts.toISOString()},${ends.toISOString()},'SCHEDULED') returning id`;
  await insertReservation(tx, bucket, { auctionId: String(auction!.id) }, ends);
  return { path: `/auctions/${auction!.id}`, message: 'Auction scheduled and one capacity unit reserved', id: String(auction!.id) };
};

const bid: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot bid', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['AUCTIONS_ENABLED', 'BIDDING_ENABLED']);
  const auctionId = text(form, 'auction_id');
  const amount = money(text(form, 'amount'), 'amount');
  const [auction] = await tx<Row[]>`select * from app.auctions where id=${auctionId} for update`;
  if (!auction) throw new CommandError('Auction not found');
  if (String(auction.seller_id) === actor.id) throw new CommandError('You cannot bid on your own auction');
  const now = new Date();
  if (new Date(String(auction.ends_at)) <= now) throw new CommandError('Auction has ended');
  if (new Date(String(auction.starts_at)) > now) throw new CommandError('Auction has not started');
  const current = auction.current_price_minor ? BigInt(auction.current_price_minor) : BigInt(auction.starting_price_minor);
  if (amount < current + BigInt(auction.minimum_increment_minor)) throw new CommandError('Bid must meet the minimum increment');
  await tx`insert into app.bids (auction_id,bidder_id,amount_minor) values (${auctionId},${actor.id},${amount.toString()})`;
  await tx`update app.auctions set status='LIVE',current_price_minor=${amount.toString()},bid_count=bid_count+1,updated_at=now() where id=${auctionId}`;
  return { path: `/auctions/${auctionId}`, message: 'Bid accepted by the server' };
};

const buyNow: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot buy', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['AUCTIONS_ENABLED', 'CHECKOUT_CREATION_ENABLED']);
  const auctionId = text(form, 'auction_id');
  const [auction] = await tx<Row[]>`select a.*,r.pool_id,r.id as reservation_id from app.auctions a join app.reservations r on r.auction_id=a.id where a.id=${auctionId} for update`;
  if (!auction || !auction.buy_now_price_minor) throw new CommandError('Buy now is unavailable');
  if (String(auction.seller_id) === actor.id || Number(auction.bid_count) > 0) throw new CommandError('Buy now is only available before the first bid');
  if (new Date(String(auction.ends_at)) <= new Date()) throw new CommandError('Auction has ended');
  const buyNowTerms = await auctionTerms(tx, auction, String(auction.buy_now_price_minor), 'BUY_NOW');
  const [order] = await tx<Row[]>`insert into app.orders (buyer_id,creator_id,service_id,service_version_id,pool_id,source,source_ref,title,status,amount_minor,platform_fee_minor,currency,brief,terms,delivery_due_at)
    values (${actor.id},${auction.seller_id},${auction.service_id},${String(buyNowTerms.version.id)},${auction.pool_id},'AUCTION',${auction.id},${auction.title},'AWAITING_PAYMENT',${auction.buy_now_price_minor},0,${buyNowTerms.version.currency},
      'Auction purchase — confirm the final brief in the order workspace.',${JSON.stringify(buyNowTerms.terms)}::jsonb,null) returning id`;
  await tx`update app.reservations set order_id=${order!.id},state='HELD',auction_id=null where id=${auction.reservation_id}`;
  await tx`update app.auctions set status='AWAITING_WINNER_PAYMENT',winner_id=${actor.id},updated_at=now() where id=${auctionId}`;
  await orderEvent(tx, String(order!.id), actor.id, 'ORDER_CREATED', { source: 'AUCTION', platform_fee_minor: '0' });
  return { path: `/orders/${order!.id}`, message: 'Buy now reserved the auction slot. Fund the order to confirm.', id: String(order!.id) };
};

const closeAuction: CommandHandler = async ({ tx, actor, form }) => {
  const auctionId = text(form, 'auction_id');
  const [auction] = await tx<Row[]>`select a.*,r.pool_id,r.id as reservation_id from app.auctions a left join app.reservations r on r.auction_id=a.id
    where a.id=${auctionId} and a.seller_id=${actor.id} for update of a`;
  if (!auction) throw new CommandError('Auction not found or not owned by this account', 'FORBIDDEN');
  if (!['SCHEDULED', 'LIVE'].includes(String(auction.status))) throw new CommandError('This auction has already been closed or is awaiting winner payment');
  if (new Date(String(auction.ends_at)) > new Date()) throw new CommandError('Auction can only close after its server deadline');
  const [topBid] = await tx<Row[]>`select * from app.bids where auction_id=${auctionId} order by amount_minor desc,created_at asc limit 1`;
  if (!topBid) {
    await tx`update app.auctions set status='EXPIRED',updated_at=now() where id=${auctionId}`;
    await releaseAuctionReservation(tx, auctionId);
    return { path: `/auctions/${auctionId}`, message: 'Auction closed with no valid bids; capacity released' };
  }
  const winnerTerms = await auctionTerms(tx, auction, String(topBid.amount_minor), 'WINNER');
  const [order] = await tx<Row[]>`insert into app.orders (buyer_id,creator_id,service_id,service_version_id,pool_id,source,source_ref,title,status,amount_minor,platform_fee_minor,currency,brief,terms,delivery_due_at)
    values (${topBid.bidder_id},${auction.seller_id},${auction.service_id},${String(winnerTerms.version.id)},${auction.pool_id},'AUCTION',${auction.id},${auction.title},'AWAITING_PAYMENT',${topBid.amount_minor},0,${winnerTerms.version.currency},
      'Winning bid — confirm the final brief in the order workspace.',${JSON.stringify(winnerTerms.terms)}::jsonb,null) returning id`;
  await tx`update app.reservations set order_id=${order!.id},state='HELD',auction_id=null,expires_at=now()+interval '24 hours' where id=${auction.reservation_id}`;
  await tx`update app.auctions set status='AWAITING_WINNER_PAYMENT',winner_id=${topBid.bidder_id},updated_at=now() where id=${auctionId}`;
  await orderEvent(tx, String(order!.id), actor.id, 'AUCTION_CLOSED', { winner_id: String(topBid.bidder_id), amount_minor: String(topBid.amount_minor) });
  return { path: `/auctions/${auctionId}`, message: 'Auction closed. The winner must fund the order.', id: String(order!.id) };
};

export const auctionCommands: Record<string, CommandHandler> = {
  create_auction: createAuction,
  bid,
  buy_now: buyNow,
  close_auction: closeAuction,
};
