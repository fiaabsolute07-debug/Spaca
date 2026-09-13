import { getOperatorQueues } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { Badge, Field, money, str } from '@/components/ui';
import { AdminCommand, AdminPage, OrderLink, SelectField, age, operatorRead } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function DisputesPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/admin/disputes';
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const { disputes } = await operatorRead(() => getOperatorQueues(actor));

  return <AdminPage actor={actor} route={route} query={query} title="Open disputes"
    description="Support, finance, or admin can resume work. Approval and refunds require finance or admin.">
    {!disputes.length && <p className="muted">No open disputes.</p>}
    <div className="admin-card-grid">
      {disputes.map(dispute => <section className="panel" key={str(dispute.id)}>
        <h2>Dispute #{str(dispute.id).slice(0, 8)}</h2>
        <OrderLink id={dispute.order_id} />
        <p><Badge>{str(dispute.status)}</Badge> · Age {age(dispute.age_seconds)}</p>
        <p>State before dispute: {str(dispute.status_before_dispute, 'Not recorded')}<br />
          Owner: {str(dispute.assigned_to, 'Unassigned')}</p>
        {dispute.amount_minor != null && <p>Order amount: {money(dispute.amount_minor)} {str(dispute.currency)}</p>}
        <AdminCommand command="admin_resolve_dispute" route={route}
          values={{ dispute_id: str(dispute.id) }} label="Resolve dispute">
          <SelectField name="outcome" label="Outcome"
            options={['RESUME', 'APPROVE', 'REFUND_FULL', 'REFUND_PARTIAL']} />
          <Field name="refund_amount" label="Partial refund amount (USD; only for REFUND PARTIAL)">
            <input name="refund_amount" type="number" min="0.01" step="0.01" inputMode="decimal" />
            <small>Required for a partial refund. Must be less than the full order amount.</small>
          </Field>
        </AdminCommand>
      </section>)}
    </div>
  </AdminPage>;
}
