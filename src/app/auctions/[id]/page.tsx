import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { getAuctionData } from '@/lib/read-model';
import { CommandForm, Empty, Field, date, money, num, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function AuctionPage({
  params,
  searchParams
}: PageProps<{
  id: string;
}>) {
  const query = await searchParams;
  const {
    id
  } = await params;
  const route = `/auctions/${id}`;
  const actor = await getActor();
  const notices = <Notices query={query} />;
  const result = await getAuctionData(actor, id);
  if (!result) notFound();
  const d = row(result),
    a = row(d.auction),
    minimum = num(a.current_price_minor)
      ? num(a.current_price_minor) + num(a.minimum_increment_minor)
      : num(a.starting_price_minor);
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow={`Auction · ${str(a.status)}`}
      title={str(a.title)}
      description={`By ${str(a.creator_name)} · Server deadline: ${date(a.ends_at)}`}
    />
    <div className="split">
      <div>
        <div className="panel">
          <h2>Current standing</h2>
          <div className="price-big">
            {money(a.current_price_minor || a.starting_price_minor)}
          </div>
          <p>
            {num(a.bid_count)}
            {" accepted bids · Minimum next bid "}
            {money(minimum)}
          </p>
          <Link className="text-link" href={`/services/${str(a.service_id)}`}>Read the full service scope and samples ↗</Link>
          <p className="muted">
            Refresh to see the latest server-confirmed bids. A submitted form is not an
            accepted bid until the server confirms it. Buy Now is available only before the
            first valid bid.
          </p>
        </div>
        <div className="panel">
          <h2>Bid history</h2>
          {rows(d.bids).length ? rows(d.bids).map((b, i) => <div className="record" key={i}>
            <strong>
              {money(b.amount_minor)}
            </strong>
            <p>
              {str(b.display_name, 'Bidder')}
              {" · "}
              {date(b.created_at)}
            </p>
          </div>) : <Empty title="Be the first to bid" />}
        </div>
      </div>
      <aside className="panel">
        <h2>Make your offer</h2>
        {actor && str(a.status) === 'LIVE' ? <>
          <CommandForm
            command="bid"
            label="Place binding bid"
            values={{
              auction_id: str(a.id)
            }}
            returnTo={route}
          >
            <Field
              name="amount"
              label="Bid amount (USD)"
              type="number"
              value={(minimum / 100).toFixed(2)}
              required
            />
          </CommandForm>
          {num(a.bid_count) === 0 && num(a.buy_now_price_minor) > 0 && <CommandForm
            command="buy_now"
            label={`Buy now · ${money(a.buy_now_price_minor)}`}
            values={{
              auction_id: str(a.id)
            }}
          />}
        </> : !actor ? (
          <Link className="button button-dark" href="/sign-in">Log in to bid ↗</Link>
        ) : (
          <p>This auction is not accepting bids.</p>
        )}
        {actor?.id === str(a.seller_id) && <CommandForm
          command="close_auction"
          label="Close after deadline"
          values={{
            auction_id: str(a.id)
          }}
          returnTo={route}
        />}
        <div className="fee-note">
          Local sandbox only. Winning bids create an order requiring simulated checkout.
          No real funds are involved.
        </div>
      </aside>
    </div>
  </main>;
}
