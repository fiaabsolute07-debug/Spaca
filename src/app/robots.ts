import type { MetadataRoute } from 'next';
import { PRIVATE_PATH_PREFIXES, canonicalUrl } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  const production = process.env.APP_ENV === 'production';
  return {
    // Non-production environments are never indexed.
    rules: production ? [{ userAgent: '*', allow: '/', disallow: [...PRIVATE_PATH_PREFIXES] }] : [{ userAgent: '*', disallow: '/' }],
    sitemap: canonicalUrl('/sitemap.xml'),
  };
}
