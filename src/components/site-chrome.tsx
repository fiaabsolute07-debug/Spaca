'use client';

import { useSelectedLayoutSegment } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Marketplace header/footer. The marketing landing at `/` renders its own navigation, so the app chrome is hidden there.
 * The check uses the page slot, not the URL: when Log in opens its dialog over the landing, the URL is /sign-in but the
 * landing is still the page underneath.
 */
export function SiteChrome({ header, footer, children }: { header: ReactNode; footer: ReactNode; children: ReactNode }) {
  const landing = useSelectedLayoutSegment() === null;
  return <>
    {!landing && header}
    {children}
    {!landing && footer}
  </>;
}
