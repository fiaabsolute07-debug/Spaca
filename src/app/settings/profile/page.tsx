import Link from 'next/link';
import { Mail } from 'lucide-react';
import { getDashboardData } from '@/lib/read-model';
import { Avatar } from '@/components/avatar';
import { FileUploadField } from '@/components/files/file-upload-field';
import { SelectField } from '@/components/select';
import { Badge, CommandForm, Field, date, row, rows, str } from '@/components/ui';
import { WalletLink } from '@/components/crypto/wallet-link';
import { listEnabledNetworks } from '@/modules/crypto/registry';
import { listVerifiedWallets } from '@/modules/crypto/wallets';
import { getSignInMethods, getXProfileViews, hoursUntilOwnRefresh, xConnectAvailable } from '@/modules/x/service';
import { xMode } from '@/modules/x/provider';
import { googleMode } from '@/modules/google/provider';
import { googleAvailable } from '@/modules/google/service';
import { GoogleLogo } from '@/components/brand/google-logo';
import { XProfileCard } from '@/components/x/x-profile-card';
import { XLogo } from '@/components/x/x-logo';
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
  const [wallets, networks, signIn] = await Promise.all([listVerifiedWallets(actor.id), listEnabledNetworks(), getSignInMethods(actor.id)]);
  const isCreator = actor.roles.includes('creator');
  const [xProfiles, refreshWait] = isCreator ? await Promise.all([getXProfileViews([actor.id]), hoursUntilOwnRefresh(actor.id)]) : [new Map(), 0];
  const x = xProfiles.get(actor.id) ?? null;
  const checks = [
    { label: 'Profile photo', done: Boolean(profile.avatar_asset_id) },
    { label: 'Name and handle', done: Boolean(profile.handle) },
    { label: 'Headline', done: Boolean(str(profile.headline).trim()) },
    { label: 'Bio of 80+ characters', done: str(profile.bio).trim().length >= 80 },
    { label: 'Niche', done: Boolean(profile.niche) && str(profile.niche) !== 'Independent creator' },
    ...(isCreator ? [{ label: 'Linked account', done: rows(profile.social_accounts).length > 0 }, { label: 'Approved public work sample', done: Number(profile.public_samples ?? 0) > 0 }] : []),
  ];
  const completed = checks.filter((c) => c.done).length;
  const percent = Math.round((completed / checks.length) * 100);
  return <main className="container">
    {notices}
    <PageHeading
      eyebrow={isCreator ? 'Creator account' : 'Buyer account'}
      title="Your public profile"
      description="Buyers and creators decide faster when they can see who you are and what you have done."
    />
    <div className="profile-layout">
      <div>
        <section className="panel" aria-labelledby="photo-heading">
          <h2 id="photo-heading">Profile photo</h2>
          <div className="profile-photo">
            <Avatar name={profile.display_name ?? actor.display_name} assetId={profile.avatar_asset_id} imageUrl={x?.imageUrl} size={88} />
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
        {/* Accounts are created with X; an email and password can be added here once, as a second way in. */}
        <section className="panel sign-in-settings" id="sign-in" aria-labelledby="sign-in-heading">
          <h2 id="sign-in-heading">Sign-in</h2>
          <ul className="sign-in-methods">
            <li>
              <span className="sign-in-icon" aria-hidden><XLogo size={16} /></span>
              <span className="sign-in-what"><strong>X</strong>
                <small>{signIn.xSource ? `${signIn.xUsername ? `@${signIn.xUsername}` : 'Connected'}${signIn.xSource === 'MOCK' ? ' · sandbox X' : ''}` : 'Not connected'}</small></span>
              <Badge tone={signIn.xSource ? 'good' : 'neutral'}>{signIn.xSource ? 'Signs in' : 'Off'}</Badge>
            </li>
            <li>
              <span className="sign-in-icon" aria-hidden><GoogleLogo size={16} /></span>
              <span className="sign-in-what"><strong>Google</strong>
                <small>{signIn.googleEmail ? `${signIn.googleEmail}${signIn.googleSandbox ? ' · sandbox Google' : ''}` : 'Not connected'}</small></span>
              {signIn.googleEmail
                ? <span className="sign-in-actions"><Badge tone="good">Signs in</Badge><CommandForm command="disconnect_google" label="Disconnect" variant="secondary" returnTo={route} /></span>
                : googleAvailable()
                  ? <form method="post" action="/api/auth/google" className="sign-in-actions">
                    <input type="hidden" name="intent" value="connect" />
                    <input type="hidden" name="return_to" value={route} />
                    <button className="button button-outline compact" type="submit">Connect Google</button>
                  </form>
                  : <Badge>Off</Badge>}
            </li>
            <li>
              <span className="sign-in-icon" aria-hidden><Mail size={16} /></span>
              <span className="sign-in-what"><strong>Email and password</strong><small>{signIn.email ?? 'Not added'}</small></span>
              <Badge tone={signIn.email && signIn.hasPassword ? 'good' : 'neutral'}>{signIn.email && signIn.hasPassword ? 'Signs in' : 'Off'}</Badge>
            </li>
          </ul>
          {!signIn.email && <form method="post" action="/api/auth" className="sign-in-email">
            <input type="hidden" name="action" value="add_email" />
            <p className="muted">Add an email (Gmail or any address) and a password to sign in without X{signIn.xSource ? ', and to keep a way in if you ever disconnect X' : ''}.</p>
            <div className="form-grid">
              <label className="field"><span>Email address</span><input name="email" type="email" required autoComplete="email" maxLength={254} defaultValue={signIn.googleEmail ?? ''} /></label>
              <label className="field"><span>Password (at least 12 characters)</span><input name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" /></label>
            </div>
            <button className="button button-dark" type="submit">Add email</button>
            {actor.is_test && <p className="muted">Local sandbox: no email is sent, so the address is not verified.</p>}
          </form>}
          {!signIn.googleEmail && googleAvailable() && googleMode() === 'mock' && <p className="muted x-sandbox-note">Local sandbox: Connect Google opens a stand-in page. No real Google account is used.</p>}
        </section>
        {isCreator && <>
        <section className="panel x-settings" id="x" aria-labelledby="x-heading">
          <h2 id="x-heading"><XLogo size={18} /> X account</h2>
          {x ? <>
            <p className="muted">Buyers see this in Explore and on your profile. spaca keeps a saved copy and refreshes it every week or so when people view it; it never posts for you.</p>
            <XProfileCard x={x} />
            <div className="inline-actions x-settings-actions">
              <form method="post" action="/api/x/refresh">
                <button className="button button-outline" type="submit" disabled={refreshWait > 0}>Refresh from X</button>
              </form>
              <CommandForm command="disconnect_x" label="Disconnect X" variant="danger" returnTo={route} />
            </div>
            {!signIn.email && <p className="muted">You sign in with this X account. Add an email under Sign-in before disconnecting it.</p>}
            {refreshWait > 0 && <p className="muted">Updated in the last day. You can refresh again in {refreshWait} {refreshWait === 1 ? 'hour' : 'hours'}.</p>}
          </> : xConnectAvailable() ? <>
            <p className="muted">Connect your X account so buyers see your X photo, followers and bio in Explore, marked as connected rather than self-reported. spaca reads your public profile once and never posts, follows or messages for you.</p>
            <form method="post" action="/api/x/connect" className="x-connect-form">
              <input type="hidden" name="return_to" value={route} />
              <button className="button button-dark" type="submit"><XLogo size={14} /> Connect X</button>
            </form>
            {xMode() === 'mock' && <p className="muted x-sandbox-note">Local sandbox: this opens a stand-in for X. No real X account is used and the numbers are generated.</p>}
          </> : <p className="muted">Connecting X is not available in this environment.</p>}
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
        </>}
        <section className="panel" id="wallets" aria-labelledby="wallets-heading">
          <h2 id="wallets-heading">Wallets</h2>
          <p className="muted">Link a wallet to receive crypto payouts and to fund campaign pools. Signing proves you control the address; it never authorizes a payment.</p>
          {wallets.length ? <ul className="facts">
            {wallets.map((wallet) => <li key={str(wallet.id)}>
              <span>{str(wallet.network_name)} · {str(wallet.network_mode).toLowerCase()} · linked {date(wallet.verified_at)}</span>
              <strong className="prewrap">{str(wallet.address)}</strong>
            </li>)}
          </ul> : <p className="muted">No wallet linked yet.</p>}
          <WalletLink networks={networks} />
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
