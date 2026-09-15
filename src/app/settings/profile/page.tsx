import Link from 'next/link';
import { getDashboardData } from '@/lib/read-model';
import { Avatar } from '@/components/avatar';
import { FileUploadField } from '@/components/files/file-upload-field';
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
  const isCreator = actor.roles.includes('creator');
  const checks = [
    { label: 'Profile photo', done: Boolean(profile.avatar_asset_id) },
    { label: 'Name and handle', done: Boolean(profile.handle) },
    { label: 'Headline', done: Boolean(str(profile.headline).trim()) },
    { label: 'Bio of 80+ characters', done: str(profile.bio).trim().length >= 80 },
    { label: 'Niche', done: Boolean(profile.niche) && str(profile.niche) !== 'Independent creator' },
    { label: 'Linked account', done: rows(profile.social_accounts).length > 0 },
    ...(isCreator ? [{ label: 'Approved public work sample', done: Number(profile.public_samples ?? 0) > 0 }] : []),
  ];
  const completed = checks.filter((c) => c.done).length;
  const percent = Math.round((completed / checks.length) * 100);
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow="Account"
      title="Your public profile"
      description="Buyers and creators decide faster when they can see who you are and what you have done."
    />
    <div className="profile-layout">
      <div>
        <section className="panel" aria-labelledby="photo-heading">
          <h2 id="photo-heading">Profile photo</h2>
          <div className="profile-photo">
            <Avatar name={profile.display_name ?? actor.display_name} assetId={profile.avatar_asset_id} size={88} />
            <div className="profile-photo-actions">
              <p className="muted">PNG, JPG, GIF or WebP up to 10 MB. A square photo of your face or brand mark works best.</p>
              <CommandForm command="set_avatar" label={profile.avatar_asset_id ? 'Save new photo' : 'Save photo'} variant="secondary" returnTo={route}>
                <FileUploadField purpose="AVATAR" label="Choose a photo" maxFiles={1} />
              </CommandForm>
              {profile.avatar_asset_id ? <CommandForm command="remove_avatar" label="Remove photo" variant="danger" returnTo={route} /> : null}
            </div>
          </div>
          {!profile.handle && <p className="notice">Save your name and handle below before adding a photo.</p>}
        </section>
        <section className="panel" aria-labelledby="details-heading">
          <h2 id="details-heading">Details</h2>
          <CommandForm command="update_profile" label="Save profile" returnTo={route}>
            <div className="form-grid">
              <Field name="display_name" label="Display name" value={str(profile.display_name, actor.display_name)} required />
              <Field name="handle" label="Public handle" value={str(profile.handle)} required placeholder="yourname" />
            </div>
            <Field name="headline" label="Headline" value={str(profile.headline)} placeholder="DeFi researcher writing launch threads for L2 teams" />
            <div className="form-grid">
              <Field name="niche" label="Niche" value={str(profile.niche) === 'Independent creator' ? '' : str(profile.niche)} placeholder="DeFi, infrastructure, gaming…" />
              <Field name="location" label="Location" value={str(profile.location)} placeholder="Ho Chi Minh City, Vietnam" />
            </div>
            <Field name="languages" label="Languages" value={str(profile.languages)} placeholder="English, Vietnamese" />
            <Field name="bio" label="Bio" type="textarea" value={str(profile.bio)} required
              placeholder="Your experience, the projects you have worked with and how you like to work." />
          </CommandForm>
        </section>
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
      </div>
      <aside>
        <section className="panel profile-strength" aria-labelledby="strength-heading">
          <h2 id="strength-heading">Profile strength</h2>
          <div className="strength-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Profile completion">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="muted">{completed} of {checks.length} done · {percent}%</p>
          <ul className="strength-list">
            {checks.map((check) => <li key={check.label} className={check.done ? 'done' : ''}>
              <span aria-hidden="true">{check.done ? '✓' : '○'}</span> {check.label}{check.done ? '' : ' (to do)'}
            </li>)}
          </ul>
          {profile.handle ? <Link className="text-link" href={`/creators/${str(profile.handle)}`}>View public profile ›</Link> : null}
        </section>
      </aside>
    </div>
  </main>;
}
