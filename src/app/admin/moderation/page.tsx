import { getOperatorQueues } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { Badge, Field, date, str } from '@/components/ui';
import { AdminCommand, AdminPage, SelectField, operatorRead } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function ModerationPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/admin/moderation';
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const { pending_samples: samples } = await operatorRead(() => getOperatorQueues(actor));

  return <AdminPage actor={actor} route={route} query={query} title="Moderation"
    description="Review pending sample metadata and quarantine unsafe assets. Changes require moderator or admin.">
    <section className="panel">
      <h2>Quarantine an asset</h2>
      <p>Quarantine removes the file from download access. Enter the asset ID from an operator record.</p>
      <AdminCommand command="admin_quarantine_asset" route={route} values={{}} label="Quarantine asset">
        <Field name="asset_id" label="Asset ID" required />
      </AdminCommand>
    </section>
    <h2>Pending samples ({samples.length})</h2>
    {!samples.length && <p className="muted">No pending samples are visible to your roles.</p>}
    <div className="admin-card-grid">
      {samples.map(sample => <section className="panel" key={str(sample.id)}>
        <h2>{str(sample.title, 'Untitled sample')}</h2>
        <Badge>{str(sample.visibility)}</Badge>
        <p>Sample: {str(sample.id)}<br />Creator: {str(sample.creator_id)}<br />Submitted: {date(sample.created_at)}</p>
        <AdminCommand command="admin_moderate_sample" route={route}
          values={{ sample_id: str(sample.id) }} label="Save moderation decision">
          <SelectField name="decision" label="Decision" options={['APPROVED', 'REJECTED']} />
        </AdminCommand>
      </section>)}
    </div>
  </AdminPage>;
}
