import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/items/jobs');
const queries = await import('@/modules/items/queries');
const { sql } = await import('@/lib/db');
// Deadlines frozen after the first bid can only be moved by the database owner (the app role cannot bypass triggers).
const owner = RUN_DB ? postgres(process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://postgres:local_dev_only@127.0.0.1:55432/creator_marketplace_test', { max: 1 }) : null;

const command = (actor: TestUser, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const utc = (date: Date) => date.toISOString().slice(0, 16);
const HOUR = 3600_000;

async function operator(role: 'finance' | 'support'): Promise<TestUser> {
  const user = await createUser(`item-${role}`, []);
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user.id},${role},'Item auction suite operator grant')`;
  return user;
}

function listingFields(overrides: Record<string, string> = {}): Record<string, string> {
  const now = Date.now();
  return {
    command: 'create_item_listing', idempotency_key: key('item'), origin: 'RESALE', item_type: 'WL spot',
    title: 'Arcadia genesis mint WL spot', project_name: 'Arcadia', project_url: 'arcadia.example', network: 'Base', quantity: '1 spot',
    description: 'One whitelist spot for the Arcadia genesis mint, mint price 0.02 ETH.',
    delivery_method: 'The project adds your wallet to the allowlist before the mint.', buyer_provides: 'EVM wallet address',
    starting_price: '100', min_increment: '10', collateral: '20',
    starts_at: utc(new Date(now - 60_000)), ends_at: utc(new Date(now + 2 * HOUR)), delivery_due_at: utc(new Date(now + 26 * HOUR)),
    ...overrides,
  };
}

async function openListing(seller: TestUser, overrides: Record<string, string> = {}): Promise<string> {
  const created = await command(seller, listingFields(overrides));
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = String(created.body.id);
  const locked = await command(seller, { command: 'post_item_collateral', idempotency_key: key('col'), listing_id: id });
  expect(locked.status, JSON.stringify(locked.body)).toBe(200);
  return id;
}

const balance = async (account: string) => Number((await sql`select coalesce(sum(amount_minor),0)::bigint as n from app.ledger_entries where account=${account}`)[0]!.n);
const saleOf = async (listingId: string) => (await sql`select * from app.item_sales where listing_id=${listingId}`)[0]!;
const listingOf = async (id: string) => (await sql`select * from app.item_listings where id=${id}`)[0]!;

beforeEach(() => {
  if (RUN_DB) funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_item_suite_secret_1'] }));
});
afterAll(async () => {
  if (!RUN_DB) return;
  funding.setMockPaymentProviderForTests(undefined);
  await owner?.end({ timeout: 5 });
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('Web3 item auctions (drizzle/0033)', () => {
  it('a listing opens on a title, a price and a closing time; everything else is optional and takes a sensible default', async () => {
    const seller = await createUser('item-minimal', ['creator']);
    const ends = new Date(Date.now() + 3 * HOUR);
    const created = await command(seller, {
      command: 'create_item_listing', idempotency_key: key('item-min'), origin: 'RESALE',
      title: 'WL spot', starting_price: '100', ends_at: utc(ends),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const listing = await listingOf(String(created.body.id));
    // Collateral is the floor, a fifth of the starting price; bids step by $5; delivery is due a week after the close.
    expect(listing).toMatchObject({ collateral_minor: '2000', min_increment_minor: '500', item_type: '', description: '' });
    expect(new Date(String(listing.delivery_due_at)).getTime()).toBe(new Date(String(listing.ends_at)).getTime() + 7 * 24 * HOUR);
    expect(new Date(String(listing.starts_at)).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a listing states the item, its delivery and collateral, and opens only once the collateral is locked', async () => {
    const creator = await createUser('item-seller', ['creator']);
    const project = await createUser('item-project', ['buyer']);
    const stranger = await createUser('item-stranger', ['buyer']);

    expect((await command(creator, listingFields({ origin: 'PROJECT' }))).body.error).toMatch(/^Only a project \(buyer\) account can sell its own allocation/);
    expect((await command(creator, listingFields({ collateral: '19.99' }))).body.error).toBe('Collateral must be at least $20.00, a fifth of the starting price');
    expect((await command(creator, listingFields({ buy_now_price: '100' }))).body.error).toBe('Set the Buy now price above the starting price, or leave it empty');
    expect((await command(creator, listingFields({ delivery_due_at: utc(new Date(Date.now() + 2.5 * HOUR)) }))).body.error).toBe('Set the delivery deadline at least an hour after the auction ends');
    expect((await command(creator, listingFields({ title: '' }))).body.error).toBe('Add a title');
    expect((await command(creator, listingFields({ starts_at: utc(new Date(Date.now() - HOUR)) }))).body.error).toBe('The start time is in the past');

    const created = await command(project, listingFields({ origin: 'PROJECT', item_type: 'GTD mint', title: 'Arcadia GTD mint, sold by the team' }));
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = String(created.body.id);
    expect(await listingOf(id)).toMatchObject({ status: 'AWAITING_COLLATERAL', origin: 'PROJECT', project_url: 'https://arcadia.example/', collateral_minor: '2000' });
    // Not public before the collateral: hidden from the board and from other people, visible to the seller.
    expect((await queries.getItemAuctionBoard({})).live.some((listing) => listing.id === id)).toBe(false);
    expect(await queries.getItemListing(id, { ...stranger, roles: ['buyer'], display_name: '', is_test: true, status: 'ACTIVE', timezone: 'UTC' })).toBeNull();
    expect((await command(stranger, { command: 'bid_item', idempotency_key: key('bid'), listing_id: id, amount: '100' })).body.error).toBe('This auction is not open');

    const locked = await command(project, { command: 'post_item_collateral', idempotency_key: key('col'), listing_id: id });
    expect(locked.body.message).toBe('Collateral of $20.00 locked (sandbox). Bidding is open.');
    expect(await balance(`item_collateral:${id}`)).toBe(2000);
    expect(await balance(`sandbox_wallet:${project.id}`)).toBe(-2000);
    expect((await command(project, { command: 'post_item_collateral', idempotency_key: key('col'), listing_id: id })).status).toBe(409);
    const board = await queries.getItemAuctionBoard({ type: 'gtd MINT', origin: 'PROJECT' });
    expect(board.live.find((listing) => listing.id === id)).toMatchObject({ itemType: 'GTD mint', origin: 'PROJECT', collateral: 2000, currentBid: null });
    expect((await queries.getItemAuctionBoard({ origin: 'RESALE' })).live.some((listing) => listing.id === id)).toBe(false);
  });

  it('while payments are closed, a listing waiting for collateral shows to everyone as not open for bidding', async () => {
    const seller = await createUser('item-closed-seller', ['creator']);
    const created = await command(seller, listingFields({ title: 'Listing shown before payments open' }));
    const id = String(created.body.id);
    vi.stubEnv('PAYMENT_MODE', 'off');
    try {
      expect((await queries.getItemAuctionBoard({})).live.find((listing) => listing.id === id)).toMatchObject({ collateralLocked: false, bidCount: 0 });
      expect((await queries.getItemListing(id, null))?.listing).toMatchObject({ status: 'AWAITING_COLLATERAL' });
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await queries.getItemAuctionBoard({})).live.some((listing) => listing.id === id)).toBe(false);
    expect(await queries.getItemListing(id, null)).toBeNull();
  });

  it('bids climb by the increment, Buy now ends with the first bid, and the highest bid wins at the end', async () => {
    const seller = await createUser('item-bid-seller', ['creator']);
    const alice = await createUser('item-alice', ['buyer']);
    const bob = await createUser('item-bob', ['creator']);
    const id = await openListing(seller, { buy_now_price: '400' });
    const bid = (actor: TestUser, amount: string) => command(actor, { command: 'bid_item', idempotency_key: key('bid'), listing_id: id, amount });

    expect((await bid(seller, '150')).body.error).toBe('You cannot bid on your own listing');
    expect((await bid(alice, '99')).body.error).toBe('Bid at least $100.00');
    expect((await bid(alice, '400')).body.error).toBe('That reaches the Buy now price of $400.00. Use Buy now instead.');
    expect((await bid(alice, '100')).body.message).toBe('Bid of $100.00 placed. You are the highest bidder.');
    expect((await bid(bob, '109')).body.error).toBe('Bid at least $110.00');
    expect((await bid(bob, '125')).status).toBe(200);
    expect((await command(alice, { command: 'buy_item_now', idempotency_key: key('bn'), listing_id: id })).body.error).toBe('Buy now ends with the first bid');
    expect((await command(seller, { command: 'cancel_item_listing', idempotency_key: key('cx'), listing_id: id })).body.error).toBe('Bids have been placed, so the auction runs to its end');

    const asAlice = await queries.getItemListing(id, { id: alice.id, email: alice.email, roles: ['buyer'], display_name: '', is_test: true, status: 'ACTIVE', timezone: 'UTC' });
    expect(asAlice!.bids.map((entry) => [entry.bidder, entry.amount])).toEqual([['Bidder 2', 12500], ['You', 10000]]);
    expect(asAlice!.listing).toMatchObject({ currentBid: 12500, nextMinimum: 13500, leading: false, buyNowAvailable: false, live: true });

    // Time runs out.
    await owner!.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update app.item_listings set starts_at=now() - interval '3 hours',ends_at=now() - interval '1 minute' where id=${id}`;
    });
    expect((await bid(alice, '200')).body.error).toBe('This auction has ended');
    const closed = await jobs.closeDueItemListings({ listingId: id });
    expect(closed.outcomes).toEqual({ SOLD: 1 });
    expect(await listingOf(id)).toMatchObject({ status: 'SOLD' });
    expect(await saleOf(id)).toMatchObject({ kind: 'WINNER', buyer_id: bob.id, price_minor: '12500', collateral_minor: '2000', status: 'AWAITING_PAYMENT' });
    expect((await jobs.closeDueItemListings({ listingId: id })).examined).toBe(0);
  });

  it('paid, delivered and confirmed: the seller gets the payment and the collateral back, and escrow ends at zero', async () => {
    const seller = await createUser('item-happy-seller', ['creator']);
    const buyer = await createUser('item-happy-buyer', ['buyer']);
    const id = await openListing(seller, { buy_now_price: '300', collateral: '60' });
    expect((await command(buyer, { command: 'buy_item_now', idempotency_key: key('bn'), listing_id: id })).body.message).toBe('Bought for $300.00. Pay into escrow within 24 hours.');
    const sale = await saleOf(id);
    const saleId = String(sale.id);

    expect((await command(seller, { command: 'pay_item_sale', idempotency_key: key('pay'), sale_id: saleId, buyer_details: '0xabc' })).status).toBe(404);
    expect((await command(buyer, { command: 'pay_item_sale', idempotency_key: key('pay'), sale_id: saleId })).body.error).toBe('Add your EVM wallet address');
    expect((await command(buyer, { command: 'mark_item_delivered', idempotency_key: key('dl'), sale_id: saleId, delivery_proof: 'Added to list' })).status).toBe(404);
    const paid = await command(buyer, { command: 'pay_item_sale', idempotency_key: key('pay'), sale_id: saleId, buyer_details: '0x1111222233334444555566667777888899990000' });
    expect(paid.body.message).toMatch(/^\$300\.00 held in escrow \(sandbox\)\. The seller must deliver by /);
    expect(await balance(`item_escrow:${saleId}`)).toBe(30000);
    expect((await command(buyer, { command: 'confirm_item_received', idempotency_key: key('ok'), sale_id: saleId })).body.error).toBe('Confirm only after the seller marks the item delivered');

    const asSeller = await queries.getItemListing(id, { id: seller.id, email: seller.email, roles: ['creator'], display_name: '', is_test: true, status: 'ACTIVE', timezone: 'UTC' });
    expect(asSeller!.sale!.buyerDetails).toBe('0x1111222233334444555566667777888899990000');
    const asVisitor = await queries.getItemListing(id, null);
    expect(asVisitor!.sale!.buyerDetails).toBeNull();

    expect((await command(seller, { command: 'mark_item_delivered', idempotency_key: key('dl'), sale_id: saleId, delivery_proof: 'Wallet added to the allowlist: https://arcadia.example/allowlist' })).body.message)
      .toBe('Marked as delivered. The buyer has 72 hours to confirm or dispute.');
    expect((await command(buyer, { command: 'confirm_item_received', idempotency_key: key('ok'), sale_id: saleId })).body.message).toBe('Confirmed. The seller is paid and gets the collateral back.');
    expect(await saleOf(id)).toMatchObject({ status: 'COMPLETED' });
    expect(await balance(`item_escrow:${saleId}`)).toBe(0);
    expect(await balance(`item_collateral:${id}`)).toBe(0);
    expect(await balance(`sandbox_wallet:${seller.id}`)).toBe(30000);
    expect(await balance(`sandbox_wallet:${buyer.id}`)).toBe(-30000);
    // A settled sale does not move again.
    await expect(sql`update app.item_sales set status='DISPUTED' where id=${saleId}`).rejects.toThrow(/cannot move from COMPLETED to DISPUTED/);
  });

  it('a seller who misses the delivery deadline loses the collateral to the buyer, who is refunded', async () => {
    const seller = await createUser('item-late-seller', ['creator']);
    const buyer = await createUser('item-late-buyer', ['buyer']);
    const id = await openListing(seller, { buy_now_price: '250', collateral: '100' });
    await command(buyer, { command: 'buy_item_now', idempotency_key: key('bn'), listing_id: id });
    const saleId = String((await saleOf(id)).id);
    await command(buyer, { command: 'pay_item_sale', idempotency_key: key('pay'), sale_id: saleId, buyer_details: '0x2222' });
    expect((await command(buyer, { command: 'claim_item_refund', idempotency_key: key('rf'), sale_id: saleId })).body.error).toMatch(/^The seller has until /);

    // No bids were placed, so the deadlines can still move.
    await sql`update app.item_listings set starts_at=now() - interval '3 hours',ends_at=now() - interval '2 hours',delivery_due_at=now() - interval '1 minute' where id=${id}`;
    expect((await command(seller, { command: 'mark_item_delivered', idempotency_key: key('dl'), sale_id: saleId, delivery_proof: 'Too late to deliver' })).body.error).toBe('The delivery deadline has passed');
    expect((await command(buyer, { command: 'claim_item_refund', idempotency_key: key('rf'), sale_id: saleId })).body.message).toBe("Refunded $250.00 plus the seller's $100.00 collateral (sandbox).");
    expect(await saleOf(id)).toMatchObject({ status: 'SELLER_DEFAULTED' });
    expect(await balance(`sandbox_wallet:${buyer.id}`)).toBe(10000);
    expect(await balance(`sandbox_wallet:${seller.id}`)).toBe(-10000);
    expect(await balance(`item_escrow:${saleId}`)).toBe(0);
    expect(await balance(`item_collateral:${id}`)).toBe(0);
  });

  it('the clocks: unpaid wins expire, silence confirms, missed delivery refunds, empty auctions return the collateral', async () => {
    const seller = await createUser('item-clock-seller', ['creator']);
    const buyer = await createUser('item-clock-buyer', ['buyer']);

    const unpaid = await openListing(seller, { buy_now_price: '150' });
    await command(buyer, { command: 'buy_item_now', idempotency_key: key('bn'), listing_id: unpaid });
    const unpaidSale = String((await saleOf(unpaid)).id);
    await sql`update app.item_sales set payment_due_at=now() - interval '1 minute' where id=${unpaidSale}`;
    expect((await command(buyer, { command: 'pay_item_sale', idempotency_key: key('pay'), sale_id: unpaidSale, buyer_details: '0x3333' })).body.error).toBe('The payment window has closed');

    const silent = await openListing(seller, { buy_now_price: '150' });
    await command(buyer, { command: 'buy_item_now', idempotency_key: key('bn'), listing_id: silent });
    const silentSale = String((await saleOf(silent)).id);
    await command(buyer, { command: 'pay_item_sale', idempotency_key: key('pay'), sale_id: silentSale, buyer_details: '0x4444' });
    await command(seller, { command: 'mark_item_delivered', idempotency_key: key('dl'), sale_id: silentSale, delivery_proof: 'Allowlist entry added' });
    await sql`update app.item_sales set confirm_by=now() - interval '1 minute' where id=${silentSale}`;

    const missed = await openListing(seller, { buy_now_price: '150' });
    await command(buyer, { command: 'buy_item_now', idempotency_key: key('bn'), listing_id: missed });
    const missedSale = String((await saleOf(missed)).id);
    await command(buyer, { command: 'pay_item_sale', idempotency_key: key('pay'), sale_id: missedSale, buyer_details: '0x5555' });
    await sql`update app.item_listings set starts_at=now() - interval '3 hours',ends_at=now() - interval '2 hours',delivery_due_at=now() - interval '1 minute' where id=${missed}`;

    expect((await jobs.settleItemSales({ saleId: unpaidSale })).outcomes).toEqual({ PAYMENT_EXPIRED: 1 });
    expect((await jobs.settleItemSales({ saleId: silentSale })).outcomes).toEqual({ COMPLETED_BY_TIMEOUT: 1 });
    expect((await jobs.settleItemSales({ saleId: missedSale })).outcomes).toEqual({ SELLER_DEFAULTED: 1 });
    expect(await balance(`item_collateral:${unpaid}`)).toBe(0);
    expect((await listingOf(unpaid)).collateral_released_at).not.toBeNull();

    const empty = await openListing(seller);
    await sql`update app.item_listings set starts_at=now() - interval '3 hours',ends_at=now() - interval '1 minute' where id=${empty}`;
    const never = String((await command(seller, listingFields())).body.id);
    await sql`update app.item_listings set starts_at=now() - interval '3 hours',ends_at=now() - interval '1 minute' where id=${never}`;
    expect((await jobs.closeDueItemListings({ listingId: empty })).outcomes).toEqual({ NO_BIDS: 1 });
    expect((await jobs.closeDueItemListings({ listingId: never })).outcomes).toEqual({ CANCELLED_NO_COLLATERAL: 1 });
    expect(await balance(`item_collateral:${empty}`)).toBe(0);
    // Every collateral this seller locked came back: three returned after the sales above plus the empty auction.
    const [{ held }] = await sql`select coalesce(sum(e.amount_minor),0)::bigint as held from app.ledger_entries e
      where e.account in (${`item_collateral:${unpaid}`},${`item_collateral:${silent}`},${`item_collateral:${missed}`},${`item_collateral:${empty}`})`;
    expect(Number(held)).toBe(0);
  });

  it('a dispute holds the money until finance decides, with a written reason', async () => {
    const seller = await createUser('item-dispute-seller', ['creator']);
    const buyer = await createUser('item-dispute-buyer', ['buyer']);
    const support = await operator('support');
    const finance = await operator('finance');
    const id = await openListing(seller, { buy_now_price: '500', collateral: '100' });
    await command(buyer, { command: 'buy_item_now', idempotency_key: key('bn'), listing_id: id });
    const saleId = String((await saleOf(id)).id);
    await command(buyer, { command: 'pay_item_sale', idempotency_key: key('pay'), sale_id: saleId, buyer_details: '0x6666' });
    await command(seller, { command: 'mark_item_delivered', idempotency_key: key('dl'), sale_id: saleId, delivery_proof: 'Screenshot of the allowlist' });
    expect((await command(buyer, { command: 'dispute_item_sale', idempotency_key: key('dp'), sale_id: saleId, dispute_reason: '  ' })).body.error).toBe('Add what went wrong');
    expect((await command(buyer, { command: 'dispute_item_sale', idempotency_key: key('dp'), sale_id: saleId, dispute_reason: 'My wallet is not on the allowlist checker.' })).body.message).toMatch(/^Dispute opened/);
    expect((await queries.getItemDisputes()).find((dispute) => dispute.id === saleId)).toMatchObject({ disputeReason: 'My wallet is not on the allowlist checker.', buyerDetails: '0x6666' });

    const resolve = (actor: TestUser, outcome: string, reason = 'Checked the allowlist export from the project.') => command(actor, { command: 'admin_resolve_item_dispute', idempotency_key: key('rs'), sale_id: saleId, outcome, reason });
    expect((await resolve(support, 'REFUND')).status).toBe(403);
    expect((await resolve(finance, 'REFUND', 'short')).body.error).toBe('Give a reason of at least 10 characters for the audit log');
    expect((await resolve(finance, 'REFUND')).body.message).toBe('Dispute resolved');
    expect(await saleOf(id)).toMatchObject({ status: 'REFUNDED', resolution: 'REFUNDED', resolved_by: finance.id });
    // Refund without fault: the buyer is whole, the seller keeps the collateral.
    expect(await balance(`sandbox_wallet:${buyer.id}`)).toBe(0);
    expect(await balance(`sandbox_wallet:${seller.id}`)).toBe(0);
    expect((await sql`select 1 from app.audit_log where action='resolve_item_dispute' and entity_id=${saleId}`).length).toBe(1);
    expect((await resolve(finance, 'RELEASE_TO_SELLER')).status).toBe(409);
  });

  it('a new account must finish setup before listing, and a listing without bids can be cancelled', async () => {
    const fresh = await createUser('item-fresh', ['creator']);
    await sql`update app.users set onboarded_at=null where id=${fresh.id}`;
    expect((await command(fresh, listingFields())).status).toBe(422);

    const seller = await createUser('item-cancel-seller', ['creator']);
    const id = await openListing(seller, { collateral: '40' });
    expect((await command(seller, { command: 'cancel_item_listing', idempotency_key: key('cx'), listing_id: id, reason: 'Project postponed the mint' })).body.message)
      .toBe('Listing cancelled. The collateral is back with you.');
    expect(await listingOf(id)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Project postponed the mint' });
    expect(await balance(`sandbox_wallet:${seller.id}`)).toBe(0);
  });
});
