'use client';

import { useEffect, useState } from 'react';

const format = (iso: string, timeZone?: string) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));

/** Renders an instant in the viewer's time zone after hydration (UTC on the server, so markup always matches). */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(() => format(iso, 'UTC'));
  useEffect(() => setText(format(iso)), [iso]);
  return <time dateTime={iso}>{text}</time>;
}
