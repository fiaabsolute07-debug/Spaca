import { getOperatorQueues } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { Badge, Field, str } from '@/components/ui';
import { AdminCommand, AdminPage, OrderLink, SelectField, age, operatorRead } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function CasesPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/admin/cases';
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const { cases } = await operatorRead(() => getOperatorQueues(actor));

  return <AdminPage actor={actor} route={route} query={query} title="Reconciliation cases"
    description="Highest severity first, then oldest. Assignment and resolution require finance, support, or admin.">
    {!cases.length && <p className="muted">No open cases are visible to your roles.</p>}
    <div className="admin-card-grid">
      {cases.map(item => <section className="panel" key={str(item.id)}>
        <h2>{str(item.kind).replaceAll('_', ' ')}</h2>
        <p className="muted">Case {str(item.id)}</p>
        <OrderLink id={item.order_id} />
        <p><Badge>{str(item.severity)}</Badge> <Badge>{str(item.status)}</Badge> · Age {age(item.age_seconds)}</p>
        <p>Owner: {str(item.assigned_to, 'Unassigned')}<br />Next action: {str(item.next_action, 'Not recorded')}</p>
        <AdminCommand command="admin_assign_case" route={route}
          values={{ case_id: str(item.id) }} label="Assign case">
          <Field name="assignee_id" label="Assignee user ID (finance, support, or admin)"
            required value={str(item.assigned_to)} />
        </AdminCommand>
        <AdminCommand command="admin_resolve_case" route={route}
          values={{ case_id: str(item.id) }} label="Close case">
          <SelectField name="status" label="Resolution" options={['RESOLVED', 'IGNORED']} />
        </AdminCommand>
      </section>)}
    </div>
  </AdminPage>;
}
