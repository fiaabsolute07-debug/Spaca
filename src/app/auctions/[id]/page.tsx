import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { getAuctionData } from '@/lib/read-model';
import { AuctionLivePanel } from '@/components/auctions/auction-live-panel';
import { CommandForm, Empty, Field, date, money, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function AuctionPage({ params, searchParams }: PageProps<{ id: string }>) {
  const query = await searchParams;
  const { id } = await params;
  const route = `/auctions/${id}`;
  const actor = await getActor();
  const result = await getAuctionData(actor, id);
  if (!result) notFound();
  const a = row(result.auction);
  const seller = actor?.id === str(a.seller_id);
  const nextMinimum = Number(a.next_minimum_minor) / 100;
  return <main className="container">
    <Notices query={query} />
    <Link href="/auctions" className="breadcrumbs">← All auctions</Link>
    <PageHeading eyebrow={`Auction · ${str(a.status).replaceAll('_', ' ')}`} title={str(a.title)} description={`By ${str(a.creator_name)} · Server deadline: ${date(a.ends_at)}`} />
    <div className="split">
      <div>
        {/* The snapshot shape is the read model's; the client panel only re-fetches it. */}
        <AuctionLivePanel auctionId={id} initial={JSON.parse(JSON.stringify(result))} />
        <div className="panel">
          <h2>Terms</h2>
          <ul className="facts">
            <li><span>Starting price</span><strong>{money(a.starting_price_minor)}</strong></li>
            <li><span>Minimum increment</span><strong>{money(a.minimum_increment_minor)}</strong></li>
            {a.buy_now_price_minor != null && <li><span>Buy Now (only before the first bid)</span><strong>{money(a.buy_now_price_minor)}</strong></li>}
            <li><span>Opens</span><strong>{date(a.starts_at)}</strong></li>
            <li><span>Winner has to fund within</span><strong>24 hours</strong></li>
          </ul>
          <Link className="text-link" href={`/services/${str(a.service_id)}`}>Read the full service scope and samples ↗</Link>
        </div>
        <div className="panel">
          <h2>Bid history</h2>
          {rows(result.bids).length ? rows(result.bids).map((b) => <div className="record" key={str(b.sequence)}>
            <strong>{money(b.amount_minor)}</strong>
            <p>{str(b.display_name, 'Bidder')} · {date(b.created_at)}</p>
          </div>) : <Empty title="No accepted bids yet" />}
        </div>
      </div>
      <aside className="panel">
        <h2>{seller ? 'Your auction' : 'Make your offer'}</h2>
        {!actor ? <Link className="button button-dark" href="/sign-in">Log in to bid ↗</Link> : seller ? <>
          {['SCHEDULED', 'LIVE'].includes(str(a.status)) && !a.first_valid_bid_at && <CommandForm command="cancel_auction" label="Cancel before any bid" values={{ auction_id: str(a.id) }} returnTo={route}>
            <Field name="reason" label="Reason (optional)" />
          </CommandForm>}
          {['SCHEDULED', 'LIVE'].includes(str(a.status)) && <CommandForm command="close_auction" label="Close after deadline" values={{ auction_id: str(a.id) }} returnTo={route} />}
          <p className="muted">Auctions close automatically at the server deadline. Terms are frozen after the first valid bid.</p>
        </> : a.accepting_bids ? <>
          <CommandForm command="bid" label="Place binding bid" values={{ auction_id: str(a.id) }} returnTo={route}>
            <Field name="amount" label={`Bid amount (USD, at least ${money(a.next_minimum_minor)})`} type="number" value={nextMinimum.toFixed(2)} required />
          </CommandForm>
          {Boolean(a.buy_now_available) && <CommandForm command="buy_now" label={`Buy now · ${money(a.buy_now_price_minor)}`} values={{ auction_id: str(a.id) }} returnTo={route} />}
        </> : <p>This auction is not accepting bids.</p>}
        <div className="fee-note">
          Local test provider only. A submitted bid counts only after the server accepts it. Winning creates an order that must be funded within 24 hours. Platform fee $0.00.
        </div>
      </aside>
    </div>
  </main>;
}
