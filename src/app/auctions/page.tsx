import Link from 'next/link';
import { getActor } from '@/lib/auth';
import { ORIGIN_LABEL, SALE_STATUS_LABEL, usd } from '@/lib/items';
import { sql } from '@/lib/db';
import { auctionMoneyNote } from '@/lib/environment';
import { getItemAuctionBoard, getMyItemActivity } from '@/modules/items/queries';
import { ItemCard } from '@/components/items/item-card';
import { ItemHero } from '@/components/items/item-hero';
import { Empty, date } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

/** What the item sold for, or the bid to beat while it is open. */
const priceOf = (row: { salePrice: number | null; currentBid: number | null }) => (row.salePrice != null ? usd(row.salePrice) : row.currentBid != null ? usd(row.currentBid) : '—');

const LISTING_STATUS: Record<string, string> = { AWAITING_COLLATERAL: 'Lock collateral to open', OPEN: 'Open', SOLD: 'Sold', NO_BIDS: 'Ended without bids', CANCELLED: 'Cancelled' };

/**
 * Web3 item auctions (drizzle/0033): whitelist spots, guaranteed mints, pre-market tokens and whatever else sellers
 * describe. Live listings first, then upcoming ones, then recent sale prices. Filters are plain links.
 */
export default async function AuctionsPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const pick = (name: string) => (typeof query[name] === 'string' ? query[name] as string : '');
  const actor = await getActor();
  const [board, mine, [{ now }]] = await Promise.all([
    getItemAuctionBoard({ type: pick('type'), origin: pick('origin') }),
    actor ? getMyItemActivity(actor) : Promise.resolve(null),
    sql<{ now: Date }[]>`select now() as now`,
  ]);
  const serverNow = new Date(String(now)).toISOString();
  const href = (change: Record<string, string>) => {
    const params = new URLSearchParams({ ...(board.filters.type ? { type: board.filters.type } : {}), ...(board.filters.origin ? { origin: board.filters.origin } : {}), ...change });
    for (const [name, value] of [...params.entries()]) if (!value) params.delete(name);
    const search = params.toString();
    return search ? `/auctions?${search}` : '/auctions';
  };
  const filtered = Boolean(board.filters.type || board.filters.origin);
  // The board is ordered by the time a listing ends, so the first live one is the auction closing soonest. With
  // nothing live it is the one opening next, and with nothing at all there is no banner to draw.
  const featured = board.live[0] ?? board.upcoming[0] ?? null;

  return <main className="container items-page">
    <Notices query={query} />
    <div className="items-head">
      <PageHeading eyebrow="Auctions · Beta" title="Web3 items, bid in the open."
        description="Whitelist spots, guaranteed mints, pre-market tokens and more. The seller locks collateral first, and your payment waits in escrow until you confirm delivery." />
      <Link className="button button-dark" href={actor ? '/auctions/new' : '/sign-in?return_to=%2Fauctions%2Fnew'}>List an item</Link>
    </div>

    {auctionMoneyNote() && <p className="items-sandbox">{auctionMoneyNote()}</p>}

    {featured && <ItemHero listing={featured} serverNow={serverNow} />}

    {/* Both ways of narrowing the board read as one control, rather than two rows pushed to opposite edges. */}
    <div className="items-filters">
      <nav aria-label="Item types" className="chip-row">
        <Link className="chip-link" href={href({ type: '' })} aria-current={!board.filters.type ? 'page' : undefined}>All items</Link>
        {board.types.map((entry) => <Link key={entry.type} className="chip-link" href={href({ type: entry.type })}
          aria-current={board.filters.type.toLowerCase() === entry.type.toLowerCase() ? 'page' : undefined}>{entry.type} <span className="muted">{entry.count}</span></Link>)}
      </nav>
      <nav aria-label="Sellers" className="chip-row">
        <Link className="chip-link" href={href({ origin: '' })} aria-current={!board.filters.origin ? 'page' : undefined}>All sellers</Link>
        {(['PROJECT', 'RESALE'] as const).map((origin) => <Link key={origin} className="chip-link" href={href({ origin })}
          aria-current={board.filters.origin === origin ? 'page' : undefined}>{ORIGIN_LABEL[origin]}</Link>)}
      </nav>
    </div>

    {mine && (mine.listings.length > 0 || mine.bids.length > 0) && <section className="panel items-mine" aria-labelledby="items-mine-heading">
      <h2 id="items-mine-heading">Your auctions</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Item</th><th>You</th><th>Status</th><th>Price</th><th>Ends</th></tr></thead>
          <tbody>
            {mine.listings.map((listing) => <tr key={`l-${listing.id}`}>
              <td><Link className="text-link" href={`/auctions/${listing.id}`}>{listing.title}</Link></td>
              <td>Selling</td>
              <td>{listing.saleStatus ? SALE_STATUS_LABEL[listing.saleStatus] : LISTING_STATUS[listing.status]}</td>
              <td className="mono">{priceOf(listing)}</td>
              <td>{listing.status === 'OPEN' || listing.status === 'AWAITING_COLLATERAL' ? date(listing.endsAt) : 'Closed'}</td>
            </tr>)}
            {mine.bids.map((entry) => <tr key={`b-${entry.id}`}>
              <td><Link className="text-link" href={`/auctions/${entry.id}`}>{entry.title}</Link></td>
              <td>{entry.won ? 'Won' : entry.status === 'OPEN' ? (entry.leading ? 'Highest bid' : 'Outbid') : 'Bid'}</td>
              <td>{entry.won && entry.saleStatus ? SALE_STATUS_LABEL[entry.saleStatus] : LISTING_STATUS[entry.status]}</td>
              <td className="mono">{priceOf(entry)}</td>
              <td>{entry.status === 'OPEN' ? date(entry.endsAt) : 'Closed'}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>}

    {/* With nothing live but something opening soon, the upcoming list speaks for itself. */}
    {(board.live.length > 0 || board.upcoming.length === 0) && <section className="items-section" aria-labelledby="items-live-heading">
      <h2 id="items-live-heading">Live now</h2>
      {board.live.length
        ? <div className={`items-grid${board.live.length <= 2 ? ' is-few' : ''}`}>
          {board.live.map((listing) => <ItemCard key={listing.id} listing={listing} serverNow={serverNow} wide={board.live.length <= 2} />)}
        </div>
        : <Empty title={filtered ? 'Nothing matches these filters' : 'No items are up for auction yet'}>
          {filtered ? <Link className="text-link" href="/auctions">Show all items ›</Link> : <Link className="text-link" href="/auctions/new">List the first item ›</Link>}
        </Empty>}
    </section>}

    {board.upcoming.length > 0 && <section className="items-section" aria-labelledby="items-upcoming-heading">
      <h2 id="items-upcoming-heading">Starting soon</h2>
      <div className={`items-grid${board.upcoming.length <= 2 ? ' is-few' : ''}`}>
        {board.upcoming.map((listing) => <ItemCard key={listing.id} listing={listing} serverNow={serverNow} wide={board.upcoming.length <= 2} />)}
      </div>
    </section>}

    {board.recent.length > 0 && <section className="items-section" aria-labelledby="items-recent-heading">
      <h2 id="items-recent-heading">Recently sold</h2>
      <div className="table-wrap">
        <table className="items-recent">
          <thead><tr><th>Item</th><th>Type</th><th>Project</th><th>Price</th><th>Sold</th></tr></thead>
          <tbody>
            {board.recent.map((sale) => <tr key={sale.id}>
              <td><Link className="text-link" href={`/auctions/${sale.id}`}>{sale.title}</Link></td>
              <td>{sale.itemType}</td>
              <td>{sale.projectName}</td>
              <td className="mono">{usd(sale.price)}{sale.kind === 'BUY_NOW' ? <span className="muted"> · Buy now</span> : null}</td>
              <td>{date(sale.soldAt)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>}

    <section className="items-section" aria-labelledby="items-how-heading">
      <h2 id="items-how-heading">How an item auction works</h2>
      <ol className="items-steps" aria-labelledby="items-how-heading">
        <li><strong>Seller locks collateral</strong><span>The listing opens only after it is locked.</span></li>
        <li><strong>Win and pay into escrow</strong><span>You have 24 hours; the seller cannot touch it yet.</span></li>
        <li><strong>Confirm delivery</strong><span>The seller is paid. Miss the deadline and you get your money plus the collateral.</span></li>
      </ol>
    </section>
  </main>;
}
