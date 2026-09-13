import Link from 'next/link';

import { getPublicData } from '@/lib/read-model';
import { Empty, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { RequestCard } from '@/components/request-card';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function RequestsPage({
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
      <div className="section-heading">
        <PageHeading
          eyebrow="Open briefs"
          title="Bring your next project to life."
          description="Share what you need. Creators bring their approach, samples, and quote."
        />
        <Link className="button button-dark" href="/buyer/requests/new">Post a brief ↗</Link>
      </div>
      <div className="cards">
        {rows(data.requests).length ? (
          rows(data.requests).map(r => <RequestCard key={str(r.id)} item={r} />)
        ) : (
          <Empty title="No open briefs yet">
            Be the first to share a project with the creator community.
          </Empty>
        )}
      </div>
    </>
  </main>;
}
