import Link from 'next/link';
import { getDashboardData } from '@/lib/read-model';
import { Empty, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { RequestCard } from '@/components/request-card';
import type { Query } from '@/components/page-props';
import type { Actor } from '@/lib/auth';

export async function WorkspaceRequests({
  actor,
  query
}: {
  actor: Actor;
  query: Query;
}) {
  const notices = <Notices query={query} />;
  const d = row(await getDashboardData(actor));
  return <main className="container">
    {notices}
    <div className="section-heading">
      <PageHeading
        eyebrow="Briefs"
        title="Open requests"
        description="Requests and applications stay scoped to the people involved."
      />
      <Link className="button button-dark" href="/buyer/requests/new">Post a brief</Link>
    </div>
    {rows(d.requests).length ? <div className="cards">
      {rows(d.requests).map(r => <RequestCard key={str(r.id)} item={r} />)}
    </div> : <Empty title="No requests yet">
      <Link href="/buyer/requests/new" className="text-link">Share a project brief ›</Link>
    </Empty>}
  </main>;
}
