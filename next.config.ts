import type { NextConfig } from 'next';

// Private surfaces are noindex at the HTTP layer regardless of page metadata (P5-06).
const PRIVATE_SOURCES = ['/orders/:path*', '/dashboard/:path*', '/admin/:path*', '/buyer/:path*', '/creator/:path*', '/settings/:path*', '/api/:path*', '/sign-in', '/sign-up', '/reset-password'];

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['postgres'],
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
  async headers() {
    return PRIVATE_SOURCES.map((source) => ({ source, headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }));
  },
};
export default config;
