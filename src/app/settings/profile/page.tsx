import { getDashboardData } from '@/lib/read-model';
import { SelectField } from '@/components/select';
import { Badge, CommandForm, Field, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function ProfilePage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/settings/profile";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const d = row(await getDashboardData(actor));
  const profile = row(d.profile);
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Account"
      title="Your public profile"
      description="A clear profile helps buyers choose the right creator and keeps roles server-controlled."
    />
    <div className="panel">
      <CommandForm command="update_profile" label="Save profile" returnTo="/settings/profile">
        <div className="form-grid">
          <Field
            name="display_name"
            label="Display name"
            value={str(profile.display_name, actor.display_name)}
            required
          />
          <Field name="handle" label="Public handle" value={str(profile.handle)} required />
          <Field name="niche" label="Niche" value={str(profile.niche)} placeholder="Independent creator" />
        </div>
        <Field
          name="bio"
          label="Bio"
          type="textarea"
          value={str(profile.bio)}
          required
          placeholder="A short description of your experience and working style."
        />
      </CommandForm>
    </div>
    <section className="panel" aria-labelledby="linked-accounts-heading">
      <h2 id="linked-accounts-heading">Linked accounts</h2>
      <p className="muted">Accounts you post on. They show on your profile as self-reported; spaca does not connect to these platforms. PUBLISH services post on one of them.</p>
      {rows(profile.social_accounts).map(account => <div className="record inline-actions" key={str(account.id)}>
        <a className="text-link" href={str(account.url)} target="_blank" rel="noreferrer">{account.handle ? `@${str(account.handle)}` : str(account.url)}</a>
        <Badge>{str(account.platform)}</Badge>
        <span className="muted">{str(account.verification_status) === 'VERIFIED' ? 'Verified' : 'Self-reported'}</span>
        <CommandForm command="remove_social_account" label="Remove" variant="secondary" values={{ account_id: str(account.id) }} returnTo={route} />
      </div>)}
      <CommandForm command="add_social_account" label="Link account" variant="secondary" returnTo={route}>
        <div className="form-grid">
          <SelectField name="platform" label="Platform" defaultValue="X" options={[{ value: 'X', label: 'X' }, { value: 'INSTAGRAM', label: 'Instagram' }, { value: 'TIKTOK', label: 'TikTok' }, { value: 'YOUTUBE', label: 'YouTube' }, { value: 'NEWSLETTER', label: 'Newsletter' }, { value: 'WEBSITE', label: 'Website' }]} />
          <Field name="account" label="Handle or link" required placeholder="@yourname or https://…" />
        </div>
      </CommandForm>
    </section>
  </main>;
}
