import { getAuditLog } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { Field, date, str } from '@/components/ui';
import { AdminPage, AdminTable, compactAuditJson, listText, operatorRead, queryText } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function AuditPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/admin/audit';
  const entityType = queryText(query.entity_type);
  const entityId = queryText(query.entity_id);
  const filters = new URLSearchParams();
  if (entityType) filters.set('entity_type', entityType);
  if (entityId) filters.set('entity_id', entityId);
  const returnTo = filters.size ? `${route}?${filters}` : route;
  const { actor, prompt } = await requireActorOrLoginPrompt(returnTo, query);
  if (!actor) return prompt;
  const validId = !entityId || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entityId);
  // Still call the authorized read on invalid input; never send a malformed UUID to its SQL cast.
  const audit = await operatorRead(() => getAuditLog(actor, {
    entityType: entityType || undefined,
    entityId: validId ? entityId || undefined : '00000000-0000-0000-0000-000000000000',
    limit: 100,
  }));

  return <AdminPage actor={actor} route={route} query={query} title="Audit log"
    description="The latest 100 matching privileged actions, including the actor's roles at the time of each change.">
    <form method="get" action={route} className="panel">
      <div className="form-grid">
        <Field name="entity_type" label="Entity type (optional)" value={entityType} placeholder="order" />
        <Field name="entity_id" label="Entity ID (optional UUID)" value={entityId} />
      </div>
      <button className="button" type="submit">Filter audit log</button>
    </form>
    {!validId && <div className="notice error" role="alert">Enter a valid UUID for the entity ID.</div>}
    <AdminTable title="Audit entries" items={validId ? audit : []} columns={[
      { label: 'Time', render: item => date(item.created_at) },
      { label: 'Actor', render: item => str(item.actor_id, 'System') },
      { label: 'Roles snapshot', render: item => listText(item.actor_roles) },
      { label: 'Action', render: item => str(item.action) },
      { label: 'Entity', render: item => <>{str(item.entity_type)}<small>{str(item.entity_id, 'No entity ID')}</small></> },
      { label: 'Reason', render: item => str(item.reason) },
      { label: 'Change', render: item => <details>
        <summary>Before / after</summary>
        <strong>Before</strong><pre className="admin-json">{compactAuditJson(item.before_state)}</pre>
        <strong>After</strong><pre className="admin-json">{compactAuditJson(item.after_state)}</pre>
      </details> },
    ]} />
  </AdminPage>;
}
