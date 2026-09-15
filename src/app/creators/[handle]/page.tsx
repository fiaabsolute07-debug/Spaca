import { notFound } from 'next/navigation';
import { Avatar } from '@/components/avatar';

import { getCreatorData } from '@/lib/read-model';
import { Badge, Empty, ServiceCard, num, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

const PLATFORM_NAMES: Record<string, string> = { X: 'X', INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube', NEWSLETTER: 'Newsletter', WEBSITE: 'Website' };

export default async function CreatorPage({
  params,
  searchParams
}: PageProps<{
  handle: string;
}>) {
  const query = await searchParams;
  const {
    handle
  } = await params;

  const notices = <Notices query={query} />;
  const result = await getCreatorData(handle);
  if (!result) notFound();
  const d = row(result),
    c = row(d.creator);
  return <main className="container">
    {notices}
    <div className="panel">
      <div className="creator-hero">
        <Avatar name={c.display_name} assetId={c.avatar_asset_id} size={88} />
        <div>
          <PageHeading
            eyebrow={str(c.niche, 'Independent creator')}
            title={str(c.display_name)}
            description={str(c.headline) || undefined}
          />
          {(c.location || c.languages) ? <p className="muted creator-meta">
            {[str(c.location), c.languages ? `Speaks ${str(c.languages)}` : ''].filter(Boolean).join(' · ')}
          </p> : null}
        </div>
      </div>
      {c.bio ? <p className="prewrap creator-bio">{str(c.bio)}</p> : null}
      {rows(d.social_accounts).length > 0 && <ul className="social-links">
        {rows(d.social_accounts).map(account => <li key={str(account.id)}>
          <a className="text-link" href={str(account.url)} target="_blank" rel="noreferrer nofollow">
            {account.handle ? `@${str(account.handle)}` : str(account.url).replace('https://', '')}
          </a>
          <span className="muted"> · {PLATFORM_NAMES[str(account.platform)] ?? str(account.platform)} · {str(account.verification_status) === 'VERIFIED' ? 'Verified' : 'Self-reported'}</span>
        </li>)}
      </ul>}
      <div className="inline-actions">
        <Badge>
          {num(c.completed_jobs)}
          {" completed jobs"}
        </Badge>
        {c.rating != null && <Badge>
          {str(c.rating)}
          {" rating"}
        </Badge>}
      </div>
    </div>
    <div className="section-heading">
      <h2>Ways to work together</h2>
    </div>
    <div className="service-grid">
      {rows(d.services).map((s, i) => <ServiceCard key={str(s.id)} service={s} index={i} />)}
    </div>
    <div className="section-heading">
      <h2>Work samples</h2>
    </div>
    <div className="panel">
      {rows(d.samples).length ? rows(d.samples).map(s => <div className="record" key={str(s.url)}>
        <a className="text-link" href={str(s.url)} target="_blank" rel="noreferrer">
          {str(s.title)}
          {" ›"}
        </a>
        <p>
          {str(s.description)}
        </p>
      </div>) : <Empty title="No samples yet" />}
    </div>
  </main>;
}
