'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** While an auction is live, reloads the page's server data every few seconds so other people's bids show up. */
export function LiveRefresh({ active, seconds = 8 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [active, router, seconds]);
  return null;
}
