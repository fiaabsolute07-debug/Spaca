import { searchOperatorUsers } from '@/modules/admin/queries';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { Badge, Field, date, str } from '@/components/ui';
import { AdminCommand, AdminPage, SelectField, listText, operatorRead, queryText } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function UsersPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const term = queryText(query.q).slice(0, 120);
  const route = '/admin/users';
  const returnTo = term ? `${route}?${new URLSearchParams({ q: term })}` : route;
  const { actor, prompt } = await requireActorOrLoginPrompt(returnTo, query);
  if (!actor) return prompt;
  const users = await operatorRead(() => searchOperatorUsers(actor, term));

  return <AdminPage actor={actor} route={route} query={query} title="Users and roles"
    description="Moderators and admins manage account status. Only admins can grant or revoke operator roles.">
    <form method="get" action={route} className="panel admin-search">
      <Field name="q" label="Search email or display name (at least 2 characters)">
        <input name="q" type="search" minLength={2} maxLength={120} defaultValue={term} required />
      </Field>
      <button className="button" type="submit">Search users</button>
    </form>
    <p className="muted">Suspension blocks new activity; existing orders and payment obligations continue.
      You cannot change your own status or privileged roles.</p>
    {term.length < 2 ? <p className="muted">Enter at least 2 characters to search.</p>
      : <p className="muted">{users.length} results (up to 50).</p>}
    <div className="admin-card-grid">
      {users.map(user => <section className="panel" key={str(user.id)}>
        <h2>{str(user.display_name)}</h2>
        <Badge>{str(user.status)}</Badge> {user.is_test === true && <Badge>Test account</Badge>}
        <p>{str(user.email)}<br />User ID: {str(user.id)}<br />Created: {date(user.created_at)}</p>
        <p>Marketplace roles: {listText(user.marketplace_roles)}<br />Operator grants: {listText(user.grants)}</p>
        <AdminCommand
          command={user.status === 'SUSPENDED' ? 'admin_reactivate_user' : 'admin_suspend_user'}
          route={route}
          values={{ user_id: str(user.id) }}
          label={user.status === 'SUSPENDED' ? 'Reactivate user' : 'Suspend new activity'}
        />
        <AdminCommand command="admin_grant_role" route={route}
          values={{ user_id: str(user.id) }} label="Grant operator role">
          <SelectField name="role" label="Role to grant (admin only)"
            options={['moderator', 'finance', 'support', 'admin']} />
        </AdminCommand>
        <AdminCommand command="admin_revoke_role" route={route}
          values={{ user_id: str(user.id) }} label="Revoke operator role">
          <SelectField name="role" label="Role to revoke (admin only)"
            options={['moderator', 'finance', 'support', 'admin']} />
        </AdminCommand>
      </section>)}
    </div>
  </AdminPage>;
}
