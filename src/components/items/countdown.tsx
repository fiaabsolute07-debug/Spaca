'use client';

import { useEffect, useState } from 'react';

/** "2d 4h", "3h 12m", "4m 09s", or "ended": time left until `to`, ticking once a second. */
export function remaining(to: string, now: number): string {
  const ms = new Date(to).getTime() - now;
  if (ms <= 0) return 'ended';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function Countdown({ to, serverNow }: { to: string; serverNow?: string }) {
  // Start from the server's clock so the first paint matches it, then follow this browser's.
  const [now, setNow] = useState(() => (serverNow ? new Date(serverNow).getTime() : Date.now()));
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <time className="countdown" dateTime={to} suppressHydrationWarning>{remaining(to, now)}</time>;
}
