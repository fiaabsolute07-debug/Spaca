import Link from 'next/link';
import { getActor } from '@/lib/auth';
import { getMyBids, getPublicData } from '@/lib/read-model';
import { Badge, Empty, date, money, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { AuctionCard } from '@/components/auction-card';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function AuctionsPage({
  searchParams
}: PageProps) {
  const query = await searchParams;

  const notices = <Notices query={query} />;
  const actor = await getActor();
  const myBids = actor ? await getMyBids(actor) : [];
  const data = await getPublicData({
    q: typeof query.q === 'string' ? query.q : undefined,
    category: typeof query.category === 'string' ? query.category : undefined
  });

  return <main className="container">
    {notices}
    <>
      <PageHeading
        eyebrow="Limited availability"
        title="A great slot. Your best offer."
        description="Bid on creator availability. All deadlines are shown in UTC; accepted bids are confirmed by the server."
      />
      {myBids.length > 0 && <div className="panel">
        <h2>My bids</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Auction</th><th>Standing</th><th>Your best</th><th>Current</th><th>Ends</th></tr></thead>
            <tbody>
              {myBids.map((b) => <tr key={str(b.id)}>
                <td><Link className="text-link" href={b.order_id && b.standing === 'WON_PAY' ? `/orders/${str(b.order_id)}` : `/auctions/${str(b.id)}`}>{str(b.title)}</Link></td>
                <td><Badge>{str(b.standing).replaceAll('_', ' ')}</Badge></td>
                <td>{money(b.my_highest_minor)}</td>
                <td>{money(b.current_price_minor)}</td>
                <td>{date(b.ends_at)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </div>}
      <div className="service-grid">
        {rows(data.auctions).length ? (
          rows(data.auctions).map(a => <AuctionCard key={str(a.id)} item={a} />)
        ) : (
          <Empty title="No auctions open right now">
            Explore services you can book directly while new auctions are prepared.
          </Empty>
        )}
      </div>
    </>
  </main>;
}
