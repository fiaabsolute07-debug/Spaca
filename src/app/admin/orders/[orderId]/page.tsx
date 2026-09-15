import { notFound } from 'next/navigation';
import { getOperatorOrder } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { Badge, Field, date, humanize, money, row, rows, str } from '@/components/ui';
import { AdminCommand, AdminPage, AdminTable, operatorRead } from '@/components/admin/ui';
import { ProviderOperations, ReviewHolds } from '@/components/admin/queue-tables';

export const dynamic = 'force-dynamic';

export default async function OperatorOrderPage({ params, searchParams }: PageProps<{ orderId: string }>) {
  const query = await searchParams;
  const { orderId } = await params;
  const route = `/admin/orders/${encodeURIComponent(orderId)}`;
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const validId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(orderId);
  // Keep authorization in the read model even for malformed IDs, without reaching its UUID SQL cast.
  const data = await operatorRead(() => getOperatorOrder(actor, validId ? orderId : 'invalid'));
  if (!validId || !data) notFound();
  const { order } = data;

  return <AdminPage actor={actor} route={route} query={query} title={str(order.title, 'Order detail')}
    description={`Order ${str(order.id)} · ${str(order.source)} · Version ${str(order.version)}`}>
    <div className="admin-card-grid">
      <section className="panel">
        <h2>State and parties</h2>
        <Badge>{str(order.status)}</Badge>
        <dl className="admin-facts">
          <dt>Before dispute</dt><dd>{str(order.status_before_dispute, 'Not applicable')}</dd>
          <dt>Payment</dt><dd>{str(order.payment_status)}</dd>
          <dt>Settlement</dt><dd>{str(order.settlement_status)}</dd>
          <dt>Buyer</dt><dd>{str(order.buyer_name)}<small>{str(order.buyer_id)}</small></dd>
          <dt>Creator</dt><dd>{str(order.creator_name)}<small>{str(order.creator_id)}</small></dd>
          <dt>Amount</dt><dd>{money(order.amount_minor)} {str(order.currency)}</dd>
          <dt>Platform fee</dt><dd>{money(order.platform_fee_minor)}</dd>
          <dt>Provider fee</dt><dd>{money(order.provider_fee_minor)}</dd>
          <dt>Cancellation refund</dt><dd>{order.cancellation_refund_minor == null
            ? 'Not specified' : money(order.cancellation_refund_minor)}</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>Order clock</h2>
        <dl className="admin-facts">
          {[
            ['Created', 'created_at'], ['Funded', 'funded_at'], ['Delivery due', 'delivery_due_at'],
            ['Review due', 'review_due_at'], ['Approved', 'approved_at'],
            ['Completed', 'completed_at'], ['Cancelled', 'cancelled_at'],
          ].map(([label, key]) => <div className="admin-fact-row" key={key}>
            <dt>{label}</dt><dd>{order[key] ? date(order[key]) : 'Not recorded'}</dd>
          </div>)}
        </dl>
      </section>
    </div>
    <section className="panel">
      <h2>Request or retry refund</h2>
      <p>Finance or admin only. The order must be CANCELLED with payment status REFUND_PENDING or SUCCEEDED.
        Refunds require provider confirmation.</p>
      <AdminCommand command="admin_refund_order" route={route}
        values={{ order_id: str(order.id) }} label="Request refund with provider" />
    </section>
    {str(order.settlement_status) === 'RELEASED' && <section className="panel">
      <h2>Refund after the creator was paid</h2>
      <p>Finance or admin only. The amount is first reversed from the creator transfer. If their balance cannot cover it, nothing is refunded
        and the deficit stays open until a retry succeeds or you approve a platform cover.</p>
      {data.post_release_refunds.some((r) => str(r.status) !== 'REFUNDED') ? null : <AdminCommand command="admin_refund_after_release" route={route}
        values={{ order_id: str(order.id) }} label="Refund after release">
        <Field name="amount" label="Amount (USD, up to what the creator received)" required placeholder="0.00" />
      </AdminCommand>}
    </section>}
    <AdminTable title="Refunds after release" items={data.post_release_refunds} columns={[
      { label: 'Refund', render: item => <>{money(item.amount_minor)}<small>{str(item.id)}</small></> },
      { label: 'Status', render: item => <Badge>{str(item.status)}</Badge> },
      { label: 'Recovered from creator', render: item => money(item.recovered_minor) },
      { label: 'Covered by platform', render: item => money(item.covered_minor) },
      { label: 'Reason', render: item => str(item.covered_reason, str(item.reason)) },
      { label: 'Next step', render: item => str(item.status) === 'DEFICIT' ? <div className="inline-actions">
        <AdminCommand command="admin_retry_refund_recovery" route={route} values={{ refund_id: str(item.id) }} label="Retry reversal" />
        <AdminCommand command="admin_cover_refund_deficit" route={route} values={{ refund_id: str(item.id) }} label="Cover from platform funds" />
      </div> : str(item.status) === 'REFUNDED' ? 'Done' : 'Waiting for the provider' },
      { label: 'Updated', render: item => date(item.updated_at) },
    ]} />
    <AdminTable title="Order events" items={data.events} columns={[
      { label: 'Event', render: item => str(item.kind) },
      { label: 'Actor', render: item => str(item.actor_id, 'System') },
      { label: 'Time', render: item => date(item.created_at) },
    ]} />
    <ProviderOperations items={data.provider_operations.map(item => ({ ...item, order_id: order.id }))} route={route} />
    <AdminTable title="Reconciliation cases" items={data.cases} columns={[
      { label: 'Case', render: item => <>{str(item.kind)}<small>{str(item.id)}</small></> },
      { label: 'Severity', render: item => <Badge>{str(item.severity)}</Badge> },
      { label: 'Status', render: item => <Badge>{str(item.status)}</Badge> },
      { label: 'Owner', render: item => str(item.assigned_to, 'Unassigned') },
      { label: 'Next action', render: item => str(item.next_action, 'Not recorded') },
      { label: 'Created', render: item => date(item.created_at) },
    ]} />
    <AdminTable title="Disputes" items={data.disputes} columns={[
      { label: 'Dispute', render: item => str(item.id) },
      { label: 'Status', render: item => <Badge>{str(item.status)}</Badge> },
      { label: 'Outcome', render: item => str(item.outcome, 'Unresolved') },
      { label: 'Refund', render: item => item.refund_amount_minor == null ? 'None' : money(item.refund_amount_minor) },
      { label: 'Owner', render: item => str(item.assigned_to, 'Unassigned') },
      { label: 'Created', render: item => date(item.created_at) },
      { label: 'Resolved', render: item => item.resolved_at ? date(item.resolved_at) : 'Open' },
    ]} />
    <AdminTable title="Provider cost changes" items={data.provider_cost_adjustments} columns={[
      { label: 'Cost', render: item => `${money(item.previous_fee_minor)} → ${money(item.actual_fee_minor)}` },
      { label: 'When', render: item => humanize(str(item.phase)) },
      { label: 'Creator share', render: item => money(item.creator_share_minor) },
      { label: 'Platform share', render: item => money(item.platform_share_minor) },
      { label: 'Owed to creator', render: item => money(item.creator_credit_minor) },
      { label: 'Policy', render: item => `${humanize(str(item.fee_payer))} · cap ${money(item.cap_minor)}` },
      { label: 'Recorded', render: item => date(item.created_at) },
    ]} />
    <AdminTable title="Card payment disputes" items={data.payment_disputes} columns={[
      { label: 'Provider dispute', render: item => str(item.provider_reference) },
      { label: 'Amount', render: item => money(item.amount_minor) },
      { label: 'Status', render: item => <Badge>{str(item.status)}</Badge> },
      { label: 'Order when opened', render: item => `${humanize(str(item.order_status_at_open))} · settlement ${humanize(str(item.settlement_status_at_open))}` },
      { label: 'Evidence on record', render: item => {
        const e = row(item.evidence);
        return `${rows(e.deliveries).length} deliveries · approved ${e.approved_at ? date(e.approved_at) : 'no'} · completed ${e.completed_at ? date(e.completed_at) : 'no'} · ${str(e.message_count, '0')} messages · ${str(e.buyer_reviews, '0')} buyer reviews`;
      } },
      { label: 'Opened', render: item => date(item.opened_at) },
      { label: 'Closed', render: item => item.closed_at ? date(item.closed_at) : 'Open' },
    ]} />
    <AdminTable title="Files (metadata only)" items={data.files} columns={[
      { label: 'Asset ID', render: item => str(item.id) },
      { label: 'Filename', render: item => str(item.filename) },
      { label: 'Purpose', render: item => str(item.purpose) },
      { label: 'MIME type', render: item => str(item.mime) },
      { label: 'Size (bytes)', render: item => str(item.size_bytes) },
      { label: 'State', render: item => <Badge>{str(item.lifecycle_state)}</Badge> },
      { label: 'Scan detail', render: item => str(item.scan_detail, 'Not recorded') },
      { label: 'Created', render: item => date(item.created_at) },
    ]} />
    <ReviewHolds items={data.review_holds.map(item => ({ ...item, order_id: order.id }))} />
  </AdminPage>;
}
