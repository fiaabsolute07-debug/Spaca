import { getOperatorQueues } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { Badge, Field, date, str } from '@/components/ui';
import { AdminCommand, AdminPage, SelectField, operatorRead } from '@/components/admin/ui';
import { SampleGallery } from '@/components/samples/sample-gallery';

export const dynamic = 'force-dynamic';

const REPORT_ACTIONS: Record<string, string[]> = {
  REQUEST: ['NONE', 'CLOSE_REQUEST', 'SUSPEND_USER'],
  SERVICE: ['NONE', 'PAUSE_SERVICE', 'SUSPEND_USER'],
  PROFILE: ['NONE', 'SUSPEND_USER'],
  SAMPLE: ['NONE', 'REJECT_SAMPLE', 'SUSPEND_USER'],
  ORDER: ['NONE', 'SUSPEND_USER'],
  PUBLISH_PROOF: ['NONE', 'SUSPEND_USER'],
};

export default async function ModerationPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/admin/moderation';
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const { pending_samples: samples, open_reports: reports } = await operatorRead(() => getOperatorQueues(actor));

  return <AdminPage actor={actor} route={route} query={query} title="Moderation"
    description="Resolve content reports, review pending sample metadata and quarantine unsafe assets. Changes require moderator or admin.">
    <h2>Open reports ({reports.length})</h2>
    {!reports.length && <p className="muted">No open reports are visible to your roles.</p>}
    <div className="admin-card-grid">
      {reports.map(report => <section className="panel" key={str(report.id)}>
        <h2>{str(report.reason).replaceAll('_', ' ').toLowerCase()}</h2>
        <Badge>{str(report.target_type)}</Badge>
        <p className="prewrap">{str(report.details)}</p>
        <p>Target: {str(report.target_id)}<br />Reported by: {str(report.reporter_name, 'Policy check')}<br />Received: {date(report.created_at)}</p>
        <AdminCommand command="admin_resolve_report" route={route} values={{ report_id: str(report.id) }} label="Resolve report">
          <SelectField name="decision" label="Decision" options={['ACTIONED', 'DISMISSED']} />
          <SelectField name="action" label="Action (when actioned)" options={REPORT_ACTIONS[str(report.target_type)] ?? ['NONE']} />
        </AdminCommand>
      </section>)}
    </div>
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
        {/* A picture or a video is decided by looking at it, so the queue shows the file rather than only its id. */}
        <SampleGallery samples={[sample]} label={`Sample ${str(sample.id)}`} />
        <AdminCommand command="admin_moderate_sample" route={route}
          values={{ sample_id: str(sample.id) }} label="Save moderation decision">
          <SelectField name="decision" label="Decision" options={['APPROVED', 'REJECTED']} />
        </AdminCommand>
      </section>)}
    </div>
  </AdminPage>;
}
