import { getDashboardData } from '@/lib/read-model';
import { CommandForm, Field, row, str } from '@/components/ui';
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
          <Field
            name="social_url"
            label="Social or portfolio URL"
            value={str(profile.social_url)}
            placeholder="https://…"
          />
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
  </main>;
}
