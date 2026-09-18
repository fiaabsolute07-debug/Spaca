import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { NewBriefForm } from '@/components/campaign/new-brief-form';
import { goalBySlug } from '@/modules/requests/goals';
import { isFlagEnabled } from '@/modules/admin/policy';
import { sql } from '@/lib/db';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

/** The whole page, for a pasted link, a new tab or a reload. From inside the app the same route opens as a dialog. */
export default async function NewRequestPage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/buyer/requests/new";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query, 'buyer');
  if (!actor) return prompt;
  const performanceEnabled = await isFlagEnabled(sql, 'PERFORMANCE_CAMPAIGNS_ENABLED');
  const goal = goalBySlug(query.goal);
  return <main className="container">
    <Notices query={query} />
    <PageHeading
      eyebrow="Post a brief"
      title="Share the project behind the ask."
      description="Give creators enough context to respond with a useful approach and quote."
    />
    <div className="panel">
      <NewBriefForm performanceEnabled={performanceEnabled} goal={goal?.value ?? null} />
    </div>
  </main>;
}
