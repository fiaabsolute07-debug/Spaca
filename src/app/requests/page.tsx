import Link from 'next/link';

import { getPublicData } from '@/lib/read-model';
import { getActor } from '@/lib/auth';
import { isBuyer } from '@/lib/account';
import { Empty, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { RequestCard } from '@/components/request-card';
import { GoalIcon } from '@/components/campaign/goal-icon';
import type { PageProps } from '@/components/page-props';
import { CAMPAIGN_GOALS, goalBySlug } from '@/modules/requests/goals';

export const dynamic = 'force-dynamic';

export default async function RequestsPage({
  searchParams
}: PageProps) {
  const query = await searchParams;

  const notices = <Notices query={query} />;
  const actor = await getActor();
  const goal = goalBySlug(query.goal);
  const data = await getPublicData({
    q: typeof query.q === 'string' ? query.q : undefined,
    category: typeof query.category === 'string' ? query.category : undefined,
    goal: goal?.value ?? null,
  });
  const counts = data.goal_counts;
  const postHref = goal ? `/buyer/requests/new?goal=${goal.slug}` : '/buyer/requests/new';

  return <main className="container">
    {notices}
    <>
      <div className="section-heading">
        <PageHeading
          eyebrow={goal ? 'Campaigns' : 'Open briefs'}
          title={goal ? `${goal.title} campaigns` : 'Bring your next project to life.'}
          description={goal ? goal.need : 'Share what you need. Creators bring their approach, samples, and quote.'}
        />
        {actor && !isBuyer(actor) ? <Link className="button button-dark" href="/creator/requests">My applications</Link>
          : <Link className="button button-dark" href={postHref}>Post a brief</Link>}
      </div>
      <nav className="goal-filter" aria-label="Campaign goals">
        <Link href="/requests" scroll={false} className="goal-chip" aria-current={goal ? undefined : 'page'}>
          All campaigns <span className="goal-count">{data.request_total}</span>
        </Link>
        {CAMPAIGN_GOALS.map((item) => <Link key={item.value} href={`/requests?goal=${item.slug}`} scroll={false} className="goal-chip" aria-current={goal?.value === item.value ? 'page' : undefined}>
          <GoalIcon goal={item.value} size={15} /> {item.title} <span className="goal-count">{counts[item.value] ?? 0}</span>
        </Link>)}
      </nav>
      <div className="cards">
        {rows(data.requests).length ? (
          rows(data.requests).map(r => <RequestCard key={str(r.id)} item={r} />)
        ) : (
          goal ? <Empty title={`No open ${goal.title.toLowerCase()} campaigns`}>
            Nothing is taking applications for this goal right now. <Link className="text-link" href="/requests">See all campaigns</Link>.
          </Empty> : <Empty title="No open briefs yet">
            Be the first to share a project with the creator community.
          </Empty>
        )}
      </div>
    </>
  </main>;
}
