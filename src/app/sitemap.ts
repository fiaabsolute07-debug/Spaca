import type { MetadataRoute } from 'next';
import { getSitemapEntries } from '@/lib/seo';

export const dynamic = 'force-dynamic';

/** Public eligible records only: published services, creators with published services, open requests, open item auctions. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return (await getSitemapEntries()).map((entry) => ({ url: entry.url, lastModified: entry.lastModified }));
}
