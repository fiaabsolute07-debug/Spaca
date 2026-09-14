'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** Marketplace header/footer. The marketing landing at `/` renders its own navigation, so the app chrome is hidden there. */
export function SiteChrome({ header, footer, children }: { header: ReactNode; footer: ReactNode; children: ReactNode }) {
  const landing = usePathname() === '/';
  return <>
    {!landing && header}
    {children}
    {!landing && footer}
  </>;
}
