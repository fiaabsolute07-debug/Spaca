'use client';

import { useEffect, useMemo, useState } from 'react';

type Props = { serviceId: string; sessionMinutes: number; creatorTimeZone: string | null };

const dayKey = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/**
 * XPL-03: free starts come from the server as UTC instants and are shown in the viewer's own time zone. The chosen
 * start is submitted as ISO UTC; the server re-checks that it is still offered and free.
 */
export function SlotPicker({ serviceId, sessionMinutes, creatorTimeZone }: Props) {
  const [slots, setSlots] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [week, setWeek] = useState(0);
  const viewerZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  useEffect(() => {
    let cancelled = false;
    const from = new Date(Date.now() + week * 7 * 86_400_000).toISOString();
    setSlots(null);
    setError(null);
    fetch(`/api/services/${serviceId}/slots?from=${encodeURIComponent(from)}&days=7`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { slots?: string[]; error?: string };
        if (cancelled) return;
        if (!response.ok) setError(body.error ?? 'Times could not be loaded');
        else setSlots(body.slots ?? []);
      })
      .catch(() => !cancelled && setError('Times could not be loaded'));
    return () => { cancelled = true; };
  }, [serviceId, week]);

  const days = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const slot of slots ?? []) grouped.set(dayKey(slot, viewerZone), [...(grouped.get(dayKey(slot, viewerZone)) ?? []), slot]);
    return [...grouped.entries()];
  }, [slots, viewerZone]);

  const time = (iso: string) => new Intl.DateTimeFormat(undefined, { timeZone: viewerZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const dayLabel = (iso: string) => new Intl.DateTimeFormat(undefined, { timeZone: viewerZone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));

  return <fieldset className="slot-picker">
    <legend>Pick a {sessionMinutes}-minute session</legend>
    <input type="hidden" name="starts_at" value={selected} />
    <p className="muted">Times in your time zone ({viewerZone}).{creatorTimeZone && creatorTimeZone !== viewerZone ? ` The creator is in ${creatorTimeZone}.` : ''}</p>
    <div className="inline-actions">
      <button type="button" className="button button-outline" disabled={week === 0} onClick={() => setWeek((w) => Math.max(0, w - 1))}>‹ Earlier</button>
      <button type="button" className="button button-outline" disabled={week >= 7} onClick={() => setWeek((w) => w + 1)}>Later ›</button>
    </div>
    {error && <p className="notice" role="alert">{error}</p>}
    {!error && slots === null && <p className="muted">Loading times…</p>}
    {!error && slots !== null && days.length === 0 && <p className="muted">No free times this week. Try later dates.</p>}
    {days.map(([key, list]) => <div className="slot-day" key={key}>
      <strong>{dayLabel(list[0]!)}</strong>
      <div className="slot-list" role="radiogroup" aria-label={dayLabel(list[0]!)}>
        {list.map((slot) => <button
          key={slot}
          type="button"
          role="radio"
          aria-checked={selected === slot}
          className={selected === slot ? 'slot slot-selected' : 'slot'}
          onClick={() => setSelected(slot)}
        >{time(slot)}</button>)}
      </div>
    </div>)}
    {selected
      ? <p className="slot-summary">Selected: {dayLabel(selected)} at {time(selected)} ({viewerZone})</p>
      : <p className="muted">Choose a time before reserving.</p>}
  </fieldset>;
}
