import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { sql } from '@/lib/db';
import { xMode } from '@/modules/x/provider';
import type { PageProps } from '@/components/page-props';
import { XLogo } from '@/components/x/x-logo';

export const dynamic = 'force-dynamic';

/**
 * Local stand-in for X's consent screen ("Connect X" and "Continue with X" in the sandbox). Nothing here touches x.com: the chosen username
 * becomes a generated sandbox profile, stored and shown as sandbox data. 404 unless the X sandbox is on.
 */
export default async function SandboxXAuthorize({ searchParams }: PageProps) {
  if (xMode() !== 'mock') notFound();
  const query = await searchParams;
  const state = typeof query.state === 'string' ? query.state.slice(0, 200) : '';
  const actor = await getActor();
  const [profile] = actor ? await sql<{ handle: string }[]>`select handle from app.profiles where user_id=${actor.id}` : [];
  const suggested = (profile?.handle ?? '').replace(/-/g, '_').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);

  return <main className="container x-sandbox-page">
    <section className="x-sandbox" aria-labelledby="x-sandbox-title">
      <p className="x-sandbox-badge">Local sandbox · no real X account is used</p>
      <span className="x-sandbox-logo" aria-hidden><XLogo size={28} /></span>
      <h1 id="x-sandbox-title">spaca wants to access your X account</h1>
      <p>On the real X, this screen lists what spaca may read. spaca asks for:</p>
      <ul>
        <li>Your profile: name, username, photo, bio, location and join date</li>
        <li>Your public counts: followers, following and posts</li>
      </ul>
      <p className="muted">spaca never posts, follows or sends messages for you, and keeps no access to your account after reading it.</p>
      {state ? <form method="post" action="/api/dev/x/approve" className="x-sandbox-form">
        <input type="hidden" name="state" value={state} />
        <label className="field" htmlFor="x-sandbox-username">
          <span>Sandbox X username</span>
          <input id="x-sandbox-username" name="username" defaultValue={suggested} required maxLength={15} pattern="@?[A-Za-z0-9_]{1,15}" autoCapitalize="none" spellCheck={false} />
          <small>Any username works here; its followers and bio are generated for the sandbox.</small>
        </label>
        <div className="x-sandbox-actions">
          <button className="button button-dark" type="submit" name="decision" value="approve">Authorize app</button>
          <button className="button button-outline" type="submit" name="decision" value="cancel" formNoValidate>Cancel</button>
        </div>
      </form> : <p className="notice">This sign-in link is incomplete. Start again.</p>}
    </section>
  </main>;
}
