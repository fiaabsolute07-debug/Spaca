import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { googleMode } from '@/modules/google/provider';
import type { PageProps } from '@/components/page-props';
import { GoogleLogo } from '@/components/brand/google-logo';

export const dynamic = 'force-dynamic';

/**
 * Local stand-in for Google's account chooser ("Connect Google" and "Continue with Google" in the sandbox). Nothing here
 * touches Google: the address typed becomes a sandbox Google account, the same address always the same account.
 * 404 unless the Google sandbox is on.
 */
export default async function SandboxGoogleAuthorize({ searchParams }: PageProps) {
  if (googleMode() !== 'mock') notFound();
  const query = await searchParams;
  const state = typeof query.state === 'string' ? query.state.slice(0, 200) : '';
  const actor = await getActor();
  const suggested = actor?.email ?? '';

  return <main className="container x-sandbox-page">
    <section className="x-sandbox" aria-labelledby="google-sandbox-title">
      <p className="x-sandbox-badge">Local sandbox · no real Google account is used</p>
      <span className="x-sandbox-logo" aria-hidden><GoogleLogo size={28} /></span>
      <h1 id="google-sandbox-title">Choose an account to continue to spaca</h1>
      <p>On the real Google, this screen lists your Google accounts. spaca asks for:</p>
      <ul>
        <li>Your name and email address</li>
        <li>That Google has verified the email</li>
      </ul>
      <p className="muted">spaca never reads your mail, contacts or files, and keeps no access to your Google account.</p>
      {state ? <form method="post" action="/api/dev/google/approve" className="x-sandbox-form">
        <input type="hidden" name="state" value={state} />
        <label className="field" htmlFor="google-sandbox-email">
          <span>Sandbox Google account</span>
          <input id="google-sandbox-email" name="email" type="email" defaultValue={suggested} required maxLength={254} autoCapitalize="none" spellCheck={false} placeholder="name@gmail.com" />
          <small>Any address works here; the same address is always the same sandbox account.</small>
        </label>
        <div className="x-sandbox-actions">
          <button className="button button-dark" type="submit" name="decision" value="approve">Continue</button>
          <button className="button button-outline" type="submit" name="decision" value="cancel" formNoValidate>Cancel</button>
        </div>
      </form> : <p className="notice">This sign-in link is incomplete. Start again.</p>}
    </section>
  </main>;
}
