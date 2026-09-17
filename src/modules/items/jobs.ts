/**
 * Item auction clocks (drizzle/0033), run by the job runner. Each step re-reads the row under a lock, so running late,
 * twice or concurrently changes nothing: auctions that reached their end close (highest bid wins, or no bids), listings
 * whose collateral never arrived are cancelled, unpaid wins expire and return the collateral, silence after delivery
 * confirms it, and a missed delivery deadline refunds the buyer with the collateral.
 */
import type { Row } from '@/lib/commands';
import { sql } from '@/lib/db';
import { completeSale, createSale, defaultSeller, releaseCollateral } from './commands';

type Outcomes = { examined: number; outcomes: Record<string, number> };

function tally() {
  const result: Outcomes = { examined: 0, outcomes: {} };
  return { result, add: (outcome: string) => { result.examined += 1; result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1; } };
}

export async function closeDueItemListings(options: { limit?: number; listingId?: string } = {}): Promise<Outcomes> {
  const { result, add } = tally();
  const scope = options.listingId ? sql`and id=${options.listingId}` : sql``;
  const due = await sql<Row[]>`select id from app.item_listings where status in ('OPEN','AWAITING_COLLATERAL') and ends_at <= now() ${scope}
    order by ends_at limit ${options.limit ?? 50}`;
  for (const { id } of due) {
    add(await sql.begin(async (tx) => {
      const [listing] = await tx<Row[]>`select * from app.item_listings where id=${String(id)} and ends_at <= now() for update`;
      if (!listing) return 'SKIPPED';
      if (listing.status === 'AWAITING_COLLATERAL') {
        await tx`update app.item_listings set status='CANCELLED',cancel_reason='The collateral was not locked before the auction ended',closed_at=now(),version=version+1,updated_at=now()
          where id=${String(listing.id)}`;
        return 'CANCELLED_NO_COLLATERAL';
      }
      if (listing.status !== 'OPEN') return 'SKIPPED';
      if (!listing.current_bid_id) {
        await tx`update app.item_listings set status='NO_BIDS',closed_at=now(),version=version+1,updated_at=now() where id=${String(listing.id)}`;
        await releaseCollateral(tx, listing, listing.seller_id);
        return 'NO_BIDS';
      }
      const [bid] = await tx<Row[]>`select id,bidder_id,amount_minor from app.item_bids where id=${String(listing.current_bid_id)}`;
      await createSale(tx, listing, String(bid!.bidder_id), 'WINNER', BigInt(String(bid!.amount_minor)), String(bid!.id));
      return 'SOLD';
    }));
  }
  return result;
}

export async function settleItemSales(options: { limit?: number; saleId?: string } = {}): Promise<Outcomes> {
  const { result, add } = tally();
  const scope = options.saleId ? sql`and s.id=${options.saleId}` : sql``;
  const due = await sql<Row[]>`select s.id from app.item_sales s join app.item_listings l on l.id=s.listing_id
    where ((s.status='AWAITING_PAYMENT' and s.payment_due_at < now())
      or (s.status='DELIVERED' and s.confirm_by < now())
      or (s.status='AWAITING_DELIVERY' and l.delivery_due_at < now())) ${scope}
    order by s.created_at limit ${options.limit ?? 50}`;
  for (const { id } of due) {
    add(await sql.begin(async (tx) => {
      const [ref] = await tx<Row[]>`select listing_id from app.item_sales where id=${String(id)}`;
      const [listing] = await tx<Row[]>`select * from app.item_listings where id=${String(ref!.listing_id)} for update`;
      const [sale] = await tx<Row[]>`select * from app.item_sales where id=${String(id)} for update`;
      const now = new Date(String((await tx<Row[]>`select now() as now`)[0]!.now));
      if (sale!.status === 'AWAITING_PAYMENT' && new Date(String(sale!.payment_due_at)) < now) {
        await tx`update app.item_sales set status='PAYMENT_EXPIRED',version=version+1,updated_at=now() where id=${String(id)}`;
        await releaseCollateral(tx, listing!, listing!.seller_id);
        return 'PAYMENT_EXPIRED';
      }
      if (sale!.status === 'DELIVERED' && new Date(String(sale!.confirm_by)) < now) {
        await completeSale(tx, sale!, listing!);
        return 'COMPLETED_BY_TIMEOUT';
      }
      if (sale!.status === 'AWAITING_DELIVERY' && new Date(String(listing!.delivery_due_at)) < now) {
        await defaultSeller(tx, sale!, listing!);
        return 'SELLER_DEFAULTED';
      }
      return 'SKIPPED';
    }));
  }
  return result;
}
