'use client';

import { useSelectedLayoutSegment } from 'next/navigation';
import type { ReactNode } from 'react';

/** Top-level routes a signed-in account uses inside the workspace frame (sidebar + back link). */
const WORKSPACE_SEGMENTS = new Set(['dashboard', 'buyer', 'creator', 'orders', 'settings', 'requests', 'auctions', 'services', 'creators', 'explore']);

/**
 * Marketplace header/footer. The marketing landing at `/` renders its own navigation, so the app chrome is hidden there.
 * The check uses the page slot, not the URL: when Log in opens its dialog over the landing, the URL is /sign-in but the
 * landing is still the page underneath.
 *
 * For a signed-in account, workspace and marketplace pages render beside one persistent sidebar: navigation swaps the
 * page next to it instead of leaving the workspace.
 */
export function SiteChrome({ header, footer, sidebar, back, children }: { header: ReactNode; footer: ReactNode; sidebar?: ReactNode; back?: ReactNode; children: ReactNode }) {
  const segment = useSelectedLayoutSegment();
  const landing = segment === null;
  const framed = Boolean(sidebar) && segment !== null && WORKSPACE_SEGMENTS.has(segment);
  return <>
    {!landing && header}
    {framed
      ? <div className="container workspace app-frame">{sidebar}<div className="workspace-main">{back}{children}</div></div>
      : children}
    {!landing && footer}
  </>;
}
