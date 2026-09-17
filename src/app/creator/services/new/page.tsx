import { getPostingAccounts } from '@/lib/read-model';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { NewServiceForm } from '@/components/services/new-service-form';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function NewServicePage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/creator/services/new";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query, 'creator');
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const accounts = await getPostingAccounts(actor.id);
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Creator setup"
      title="Offer a clear next step."
      description="A service needs a real scope, price, and samples before it can be published."
    />
    <div className="panel">
      <NewServiceForm accounts={accounts} />
    </div>
  </main>;
}
