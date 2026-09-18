import Link from 'next/link';
import { getActor } from '@/lib/auth';
import { isBuyer } from '@/lib/account';
import { FormDialog } from '@/components/form-dialog';
import { NewBriefForm } from '@/components/campaign/new-brief-form';
import { goalBySlug } from '@/modules/requests/goals';
import { isFlagEnabled } from '@/modules/admin/policy';
import { sql } from '@/lib/db';
import type { PageProps } from '@/components/page-props';

/**
 * "Post a brief" opened from the campaign board, a goal tab or the header menu: the same form in a dialog over that
 * page, so nobody loses the campaigns they were reading. Opening /buyer/requests/new directly still shows the page.
 */
export default async function NewBriefDialog({ searchParams }: PageProps) {
  const query = await searchParams;
  const actor = await getActor();
  if (!actor || !isBuyer(actor)) {
    return <FormDialog title="Post a brief" fallback="/requests">
      <p className="muted">{actor ? 'Campaigns are posted from a project account. This account is a creator account.' : 'Log in with a project account to post a brief.'}</p>
      <Link className="button button-dark" href={actor ? '/dashboard' : '/sign-in'}>{actor ? 'Back to your workspace' : 'Log in'}</Link>
    </FormDialog>;
  }
  const performanceEnabled = await isFlagEnabled(sql, 'PERFORMANCE_CAMPAIGNS_ENABLED');
  return <FormDialog title="Post a brief" description="Share the project behind the ask, in three short steps." fallback="/requests">
    <NewBriefForm performanceEnabled={performanceEnabled} goal={goalBySlug(query.goal)?.value ?? null} />
  </FormDialog>;
}
