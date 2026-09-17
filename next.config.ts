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
    return PRIVATE_SOURCES.map((source) => ({ source, headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }));
  },
};
export default config;
