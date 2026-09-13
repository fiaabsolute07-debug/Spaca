import type { NextConfig } from 'next';
const config: NextConfig = { poweredByHeader:false, serverExternalPackages:['postgres'], experimental:{serverActions:{bodySizeLimit:'2mb'}} };
export default config;
