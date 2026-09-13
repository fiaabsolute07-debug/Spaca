import { getOperatorQueues } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { Badge, date, str } from '@/components/ui';
import { AdminCommand, AdminPage, SelectField, operatorRead } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function FlagsPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/admin/flags';
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const { feature_flags: flags } = await operatorRead(() => getOperatorQueues(actor));

  return <AdminPage actor={actor} route={route} query={query} title="Feature flags and kill switches"
    description="Admins can change flags with an audit reason. Disabled flags block new activity; existing orders remain visible.">
    {!flags.length && <p className="muted">No feature flags returned.</p>}
    <div className="admin-card-grid">
      {flags.map(flag => <section className="panel" key={str(flag.key)}>
        <h2>{str(flag.key)}</h2>
        <Badge>{flag.enabled === true ? 'Enabled' : 'Disabled'}</Badge>
        <p>{str(flag.description)}</p>
        <p className="muted">Changed by: {str(flag.changed_by, 'Not recorded')}<br />
          Updated: {date(flag.updated_at)}<br />Reason: {str(flag.changed_reason, 'Not recorded')}</p>
        {flag.key === 'LIVE_PAYMENTS_ENABLED' && <div className="notice">
          The server refuses to enable live payments without the LIVE_PAYMENTS_ENABLED environment gate.
          Changing this flag does not establish payment readiness.
        </div>}
        <AdminCommand command="admin_set_flag" route={route} values={{ key: str(flag.key) }} label="Save flag">
          <SelectField name="enabled" label="Enabled (admin only)" options={['false', 'true']}
            value={flag.enabled === true ? 'true' : 'false'} />
        </AdminCommand>
      </section>)}
    </div>
  </AdminPage>;
}
