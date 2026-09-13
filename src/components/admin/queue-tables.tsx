import { Badge, date, str, type Row } from '@/components/ui';
import { AdminCommand, AdminTable, OrderLink, providerReference, type Column } from './ui';

export function ProviderOperations({ items, route, allowRetry = false }: {
  items: readonly Row[];
  route: string;
  allowRetry?: boolean;
}) {
  const columns: Column[] = [
    { label: 'Operation', render: item => <><strong>{str(item.kind)}</strong><small>{str(item.operation_id)}</small></> },
    { label: 'Order', render: item => <OrderLink id={item.order_id} /> },
    { label: 'Status', render: item => <Badge>{str(item.status)}</Badge> },
    { label: 'Reference (redacted)', render: item => providerReference(item.provider_reference) },
    // Provider error messages may contain unredacted references; do not print their raw text.
    { label: 'Last error', render: item => item.last_error ? 'Error recorded' : 'None recorded' },
    { label: 'Updated', render: item => date(item.updated_at) },
  ];
  if (allowRetry) columns.push({
    label: 'Reconcile', render: item => ['PENDING', 'UNKNOWN', 'FAILED'].includes(str(item.status))
      ? <AdminCommand
        command="admin_retry_operation"
        route={route}
        values={{ operation_id: str(item.operation_id) }}
        label="Retry same operation"
      /> : 'No retry needed',
  });
  return <AdminTable id="provider-operations" title="Provider operations" items={items} columns={columns} />;
}

export function ReviewHolds({ items }: { items: readonly Row[] }) {
  return <AdminTable id="review-holds" title="Review holds" items={items} columns={[
    { label: 'Order', render: item => <OrderLink id={item.order_id} /> },
    { label: 'Reason', render: item => str(item.reason, 'Not recorded') },
    { label: 'Delivery version', render: item => str(item.delivery_version) },
    { label: 'Created', render: item => date(item.created_at) },
    { label: 'Resolved', render: item => item.resolved_at ? date(item.resolved_at) : 'Open' },
  ]} />;
}
