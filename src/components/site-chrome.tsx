'use client';

import { useSelectedLayoutSegment } from 'next/navigation';
import type { ReactNode } from 'react';

/** Top-level routes where a signed-in account gets a back link above the page. */
const WORKSPACE_SEGMENTS = new Set(['dashboard', 'buyer', 'creator', 'orders', 'settings', 'requests', 'auctions', 'services', 'creators', 'explore']);

/**
 * Marketplace header/footer. The marketing landing at `/` renders its own navigation, so the app chrome is hidden there.
 * The check uses the page slot, not the URL: when Log in opens its dialog over the landing, the URL is /sign-in but the
 * landing is still the page underneath.
 *
 * Workspace navigation lives in the header's Account menu; for a signed-in account, workspace and marketplace pages also
 * get a back link to their parent above the page.
 */
export function SiteChrome({ header, footer, back, children }: { header: ReactNode; footer: ReactNode; back?: ReactNode; children: ReactNode }) {
  const segment = useSelectedLayoutSegment();
  const landing = segment === null;
  const framed = Boolean(back) && segment !== null && WORKSPACE_SEGMENTS.has(segment);
  return <>
    {!landing && header}
    {framed ? <div className="container app-frame">{back}{children}</div> : children}
    {!landing && footer}
  </>;
}
