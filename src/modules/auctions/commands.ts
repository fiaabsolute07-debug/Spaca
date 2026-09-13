/**
 * Auction engine v2 (master §10, P3). Every decision uses database time under the auction row lock, so a late
 * close job or a stale UI cannot accept a bid after the deadline. One purchase intent is the only sale path:
 * WINNER after close (24 h to pay) or BUY_NOW before the first valid bid (checkout TTL). Funding settles and an
 * unpaid cancellation defaults the auction through the order trigger in drizzle/0008; nothing relists silently.
 */
import { CommandError, instant, money, orderEvent, text, uuid, type CommandHandler, type Row, type Tx } from '@/lib/commands';
import { insertReservation, lockAvailableBucket, releaseAuctionReservation } from '@/modules/capacity';
import { CHECKOUT_HOLD_MINUTES, ownedService } from '@/modules/catalog/commands';
import { assertFlags } from '@/modules/admin/policy';
import { enqueueNotification } from '@/modules/notifications/enqueue';

export const WINNER_PAYMENT_HOURS = 24;
export const MAX_AUCTION_DAYS = 7;
const BACKDATE_TOLERANCE_MS = 5 * 60_000;
const OPEN_STATES = ['SCHEDULED', 'LIVE'];

const dbNow = async (tx: Tx): Promise<Date> => new Date(String((await tx<Row[]>`select now() as now`)[0]!.now));
const usd = (minor: bigint) => `$${(Number(minor) / 100).toFixed(2)}`;

async function lockAuction(tx: Tx, auctionId: string): Promise<Row> {
  const [auction] = await tx<Row[]>`select * from app.auctions where id=${auctionId} for update`;
  if (!auction) throw new CommandError('Auction not found', 'NOT_FOUND');
  return auction;
}

/** Highest valid bid: amount desc, then earliest sequence (AUC-02 determinism). */
export async function highestValidBid(tx: Tx, auctionId: string): Promise<Row | undefined> {
  const [top] = await tx<Row[]>`select * from app.bids where auction_id=${auctionId} and status='ACCEPTED' order by amount_minor desc, sequence asc limit 1`;
  return top;
}

/** Used after a moderator invalidates a bid: pointer and cached price follow the remaining valid bids. */
export async function recomputeHighestBid(tx: Tx, auctionId: string): Promise<Row | undefined> {
  const top = await highestValidBid(tx, auctionId);
  await tx`update app.auctions set current_bid_id=${top ? String(top.id) : null},current_price_minor=${top ? String(top.amount_minor) : null},
    bid_count=(select count(*) from app.bids where auction_id=${auctionId} and status='ACCEPTED'),version=version+1,updated_at=now() where id=${auctionId}`;
  return top;
}

export function nextMinimum(auction: Row, top: Row | undefined): bigint {
  return top ? BigInt(top.amount_minor) + BigInt(auction.minimum_increment_minor) : BigInt(auction.starting_price_minor);
}

async function assertBiddingWindow(tx: Tx, auction: Row): Promise<Date> {
  const now = await dbNow(tx);
  if (!OPEN_STATES.includes(String(auction.status))) throw new CommandError('This auction is no longer accepting bids', 'AUCTION_ENDED');
  if (now < new Date(auction.starts_at)) throw new CommandError('This auction has not started yet', 'AUCTION_NOT_LIVE');
  if (now >= new Date(auction.ends_at)) throw new CommandError('This auction has ended', 'AUCTION_ENDED');
  if (auction.status === 'SCHEDULED') await tx`update app.auctions set status='LIVE',version=version+1,updated_at=now() where id=${String(auction.id)}`;
  return now;
}

/** Creates the canonical pending order, moves the capacity claim onto it and records the single purchase intent. */
async function createSale(tx: Tx, auction: Row, sale: { buyerId: string; amountMinor: string; kind: 'WINNER' | 'BUY_NOW'; bidId: string | null; expiresAt: Date }) {
  const snapshot = auction.terms_snapshot as Record<string, unknown>;
  const terms = { ...snapshot, schema_version: 1, source: 'AUCTION', auction_id: String(auction.id), sale_kind: sale.kind, price_minor: sale.amountMinor, platform_fee_bps: 0, auto_accept_consent: false };
  const [reservation] = await tx<Row[]>`select * from app.reservations where auction_id=${String(auction.id)} for update`;
  if (!reservation || !['HELD', 'RECONCILING'].includes(String(reservation.state))) {
    throw new CommandError('The auction slot is no longer held; the sale cannot proceed', 'CAPACITY_UNAVAILABLE');
  }
  const brief = sale.kind === 'WINNER' ? 'Winning bid: confirm the final brief in the order workspace.' : 'Buy Now purchase: confirm the final brief in the order workspace.';
  const [order] = await tx<Row[]>`insert into app.orders (buyer_id,creator_id,service_id,service_version_id,pool_id,source,source_ref,title,status,amount_minor,platform_fee_minor,currency,brief,terms,delivery_due_at)
    values (${sale.buyerId},${String(auction.seller_id)},${String(auction.service_id)},${auction.service_version_id},${String(reservation.pool_id)},'AUCTION',${String(auction.id)},${String(auction.title)},
      'AWAITING_PAYMENT',${sale.amountMinor},0,${String(snapshot.currency ?? 'USD')},${brief},${JSON.stringify(terms)}::jsonb,null) returning id`;
  const orderId = String(order!.id);
  await tx`update app.reservations set order_id=${orderId},auction_id=null,state='HELD',expires_at=${sale.expiresAt.toISOString()} where id=${String(reservation.id)}`;
  await tx`insert into app.auction_purchase_intents (auction_id,buyer_id,kind,bid_id,amount_minor,order_id,expires_at)
    values (${String(auction.id)},${sale.buyerId},${sale.kind},${sale.bidId},${sale.amountMinor},${orderId},${sale.expiresAt.toISOString()})`;
  await tx`update app.auctions set status='AWAITING_WINNER_PAYMENT',winner_id=${sale.buyerId},winning_bid_id=${sale.bidId},payment_due_at=${sale.expiresAt.toISOString()},
    closed_at=now(),version=version+1,updated_at=now() where id=${String(auction.id)}`;
  await orderEvent(tx, orderId, null, 'ORDER_CREATED', { source: 'AUCTION', sale_kind: sale.kind, auction_id: String(auction.id), platform_fee_minor: '0' });
  return orderId;
}

export type CloseOutcome = { outcome: 'NOT_DUE' | 'NO_BIDS' | 'WINNER_SELECTED' | 'ALREADY_CLOSED'; orderId?: string };

/** AUC-05/06: idempotent close under the row lock; duplicates return the recorded winner and order. */
export async function closeAuction(tx: Tx, auctionId: string): Promise<CloseOutcome> {
  const auction = await lockAuction(tx, auctionId);
  if (!OPEN_STATES.includes(String(auction.status))) {
    const [intent] = await tx<Row[]>`select order_id from app.auction_purchase_intents where auction_id=${auctionId} order by created_at desc limit 1`;
    return { outcome: 'ALREADY_CLOSED', ...(intent ? { orderId: String(intent.order_id) } : {}) };
  }
  if ((await dbNow(tx)) < new Date(auction.ends_at)) return { outcome: 'NOT_DUE' };
  const top = await highestValidBid(tx, auctionId);
  if (!top) {
    await tx`update app.auctions set status='NO_BIDS',closed_at=now(),version=version+1,updated_at=now() where id=${auctionId}`;
    await releaseAuctionReservation(tx, auctionId);
    await enqueueNotification(tx, auctionId, `notify:auction.no_bids:${auctionId}`, { templateId: 'auction.expired', recipientId: String(auction.seller_id), params: { auctionRef: auctionId } });
    return { outcome: 'NO_BIDS' };
  }
  const expiresAt = new Date((await dbNow(tx)).getTime() + WINNER_PAYMENT_HOURS * 3600_000);
  const orderId = await createSale(tx, auction, { buyerId: String(top.bidder_id), amountMinor: String(top.amount_minor), kind: 'WINNER', bidId: String(top.id), expiresAt });
  await enqueueNotification(tx, auctionId, `notify:auction.won:${auctionId}`, {
    templateId: 'auction.won', recipientId: String(top.bidder_id),
    params: { auctionRef: auctionId, amount: String(top.amount_minor), currency: 'USD', paymentDueAt: expiresAt.toISOString() },
  });
  return { outcome: 'WINNER_SELECTED', orderId };
}

const createAuction: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot create auctions', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['AUCTIONS_ENABLED']);
  const service = await ownedService(tx, actor, text(form, 'service_id'));
  if (String(service.status) !== 'PUBLISHED' || !service.published_version_id) throw new CommandError('Only a published service can be auctioned', 'DOMAIN_RULE');
  const starting = money(text(form, 'starting_price'), 'starting_price');
  const increment = money(text(form, 'minimum_increment'), 'minimum_increment');
  const buyValue = text(form, 'buy_now_price', false);
  const buy = buyValue ? money(buyValue, 'buy_now_price') : null;
  if (buy !== null && buy <= starting) throw new CommandError('Buy Now must be above the starting price');
  const now = await dbNow(tx);
  const starts = instant(text(form, 'starts_at'), 'starts_at');
  const ends = instant(text(form, 'ends_at'), 'ends_at');
  if (starts.getTime() < now.getTime() - BACKDATE_TOLERANCE_MS) throw new CommandError('The auction cannot start in the past');
  if (ends <= starts || ends <= now) throw new CommandError('The auction must end after it starts and in the future');
  if (ends.getTime() - starts.getTime() > MAX_AUCTION_DAYS * 86_400_000) throw new CommandError(`Auctions can run for at most ${MAX_AUCTION_DAYS} days`);
  const [version] = await tx<Row[]>`select * from app.service_versions where id=${String(service.published_version_id)}`;
  // AUC-01: the held week must still fit the work after the auction ends and the winner's payment window closes.
  const workStart = new Date(ends.getTime() + WINNER_PAYMENT_HOURS * 3600_000);
  const bucket = await lockAvailableBucket(tx, String(version!.pool_id), Number(version!.turnaround_hours), null, workStart);
  const terms = {
    service_version_id: String(version!.id),
    service_version: Number(version!.version),
    title: version!.title,
    scope: version!.description,
    taxonomy: version!.taxonomy,
    currency: version!.currency,
    turnaround_hours: Number(version!.turnaround_hours),
    revision_limit: Number(version!.revision_limit),
    review_window_hours: Number(version!.review_window_hours),
    cancellation_policy_version: 'v1',
    starting_price_minor: starting.toString(),
    minimum_increment_minor: increment.toString(),
    buy_now_price_minor: buy?.toString() ?? null,
    starts_at: starts.toISOString(),
    ends_at: ends.toISOString(),
    winner_payment_hours: WINNER_PAYMENT_HOURS,
    capacity: { pool_id: String(bucket.pool_id), bucket_id: String(bucket.id), week_starts_at: new Date(bucket.starts_at).toISOString(), week_ends_at: new Date(bucket.ends_at).toISOString() },
  };
  const status = starts <= now ? 'LIVE' : 'SCHEDULED';
  const [auction] = await tx<Row[]>`insert into app.auctions (service_id,service_version_id,seller_id,title,starting_price_minor,minimum_increment_minor,buy_now_price_minor,starts_at,ends_at,status,terms_snapshot)
    values (${String(service.id)},${String(version!.id)},${actor.id},${version!.title},${starting.toString()},${increment.toString()},${buy?.toString() ?? null},
      ${starts.toISOString()},${ends.toISOString()},${status},${JSON.stringify(terms)}::jsonb) returning id`;
  await insertReservation(tx, bucket, { auctionId: String(auction!.id) }, workStart);
  return { path: `/auctions/${auction!.id}`, message: 'Auction scheduled and one capacity unit reserved', id: String(auction!.id) };
};

/** AUC-02/03/04: lock → server time → minimum → sequenced insert → pointer; ties go to the first committed bid. */
const bid: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot bid', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['AUCTIONS_ENABLED', 'BIDDING_ENABLED']);
  const auctionId = uuid(form, 'auction_id');
  const amount = money(text(form, 'amount'), 'amount');
  const auction = await lockAuction(tx, auctionId);
  if (String(auction.seller_id) === actor.id) throw new CommandError('You cannot bid on your own auction', 'FORBIDDEN');
  await assertBiddingWindow(tx, auction);
  const top = await highestValidBid(tx, auctionId);
  const minimum = nextMinimum(auction, top);
  if (amount < minimum) throw new CommandError(`Bid at least ${usd(minimum)}; the highest bid changed or is below the increment`, 'BID_TOO_LOW');
  const requestKey = String(form.get('idempotency_key') ?? '').slice(0, 200) || crypto.randomUUID();
  const [inserted] = await tx<Row[]>`insert into app.bids (auction_id,bidder_id,amount_minor,sequence,request_key)
    values (${auctionId},${actor.id},${amount.toString()},(select coalesce(max(sequence),0)+1 from app.bids where auction_id=${auctionId}),${requestKey}) returning id,sequence`;
  await tx`update app.auctions set current_bid_id=${String(inserted!.id)},current_price_minor=${amount.toString()},bid_count=bid_count+1,
    first_valid_bid_at=coalesce(first_valid_bid_at, now()),version=version+1,updated_at=now() where id=${auctionId}`;
  if (top && String(top.bidder_id) !== actor.id) {
    await enqueueNotification(tx, auctionId, `notify:auction.outbid:${inserted!.id}`, {
      templateId: 'auction.outbid', recipientId: String(top.bidder_id), params: { auctionRef: auctionId, amount: amount.toString(), currency: 'USD' },
    });
  }
  return { path: `/auctions/${auctionId}`, message: `Bid of ${usd(amount)} accepted by the server`, id: String(inserted!.id) };
};

/** §10.4: Buy Now only before the first valid bid ever (first_valid_bid_at is write-once), with a checkout TTL. */
const buyNow: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot buy', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['AUCTIONS_ENABLED', 'CHECKOUT_CREATION_ENABLED']);
  const auctionId = uuid(form, 'auction_id');
  const auction = await lockAuction(tx, auctionId);
  if (String(auction.seller_id) === actor.id) throw new CommandError('You cannot buy your own auction', 'FORBIDDEN');
  if (!auction.buy_now_price_minor) throw new CommandError('This auction has no Buy Now price', 'DOMAIN_RULE');
  if (auction.first_valid_bid_at) throw new CommandError('Bidding has started, so Buy Now is no longer available', 'BUY_NOW_UNAVAILABLE');
  const now = await assertBiddingWindow(tx, auction);
  const expiresAt = new Date(now.getTime() + CHECKOUT_HOLD_MINUTES * 60_000);
  const orderId = await createSale(tx, auction, { buyerId: actor.id, amountMinor: String(auction.buy_now_price_minor), kind: 'BUY_NOW', bidId: null, expiresAt });
  return { path: `/orders/${orderId}`, message: 'Buy Now reserved the auction slot. Fund the order to confirm.', id: orderId };
};

const closeAuctionCommand: CommandHandler = async ({ tx, actor, form }) => {
  const auctionId = uuid(form, 'auction_id');
  const [owned] = await tx<Row[]>`select seller_id from app.auctions where id=${auctionId}`;
  if (!owned || String(owned.seller_id) !== actor.id) throw new CommandError('Auction not found or not owned by this account', 'NOT_FOUND');
  const result = await closeAuction(tx, auctionId);
  if (result.outcome === 'NOT_DUE') throw new CommandError('The auction can only close after its server deadline', 'AUCTION_NOT_LIVE');
  if (result.outcome === 'ALREADY_CLOSED') throw new CommandError('This auction is already closed', 'ORDER_STATE_CONFLICT');
  return {
    path: `/auctions/${auctionId}`,
    message: result.outcome === 'NO_BIDS' ? 'Auction closed with no valid bids; capacity released' : 'Auction closed. The winner has 24 hours to fund the order.',
    ...(result.orderId ? { id: result.orderId } : {}),
  };
};

/** AUC-12: before any valid bid and sale intent only; the row lock serializes against a racing first bid. */
const cancelAuction: CommandHandler = async ({ tx, actor, form }) => {
  const auctionId = uuid(form, 'auction_id');
  const auction = await lockAuction(tx, auctionId);
  if (String(auction.seller_id) !== actor.id) throw new CommandError('Auction not found or not owned by this account', 'NOT_FOUND');
  if (!OPEN_STATES.includes(String(auction.status)) || auction.first_valid_bid_at) {
    throw new CommandError('An auction with bids or a sale in progress cannot be cancelled; contact support', 'ORDER_STATE_CONFLICT');
  }
  const reason = text(form, 'reason', false, 500) || 'Cancelled by seller before any bid';
  await tx`update app.auctions set status='CANCELLED',cancel_reason=${reason},closed_at=now(),version=version+1,updated_at=now() where id=${auctionId}`;
  await releaseAuctionReservation(tx, auctionId);
  return { path: `/auctions/${auctionId}`, message: 'Auction cancelled and capacity released' };
};

export const auctionCommands: Record<string, CommandHandler> = {
  create_auction: createAuction,
  bid,
  buy_now: buyNow,
  close_auction: closeAuctionCommand,
  cancel_auction: cancelAuction,
};
