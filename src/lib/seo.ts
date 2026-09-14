/** Public SEO helpers (P5-06): canonical URLs from APP_BASE_URL and sitemap entries for public eligible records only. */
import { sql } from './db';

type Row = Record<string, unknown>;

export function siteUrl(): string {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

export function canonicalUrl(path: string): string {
  return `${siteUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Private surfaces that must never be indexed; also sent as X-Robots-Tag by next.config.ts. */
export const PRIVATE_PATH_PREFIXES = ['/orders', '/dashboard', '/admin', '/buyer', '/creator', '/settings', '/api', '/sign-in', '/sign-up', '/reset-password'] as const;

export async function getSitemapEntries(): Promise<{ url: string; lastModified: Date }[]> {
  const [services, creators, requests, auctions] = await Promise.all([
    sql<Row[]>`select s.id,greatest(s.updated_at,v.created_at) as modified from app.services s join app.service_versions v on v.id=s.published_version_id
      join app.users u on u.id=s.creator_id where s.status='PUBLISHED' and u.status='ACTIVE' and not u.is_test order by s.id limit 45000`,
    sql<Row[]>`select p.handle,p.updated_at as modified from app.profiles p join app.users u on u.id=p.user_id
      where u.status='ACTIVE' and not u.is_test and exists (select 1 from app.services s where s.creator_id=u.id and s.status='PUBLISHED') order by p.handle limit 45000`,
    sql<Row[]>`select r.id,r.updated_at as modified from app.requests r join app.users u on u.id=r.buyer_id
      where r.status='OPEN' and r.application_deadline > now() and not u.is_test order by r.id limit 45000`,
    sql<Row[]>`select a.id,a.updated_at as modified from app.auctions a join app.users u on u.id=a.seller_id
      where a.status in ('SCHEDULED','LIVE') and a.ends_at > now() and u.status='ACTIVE' and not u.is_test order by a.id limit 45000`,
  ]);
  const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));
  return [
    { url: canonicalUrl('/'), lastModified: new Date() },
    { url: canonicalUrl('/explore'), lastModified: new Date() },
    ...services.map((row) => ({ url: canonicalUrl(`/services/${row.id}`), lastModified: date(row.modified) })),
    ...creators.map((row) => ({ url: canonicalUrl(`/creators/${row.handle}`), lastModified: date(row.modified) })),
    ...requests.map((row) => ({ url: canonicalUrl(`/requests/${row.id}`), lastModified: date(row.modified) })),
    ...auctions.map((row) => ({ url: canonicalUrl(`/auctions/${row.id}`), lastModified: date(row.modified) })),
  ];
}
