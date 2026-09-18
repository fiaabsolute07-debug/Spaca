import type { NextConfig } from 'next';

// Private surfaces are noindex at the HTTP layer regardless of page metadata (P5-06).
const PRIVATE_SOURCES = ['/orders/:path*', '/dashboard/:path*', '/admin/:path*', '/buyer/:path*', '/creator/:path*', '/settings/:path*', '/notifications', '/api/:path*', '/sign-in', '/sign-up', '/reset-password'];

const config: NextConfig = {
  // A scan or a check can build into its own directory (NEXT_DIST_DIR=.next-scan) without disturbing a running dev server.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  poweredByHeader: false,
  serverExternalPackages: ['postgres'],
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
  async headers() {
    // Every response: no MIME sniffing, no referrer path to other sites, no camera/microphone/location/payment APIs.
    // A production build also refuses framing and asks browsers to keep to HTTPS.
    const production = process.env.NODE_ENV === 'production';
    const security = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
      ...(production ? [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      ] : []),
    ];
    // The hero video and its poster are the heaviest thing a first-time visitor downloads, and files under `public/`
    // are served with `max-age=0, must-revalidate` by default, so every visit fetched them from the origin again.
    // A month at the CDN and a day in the browser: a new encoding ships under a new file name, so nothing goes stale.
    const media = [{ key: 'Cache-Control', value: 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400' }];
    return [
      { source: '/:path*', headers: security },
      { source: '/landing/:file*', headers: media },
      ...PRIVATE_SOURCES.map((source) => ({ source, headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] })),
    ];
  },
};
export default config;
