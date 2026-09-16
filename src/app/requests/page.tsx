import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getPublicData } from '@/lib/read-model';
import { getActor } from '@/lib/auth';
import { isBuyer } from '@/lib/account';
import { Empty, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { CampaignBoard } from '@/components/campaign/campaign-board';
import { GoalTabs } from '@/components/campaign/goal-tabs';
import type { PageProps } from '@/components/page-props';
import { goalBySlug } from '@/modules/requests/goals';

export const dynamic = 'force-dynamic';

export default async function RequestsPage({
  searchParams
}: PageProps) {
  const query = await searchParams;

  const notices = <Notices query={query} />;
  const actor = await getActor();
  // Each goal has its own tab page now; older links with ?goal= land there.
  const goal = goalBySlug(query.goal);
  if (goal) redirect(`/campaigns/${goal.slug}`);
  const data = await getPublicData({
    q: typeof query.q === 'string' ? query.q : undefined,
    category: typeof query.category === 'string' ? query.category : undefined,
  });
  const postHref = '/buyer/requests/new';

  return <main className="container">
    {notices}
    <>
      <div className="section-heading">
        <PageHeading
          eyebrow="All campaigns"
          title="Bring your next project to life."
          description="Every open brief in one list. Each tab above shows one kind of campaign."
        />
        {actor && !isBuyer(actor) ? <Link className="button button-dark" href="/creator/requests">My applications</Link>
          : <Link className="button button-dark" href={postHref}>Post a brief</Link>}
      </div>
      <GoalTabs current={null} counts={data.goal_counts} />
      {rows(data.requests).length ? (
        <CampaignBoard items={data.requests} label="All open campaigns" />
      ) : (
        <Empty title="No open briefs yet">
          Be the first to share a project with the creator community.
        </Empty>
      )}
    </>
  </main>;
}
