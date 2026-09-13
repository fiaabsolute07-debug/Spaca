import { getOperatorQueues } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { Badge, date, str } from '@/components/ui';
import { AdminPage, AdminTable, OrderLink, operatorRead } from '@/components/admin/ui';
import { ProviderOperations, ReviewHolds } from '@/components/admin/queue-tables';

export const dynamic = 'force-dynamic';

export default async function OperationsPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/admin/operations';
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const queues = await operatorRead(() => getOperatorQueues(actor));

  return <AdminPage actor={actor} route={route} query={query} title="Operations"
    description="Investigate pending, unknown, and failed operations. Finance or admin can retry the same provider operation.">
    <ProviderOperations items={queues.provider_operations} route={route} allowRetry />
    <AdminTable id="failed-outbox" title="Failed outbox" items={queues.failed_outbox} columns={[
      { label: 'Outbox ID', render: item => str(item.id) },
      { label: 'Semantic key', render: item => str(item.semantic_key) },
      { label: 'Status', render: item => <Badge>{str(item.status)}</Badge> },
      { label: 'Attempts', render: item => str(item.attempts) },
      { label: 'Available at', render: item => date(item.available_at) },
    ]} />
    <AdminTable id="reconciling-holds" title="Reconciling holds" items={queues.reconciling_holds} columns={[
      { label: 'Order', render: item => <OrderLink id={item.order_id} /> },
      { label: 'Capacity bucket', render: item => str(item.bucket_id) },
      { label: 'Status', render: () => <Badge>RECONCILING</Badge> },
      { label: 'Expiry', render: item => date(item.expires_at) },
    ]} />
    <ReviewHolds items={queues.review_holds} />
    <AdminTable id="overdue-orders" title="Overdue orders" items={queues.overdue_orders} columns={[
      { label: 'Order', render: item => <OrderLink id={item.id} /> },
      { label: 'Status', render: item => <Badge>{str(item.status)}</Badge> },
      { label: 'Delivery due', render: item => date(item.delivery_due_at) },
    ]} />
  </AdminPage>;
}
