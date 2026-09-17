import { BadgeCheck } from 'lucide-react';
import { compactCount, joinedLabel, updatedAgo, xProfileUrl, type XProfileView } from '@/lib/x-profile';
import { XLogo } from './x-logo';

/**
 * A creator's connected X account from spaca's saved copy (no X read happens here): photo, name, verified mark, handle,
 * follower / following / post counts, bio, location and join date, and where the numbers come from and how old they
 * are. Sandbox rows say so. Works in server and client components.
 */
export function XProfileCard({ x, variant = 'full' }: { x: XProfileView; variant?: 'full' | 'compact' }) {
  const meta = [x.location, x.joinedAt ? `Joined X ${joinedLabel(x.joinedAt)}` : ''].filter(Boolean).join(' · ');
  return <section className={`x-card x-card-${variant}${x.unavailable ? ' is-unavailable' : ''}`} aria-label="On X">
    <header className="x-card-head">
      {x.imageUrl
        // eslint-disable-next-line @next/next/no-img-element -- X's image host (or the sandbox route), not a static asset
        ? <img className="x-card-photo" src={x.imageUrl} alt="" width={52} height={52} loading="lazy" referrerPolicy="no-referrer" />
        : <span className="x-card-photo x-card-initial" aria-hidden>{x.name.slice(0, 1).toUpperCase()}</span>}
      <div className="x-card-who">
        <strong className="x-card-name">
          <span>{x.name}</span>
          {x.verified && <span className="x-card-verified" title="Verified on X"><BadgeCheck size={15} aria-hidden /><span className="visually-hidden">Verified on X</span></span>}
        </strong>
        <a className="x-card-handle" href={xProfileUrl(x.username)} target="_blank" rel="noreferrer nofollow">@{x.username}</a>
      </div>
      <span className="x-card-mark" aria-hidden><XLogo size={15} /></span>
    </header>
    <dl className="x-card-stats">
      <div><dt>Followers</dt><dd>{compactCount(x.followers)}</dd></div>
      <div><dt>Following</dt><dd>{compactCount(x.following)}</dd></div>
      <div><dt>Posts</dt><dd>{compactCount(x.posts)}</dd></div>
    </dl>
    {variant === 'full' && x.description ? <p className="x-card-bio">{x.description}</p> : null}
    {variant === 'full' && meta ? <p className="x-card-meta">{meta}</p> : null}
    {x.unavailable ? <p className="x-card-warning">X no longer shows this account. These are the last saved details.</p> : null}
    <p className="x-card-foot">
      {x.source === 'MOCK' ? <span className="x-card-sandbox">Sandbox X data</span> : <span>Connected via X</span>}
      <span suppressHydrationWarning>{updatedAgo(x.fetchedAt)}</span>
    </p>
  </section>;
}

/** "𝕏 12.4K" for result cards: the follower count from the saved copy. */
export function XFollowerChip({ x }: { x: XProfileView }) {
  return <span className="chip chip-x"><XLogo size={11} /> {compactCount(x.followers)}<span className="visually-hidden"> followers on X</span></span>;
}
