'use client';

import { useEffect, useId, useState } from 'react';

/** The wall-clock string a `datetime-local` input holds, for an instant read in the reader's own zone. */
const localWallClock = (instant: Date) => new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Minutes east of UTC that the reader's zone was on at the moment picked, so a date across a DST change still lands right. */
function offsetAt(wall: string): number | null {
  const picked = new Date(wall);
  return Number.isNaN(picked.getTime()) ? null : -picked.getTimezoneOffset();
}

const offsetLabel = (minutes: number) => {
  const sign = minutes < 0 ? '-' : '+';
  const size = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(size / 60)).padStart(2, '0')}:${String(size % 60).padStart(2, '0')}`;
};

/** What the chosen wall clock becomes in UTC, which is the clock every date on the rest of the site is shown in. */
function inUtc(wall: string, offsetMinutes: number): string | null {
  const instant = new Date(`${wall}Z`);
  if (Number.isNaN(instant.getTime())) return null;
  return new Date(instant.getTime() - offsetMinutes * 60_000)
    .toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
}

/**
 * A moment in time, typed the way the person reads a clock. A `datetime-local` value carries no zone, so the browser
 * sends the offset it was on at the moment picked in `<name>_offset` and the server shifts the wall clock by it — the
 * auction that starts "at 14:00" starts at the creator's 14:00, not seven hours later. Without JavaScript no offset is
 * sent and the value is read as UTC, which is exactly what the hint under the field then says.
 */
export function TimeField({
  name,
  label,
  required = false,
  value,
  help
}: {
  name: string;
  label: string;
  required?: boolean;
  /** The instant to start from, as an ISO string. Rendered as UTC, moved to the reader's clock once the page runs. */
  value?: string;
  help?: string;
}) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const [local, setLocal] = useState(value ? value.slice(0, 16) : '');
  const [zone, setZone] = useState<string | null>(null);

  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'your time zone');
    if (value) setLocal(localWallClock(new Date(value)));
  }, [value]);

  const offset = zone === null ? null : offsetAt(local || new Date().toISOString().slice(0, 16));
  const utcEcho = zone !== null && local && offset !== null ? inUtc(local, offset) : null;

  // The hint is a description, not part of the field's name: "Starts at" stays the name a person and a test both use.
  return <div className="field">
    <label htmlFor={inputId}>{label}</label>
    <input
      id={inputId}
      aria-describedby={hintId}
      type="datetime-local"
      name={name}
      required={required}
      value={local}
      onChange={(event) => setLocal(event.target.value)}
    />
    {offset !== null && <input type="hidden" name={`${name}_offset`} value={String(offset)} />}
    <small id={hintId}>
      {help ? `${help} ` : ''}
      {zone === null || offset === null
        ? 'Read as UTC.'
        : utcEcho
          ? `${zone} (${offsetLabel(offset)}) · ${utcEcho} UTC`
          : `${zone} (${offsetLabel(offset)})`}
    </small>
  </div>;
}
