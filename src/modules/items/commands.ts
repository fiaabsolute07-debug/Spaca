/**
 * Web3 item auctions (drizzle/0033): listing, collateral, bids, Buy now, escrowed payment, delivery, confirmation,
 * disputes and refunds. Money is a sandbox escrow in the double-entry ledger — every movement is a balanced
 * transaction between `sandbox_wallet:<user>`, `item_collateral:<listing>` and `item_escrow:<sale>`, and both holding
 * accounts end at zero when a sale settles. No provider is called and no funds move.
 */
import { isBuyer } from '@/lib/account';
import { CommandError, httpUrl, instantField, money, text, uuid, type CommandHandler, type Row, type Tx } from '@/lib/commands';
import { ITEM_COLLATERAL_MIN_DIVISOR, ITEM_CONFIRM_HOURS, ITEM_PAYMENT_HOURS, usd } from '@/lib/items';
import { audit, reasonOf, requireRole } from '@/modules/admin/policy';
import { screenContent } from '@/modules/moderation/policy';

const HOUR = 3600_000;
const START_TOLERANCE_MS = 5 * 60_000;
const MIN_DURATION_MS = 5 * 60_000;
const MAX_DURATION_MS = 14 * 24 * HOUR;

const dbNow = async (tx: Tx) => new Date(String((await tx<Row[]>`select now() as now`)[0]!.now));
const when = (value: unknown) => new Date(String(value)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

/** A required text field with a message people understand. */
function field(form: FormData, name: string, label: string, min: number, max: number): string {
  const value = String(form.get(name) ?? '').trim();
  if (!value) throw new CommandError(`Add ${label}`);
  if (value.length < min) throw new CommandError(`${label[0]!.toUpperCase()}${label.slice(1)} needs at least ${min} characters`);
  if (value.length > max) throw new CommandError(`${label[0]!.toUpperCase()}${label.slice(1)} can be at most ${max} characters`);
  return text(form, name, true, max);
}

/** One balanced ledger transaction; a repeated key posts nothing and reports false. */
async function post(tx: Tx, kind: string, key: string, entries: [account: string, amount: bigint][]): Promise<boolean> {
  if (entries.reduce((sum, [, amount]) => sum + amount, 0n) !== 0n) throw new Error(`unbalanced ledger transaction ${kind}`);
  const [transaction] = await tx<Row[]>`insert into app.ledger_transactions (order_id,kind,idempotency_key) values (null,${kind},${key})
    on conflict (idempotency_key) do nothing returning id`;
  if (!transaction) return false;
  for (const [account, amount] of entries) {
    if (amount !== 0n) await tx`insert into app.ledger_entries (transaction_id,account,amount_minor,currency) values (${String(transaction.id)},${account},${amount.toString()},'USD')`;
  }
  return true;
}

const wallet = (userId: unknown) => `sandbox_wallet:${String(userId)}`;

async function lockListing(tx: Tx, id: string): Promise<Row> {
  const [listing] = await tx<Row[]>`select * from app.item_listings where id=${id} for update`;
  if (!listing) throw new CommandError('Listing not found', 'NOT_FOUND');
  return listing;
}

async function lockSale(tx: Tx, id: string): Promise<{ sale: Row; listing: Row }> {
  const [ref] = await tx<Row[]>`select listing_id from app.item_sales where id=${id}`;
  if (!ref) throw new CommandError('Sale not found', 'NOT_FOUND');
  const listing = await lockListing(tx, String(ref.listing_id));
  const [sale] = await tx<Row[]>`select * from app.item_sales where id=${id} for update`;
  return { sale: sale!, listing };
}

const path = (listing: Row) => `/auctions/${String(listing.id)}`;

/** Collateral goes back to the seller, or to the buyer when the seller did not deliver. */
export async function releaseCollateral(tx: Tx, listing: Row, to: unknown): Promise<void> {
  const posted = await post(tx, 'ITEM_COLLATERAL_RELEASED', `item-collateral-release:${String(listing.id)}`, [
    [`item_collateral:${String(listing.id)}`, -BigInt(String(listing.collateral_minor))],
    [wallet(to), BigInt(String(listing.collateral_minor))],
  ]);
  if (posted) await tx`update app.item_listings set collateral_released_at=now(),updated_at=now() where id=${String(listing.id)}`;
}

/** The buyer confirmed (or stayed silent past the window, or an operator released): seller gets payment and collateral. */
export async function completeSale(tx: Tx, sale: Row, listing: Row): Promise<void> {
  await post(tx, 'ITEM_PAYMENT_RELEASED', `item-payment-release:${String(sale.id)}`, [
    [`item_escrow:${String(sale.id)}`, -BigInt(String(sale.price_minor))],
    [wallet(sale.seller_id), BigInt(String(sale.price_minor))],
  ]);
  await releaseCollateral(tx, listing, sale.seller_id);
  await tx`update app.item_sales set status='COMPLETED',completed_at=now(),version=version+1,updated_at=now() where id=${String(sale.id)}`;
}

/** Nothing arrived by the deadline (or an operator found the seller at fault): payment back plus the collateral. */
export async function defaultSeller(tx: Tx, sale: Row, listing: Row): Promise<void> {
  await refundPayment(tx, sale);
  await releaseCollateral(tx, listing, sale.buyer_id);
  await tx`update app.item_sales set status='SELLER_DEFAULTED',version=version+1,updated_at=now() where id=${String(sale.id)}`;
}

async function refundPayment(tx: Tx, sale: Row) {
  await post(tx, 'ITEM_PAYMENT_REFUNDED', `item-payment-refund:${String(sale.id)}`, [
    [`item_escrow:${String(sale.id)}`, -BigInt(String(sale.price_minor))],
    [wallet(sale.buyer_id), BigInt(String(sale.price_minor))],
  ]);
}

async function createSale(tx: Tx, listing: Row, buyerId: string, kind: 'WINNER' | 'BUY_NOW', price: bigint, bidId: string | null): Promise<string> {
  const [sale] = await tx<Row[]>`insert into app.item_sales (listing_id,buyer_id,seller_id,kind,bid_id,price_minor,collateral_minor,payment_due_at)
    values (${String(listing.id)},${buyerId},${String(listing.seller_id)},${kind},${bidId},${price.toString()},${String(listing.collateral_minor)},now() + make_interval(hours => ${ITEM_PAYMENT_HOURS}))
    returning id`;
  await tx`update app.item_listings set status='SOLD',closed_at=now(),version=version+1,updated_at=now() where id=${String(listing.id)}`;
  return String(sale!.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Listing

const createItemListing: CommandHandler = async ({ tx, actor, form }) => {
  const origin = text(form, 'origin');
  if (origin !== 'PROJECT' && origin !== 'RESALE') throw new CommandError('Choose whether you are the project or reselling');
  if (origin === 'PROJECT' && !isBuyer(actor)) {
    throw new CommandError('Only a project (buyer) account can sell its own allocation. Choose "I’m reselling" if you hold this item.', 'FORBIDDEN');
  }
  const itemType = field(form, 'item_type', 'what kind of item this is', 2, 40);
  const title = field(form, 'title', 'a title', 4, 120);
  const projectName = field(form, 'project_name', 'the project name', 1, 80);
  const projectLink = text(form, 'project_url', false, 300);
  const projectUrl = projectLink ? httpUrl(/^https?:\/\//i.test(projectLink) ? projectLink : `https://${projectLink}`, 'The project link') : null;
  if (projectUrl && !projectUrl.startsWith('https://')) throw new CommandError('The project link must start with https://');
  const network = field(form, 'network', 'the network', 1, 40);
  const quantity = field(form, 'quantity', 'the quantity', 1, 60);
  const description = field(form, 'description', 'a description', 20, 2000);
  const deliveryMethod = field(form, 'delivery_method', 'how the item is delivered', 10, 500);
  const buyerProvides = field(form, 'buyer_provides', 'what the buyer must provide', 3, 120);
  const violations = screenContent(title, description, deliveryMethod);
  if (violations.length) throw new CommandError(`This listing breaks the marketplace content policy: ${violations.map((v) => v.message).join(' ')}`, 'DOMAIN_RULE');

  const starting = money(text(form, 'starting_price'), 'Starting price');
  const increment = money(text(form, 'min_increment'), 'Minimum increment');
  const buyNowValue = text(form, 'buy_now_price', false, 20);
  const buyNow = buyNowValue ? money(buyNowValue, 'Buy now price') : null;
  if (buyNow !== null && buyNow <= starting) throw new CommandError('Set the Buy now price above the starting price, or leave it empty');
  const collateral = money(text(form, 'collateral'), 'Collateral');
  const floor = (starting + BigInt(ITEM_COLLATERAL_MIN_DIVISOR) - 1n) / BigInt(ITEM_COLLATERAL_MIN_DIVISOR);
  if (collateral < floor) throw new CommandError(`Collateral must be at least ${usd(floor)}, a fifth of the starting price`);

  const now = await dbNow(tx);
  const startsAt = instantField(form, 'starts_at');
  const endsAt = instantField(form, 'ends_at');
  const deliveryDue = instantField(form, 'delivery_due_at');
  if (startsAt.getTime() < now.getTime() - START_TOLERANCE_MS) throw new CommandError('The start time is in the past');
  if (endsAt.getTime() - startsAt.getTime() < MIN_DURATION_MS) throw new CommandError('The auction must run for at least 5 minutes');
  if (endsAt.getTime() - startsAt.getTime() > MAX_DURATION_MS) throw new CommandError('The auction can run for at most 14 days');
  if (deliveryDue.getTime() < endsAt.getTime() + HOUR) throw new CommandError('Set the delivery deadline at least an hour after the auction ends');
  if (deliveryDue.getTime() > endsAt.getTime() + 365 * 24 * HOUR) throw new CommandError('The delivery deadline can be at most a year after the auction ends');

  const [listing] = await tx<Row[]>`insert into app.item_listings (seller_id,origin,item_type,title,project_name,project_url,network,quantity,description,
      delivery_method,buyer_provides,delivery_due_at,starting_price_minor,min_increment_minor,buy_now_price_minor,collateral_minor,starts_at,ends_at)
    values (${actor.id},${origin},${itemType},${title},${projectName},${projectUrl},${network},${quantity},${description},${deliveryMethod},${buyerProvides},
      ${deliveryDue.toISOString()},${starting.toString()},${increment.toString()},${buyNow === null ? null : buyNow.toString()},${collateral.toString()},${startsAt.toISOString()},${endsAt.toISOString()})
    returning id`;
  return { path: `/auctions/${String(listing!.id)}`, message: `Listing created. Lock the ${usd(collateral)} collateral to open it.`, id: String(listing!.id) };
};

const postItemCollateral: CommandHandler = async ({ tx, actor, form }) => {
  const listing = await lockListing(tx, uuid(form, 'listing_id'));
  if (String(listing.seller_id) !== actor.id) throw new CommandError('Listing not found', 'NOT_FOUND');
  if (listing.status !== 'AWAITING_COLLATERAL') throw new CommandError('The collateral is already locked', 'ORDER_STATE_CONFLICT');
  const now = await dbNow(tx);
  if (new Date(String(listing.ends_at)) <= now) throw new CommandError('This listing has already ended. Create a new one.', 'ORDER_STATE_CONFLICT');
  await post(tx, 'ITEM_COLLATERAL_LOCKED', `item-collateral-lock:${String(listing.id)}`, [
    [wallet(actor.id), -BigInt(String(listing.collateral_minor))],
    [`item_collateral:${String(listing.id)}`, BigInt(String(listing.collateral_minor))],
  ]);
  await tx`update app.item_listings set status='OPEN',collateral_posted_at=now(),version=version+1,updated_at=now() where id=${String(listing.id)}`;
  const opens = new Date(String(listing.starts_at)) > now ? ` Bidding opens ${when(listing.starts_at)}.` : ' Bidding is open.';
  return { path: path(listing), message: `Collateral of ${usd(String(listing.collateral_minor))} locked (sandbox).${opens}` };
};

const cancelItemListing: CommandHandler = async ({ tx, actor, form }) => {
  const listing = await lockListing(tx, uuid(form, 'listing_id'));
  if (String(listing.seller_id) !== actor.id) throw new CommandError('Listing not found', 'NOT_FOUND');
  if (!['AWAITING_COLLATERAL', 'OPEN'].includes(String(listing.status))) throw new CommandError('This listing has already closed', 'ORDER_STATE_CONFLICT');
  if (Number(listing.bid_count) > 0) throw new CommandError('Bids have been placed, so the auction runs to its end', 'ORDER_STATE_CONFLICT');
  const reason = text(form, 'reason', false, 500) || null;
  await tx`update app.item_listings set status='CANCELLED',cancel_reason=${reason},closed_at=now(),version=version+1,updated_at=now() where id=${String(listing.id)}`;
  if (listing.collateral_posted_at) await releaseCollateral(tx, listing, listing.seller_id);
  return { path: '/auctions', message: listing.collateral_posted_at ? 'Listing cancelled. The collateral is back with you.' : 'Listing cancelled.' };
};

// ---------------------------------------------------------------------------------------------------------------------
// Bidding

async function assertLive(tx: Tx, listing: Row, actorId: string) {
  if (listing.status !== 'OPEN') throw new CommandError('This auction is not open', 'ORDER_STATE_CONFLICT');
  if (String(listing.seller_id) === actorId) throw new CommandError('You cannot bid on your own listing', 'FORBIDDEN');
  const now = await dbNow(tx);
  if (now < new Date(String(listing.starts_at))) throw new CommandError(`Bidding opens ${when(listing.starts_at)}`, 'ORDER_STATE_CONFLICT');
  if (now >= new Date(String(listing.ends_at))) throw new CommandError('This auction has ended', 'ORDER_STATE_CONFLICT');
}

const bidItem: CommandHandler = async ({ tx, actor, form }) => {
  const listing = await lockListing(tx, uuid(form, 'listing_id'));
  await assertLive(tx, listing, actor.id);
  const amount = money(text(form, 'amount'), 'Bid');
  const [current] = listing.current_bid_id ? await tx<Row[]>`select amount_minor,bidder_id from app.item_bids where id=${String(listing.current_bid_id)}` : [];
  const minimum = current ? BigInt(String(current.amount_minor)) + BigInt(String(listing.min_increment_minor)) : BigInt(String(listing.starting_price_minor));
  if (amount < minimum) throw new CommandError(`Bid at least ${usd(minimum)}`, 'ORDER_STATE_CONFLICT');
  if (listing.buy_now_price_minor != null && amount >= BigInt(String(listing.buy_now_price_minor))) {
    throw new CommandError(`That reaches the Buy now price of ${usd(String(listing.buy_now_price_minor))}. Use Buy now instead.`, 'ORDER_STATE_CONFLICT');
  }
  const sequence = Number(listing.bid_count) + 1;
  const [bid] = await tx<Row[]>`insert into app.item_bids (listing_id,bidder_id,amount_minor,sequence) values (${String(listing.id)},${actor.id},${amount.toString()},${sequence}) returning id`;
  await tx`update app.item_listings set current_bid_id=${String(bid!.id)},bid_count=${sequence},first_bid_at=coalesce(first_bid_at,now()),version=version+1,updated_at=now()
    where id=${String(listing.id)}`;
  return { path: path(listing), message: `Bid of ${usd(amount)} placed. You are the highest bidder.`, id: String(bid!.id) };
};

const buyItemNow: CommandHandler = async ({ tx, actor, form }) => {
  const listing = await lockListing(tx, uuid(form, 'listing_id'));
  await assertLive(tx, listing, actor.id);
  if (listing.buy_now_price_minor == null) throw new CommandError('This listing has no Buy now price', 'BUY_NOW_UNAVAILABLE');
  if (Number(listing.bid_count) > 0) throw new CommandError('Buy now ends with the first bid', 'BUY_NOW_UNAVAILABLE');
  await createSale(tx, listing, actor.id, 'BUY_NOW', BigInt(String(listing.buy_now_price_minor)), null);
  return { path: path(listing), message: `Bought for ${usd(String(listing.buy_now_price_minor))}. Pay into escrow within ${ITEM_PAYMENT_HOURS} hours.` };
};

// ---------------------------------------------------------------------------------------------------------------------
// After the sale

const payItemSale: CommandHandler = async ({ tx, actor, form }) => {
  const { sale, listing } = await lockSale(tx, uuid(form, 'sale_id'));
  if (String(sale.buyer_id) !== actor.id) throw new CommandError('Sale not found', 'NOT_FOUND');
  if (sale.status !== 'AWAITING_PAYMENT') throw new CommandError('This sale is already paid or closed', 'ORDER_STATE_CONFLICT');
  if (await dbNow(tx) > new Date(String(sale.payment_due_at))) throw new CommandError('The payment window has closed', 'ORDER_STATE_CONFLICT');
  const details = field(form, 'buyer_details', `your ${String(listing.buyer_provides)}`, 3, 300);
  await post(tx, 'ITEM_PAYMENT_LOCKED', `item-payment-lock:${String(sale.id)}`, [
    [wallet(actor.id), -BigInt(String(sale.price_minor))],
    [`item_escrow:${String(sale.id)}`, BigInt(String(sale.price_minor))],
  ]);
  await tx`update app.item_sales set status='AWAITING_DELIVERY',paid_at=now(),buyer_details=${details},version=version+1,updated_at=now() where id=${String(sale.id)}`;
  return { path: path(listing), message: `${usd(String(sale.price_minor))} held in escrow (sandbox). The seller must deliver by ${when(listing.delivery_due_at)}.` };
};

const markItemDelivered: CommandHandler = async ({ tx, actor, form }) => {
  const { sale, listing } = await lockSale(tx, uuid(form, 'sale_id'));
  if (String(sale.seller_id) !== actor.id) throw new CommandError('Sale not found', 'NOT_FOUND');
  if (sale.status !== 'AWAITING_DELIVERY') throw new CommandError('This sale is not waiting for delivery', 'ORDER_STATE_CONFLICT');
  if (await dbNow(tx) > new Date(String(listing.delivery_due_at))) throw new CommandError('The delivery deadline has passed', 'ORDER_STATE_CONFLICT');
  const proof = field(form, 'delivery_proof', 'proof of delivery', 5, 500);
  await tx`update app.item_sales set status='DELIVERED',delivered_at=now(),delivery_proof=${proof},confirm_by=now() + make_interval(hours => ${ITEM_CONFIRM_HOURS}),
    version=version+1,updated_at=now() where id=${String(sale.id)}`;
  return { path: path(listing), message: `Marked as delivered. The buyer has ${ITEM_CONFIRM_HOURS} hours to confirm or dispute.` };
};

const confirmItemReceived: CommandHandler = async ({ tx, actor, form }) => {
  const { sale, listing } = await lockSale(tx, uuid(form, 'sale_id'));
  if (String(sale.buyer_id) !== actor.id) throw new CommandError('Sale not found', 'NOT_FOUND');
  if (sale.status !== 'DELIVERED') throw new CommandError('Confirm only after the seller marks the item delivered', 'ORDER_STATE_CONFLICT');
  await completeSale(tx, sale, listing);
  return { path: path(listing), message: 'Confirmed. The seller is paid and gets the collateral back.' };
};

const disputeItemSale: CommandHandler = async ({ tx, actor, form }) => {
  const { sale, listing } = await lockSale(tx, uuid(form, 'sale_id'));
  if (String(sale.buyer_id) !== actor.id) throw new CommandError('Sale not found', 'NOT_FOUND');
  const now = await dbNow(tx);
  const open = sale.status === 'AWAITING_DELIVERY' || (sale.status === 'DELIVERED' && now <= new Date(String(sale.confirm_by)));
  if (!open) throw new CommandError('This sale can no longer be disputed', 'ORDER_STATE_CONFLICT');
  const reason = field(form, 'dispute_reason', 'what went wrong', 10, 1000);
  await tx`update app.item_sales set status='DISPUTED',disputed_at=now(),dispute_reason=${reason},version=version+1,updated_at=now() where id=${String(sale.id)}`;
  return { path: path(listing), message: 'Dispute opened. The payment and collateral stay in escrow until an operator decides.' };
};

const claimItemRefund: CommandHandler = async ({ tx, actor, form }) => {
  const { sale, listing } = await lockSale(tx, uuid(form, 'sale_id'));
  if (String(sale.buyer_id) !== actor.id) throw new CommandError('Sale not found', 'NOT_FOUND');
  if (sale.status !== 'AWAITING_DELIVERY') throw new CommandError('A refund can be claimed only while delivery is outstanding', 'ORDER_STATE_CONFLICT');
  if (await dbNow(tx) <= new Date(String(listing.delivery_due_at))) throw new CommandError(`The seller has until ${when(listing.delivery_due_at)} to deliver`, 'ORDER_STATE_CONFLICT');
  await defaultSeller(tx, sale, listing);
  return { path: path(listing), message: `Refunded ${usd(String(sale.price_minor))} plus the seller's ${usd(String(sale.collateral_minor))} collateral (sandbox).` };
};

/** Finance or admin decide a dispute with a written reason: pay the seller, refund with the collateral, or refund only. */
const resolveItemDispute: CommandHandler = async ({ tx, actor, form }) => {
  const outcome = text(form, 'outcome');
  if (!['RELEASE_TO_SELLER', 'REFUND_WITH_COLLATERAL', 'REFUND'].includes(outcome)) throw new CommandError('outcome must be RELEASE_TO_SELLER, REFUND_WITH_COLLATERAL or REFUND');
  requireRole(actor, ['finance', 'admin'], 'Resolving an item dispute');
  const reason = reasonOf(form);
  const { sale, listing } = await lockSale(tx, uuid(form, 'sale_id'));
  if (sale.status !== 'DISPUTED') throw new CommandError('This sale is not in dispute', 'ORDER_STATE_CONFLICT');
  if (outcome === 'RELEASE_TO_SELLER') await completeSale(tx, sale, listing);
  else if (outcome === 'REFUND_WITH_COLLATERAL') await defaultSeller(tx, sale, listing);
  else {
    await refundPayment(tx, sale);
    await releaseCollateral(tx, listing, sale.seller_id);
    await tx`update app.item_sales set status='REFUNDED',version=version+1,updated_at=now() where id=${String(sale.id)}`;
  }
  const resolution = outcome === 'RELEASE_TO_SELLER' ? 'RELEASED_TO_SELLER' : outcome === 'REFUND_WITH_COLLATERAL' ? 'REFUNDED_WITH_COLLATERAL' : 'REFUNDED';
  await tx`update app.item_sales set resolution=${resolution},resolved_at=now(),resolved_by=${actor.id},updated_at=now() where id=${String(sale.id)}`;
  await audit(tx, actor, 'resolve_item_dispute', 'item_sale', String(sale.id), reason, { status: 'DISPUTED' }, { resolution });
  return { path: '/admin/item-disputes', message: 'Dispute resolved' };
};

export const itemCommands: Record<string, CommandHandler> = {
  create_item_listing: createItemListing,
  post_item_collateral: postItemCollateral,
  cancel_item_listing: cancelItemListing,
  bid_item: bidItem,
  buy_item_now: buyItemNow,
  pay_item_sale: payItemSale,
  mark_item_delivered: markItemDelivered,
  confirm_item_received: confirmItemReceived,
  dispute_item_sale: disputeItemSale,
  claim_item_refund: claimItemRefund,
  admin_resolve_item_dispute: resolveItemDispute,
};

export { createSale };
