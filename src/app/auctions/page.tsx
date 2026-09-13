import { getPublicData } from '@/lib/read-model';
import { Empty, rows, str } from '@/components/ui';
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
