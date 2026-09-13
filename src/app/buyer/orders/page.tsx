import { getDashboardData } from '@/lib/read-model';
import { OrderList, row } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function BuyerOrdersPage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/buyer/orders";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const d = row(await getDashboardData(actor));
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Buyer workspace"
      title="Orders"
      description="Fund, review, and keep every project decision in one private workspace."
    />
    <OrderList orders={d.orders} />
  </main>;
}
