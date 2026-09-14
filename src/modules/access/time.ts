/**
 * ACCESS scheduling time rules (master §6.5, XPL-03). Creators publish weekly availability in their own IANA time
 * zone; sessions are stored as UTC instants. A local time that does not exist (DST gap) offers no slot; an ambiguous
 * local time (DST overlap) uses its first occurrence. Changing a time zone never moves booked instants.
 */
import { isValidTimeZone, localParts, offsetMs } from '@/modules/capacity/weeks';

export const SLOT_STEP_MINUTES = 15;
export const ACCESS_MIN_NOTICE_HOURS = 12;
export const ACCESS_HORIZON_DAYS = 60;

export type AvailabilityWindow = { weekday: number; startMinute: number; endMinute: number };

/** UTC instant of a local wall-clock minute, or null when that local time does not exist in the zone. */
export function localMinuteToUtc(timeZone: string, year: number, month: number, day: number, minuteOfDay: number): number | null {
  const wall = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0);
  const candidates = [...new Set([wall - offsetMs(timeZone, wall - 12 * 3600_000), wall - offsetMs(timeZone, wall + 12 * 3600_000), wall - offsetMs(timeZone, wall)])]
    .filter((instant) => {
      const p = localParts(timeZone, instant);
      return p.year === year && p.month === month && p.day === day && p.hour * 60 + p.minute === minuteOfDay && p.second === 0;
    });
  return candidates.length ? Math.min(...candidates) : null;
}

/** ISO weekday (Monday = 1 … Sunday = 7) of a calendar date. */
function isoWeekday(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function parseClock(value: string): number {
  const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new Error('Times use HH:MM');
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes > 1440) throw new Error('Times end at 24:00');
  return minutes;
}

export function validateWindows(windows: AvailabilityWindow[]): void {
  if (windows.length > 50) throw new Error('At most 50 availability windows');
  for (const w of windows) {
    if (!Number.isInteger(w.weekday) || w.weekday < 1 || w.weekday > 7) throw new Error('Weekday must be 1 (Monday) to 7 (Sunday)');
    if (!Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute) || w.startMinute < 0 || w.endMinute > 1440 || w.endMinute <= w.startMinute) throw new Error('Each window must end after it starts, within one day');
  }
  const byDay = new Map<number, AvailabilityWindow[]>();
  for (const w of windows) byDay.set(w.weekday, [...(byDay.get(w.weekday) ?? []), w]);
  for (const list of byDay.values()) {
    const sorted = [...list].sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.startMinute < sorted[i - 1]!.endMinute) throw new Error('Windows on the same day must not overlap');
  }
}

/**
 * Candidate session starts (UTC ms) within the creator's windows between `from` and `from + days`, on the 15-minute
 * grid of local time, where the whole session fits inside one window. Booked ranges are removed by the caller.
 */
export function candidateStarts(input: { timeZone: string; windows: AvailabilityWindow[]; sessionMinutes: number; from: Date; days: number; now?: Date }): number[] {
  if (!isValidTimeZone(input.timeZone)) throw new Error('invalid time zone');
  const now = (input.now ?? new Date()).getTime();
  const earliest = Math.max(input.from.getTime(), now + ACCESS_MIN_NOTICE_HOURS * 3600_000);
  const latest = Math.min(input.from.getTime() + input.days * 86_400_000, now + ACCESS_HORIZON_DAYS * 86_400_000);
  const starts: number[] = [];
  const start = localParts(input.timeZone, input.from.getTime());
  const calendar = new Date(Date.UTC(start.year, start.month - 1, start.day));
  for (let i = 0; i <= input.days + 1; i++) {
    const y = calendar.getUTCFullYear();
    const m = calendar.getUTCMonth() + 1;
    const d = calendar.getUTCDate();
    const weekday = isoWeekday(y, m, d);
    for (const window of input.windows.filter((w) => w.weekday === weekday)) {
      for (let minute = Math.ceil(window.startMinute / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES; minute < window.endMinute; minute += SLOT_STEP_MINUTES) {
        const instant = localMinuteToUtc(input.timeZone, y, m, d, minute);
        if (instant === null) continue; // local time skipped by a DST gap
        // Sessions last real elapsed minutes; the local wall time at the end must still be inside the window that day.
        const endInstant = instant + input.sessionMinutes * 60_000;
        const end = localParts(input.timeZone, endInstant);
        const endMinute = end.year === y && end.month === m && end.day === d ? end.hour * 60 + end.minute : end.hour === 0 && end.minute === 0 ? 1440 : Number.POSITIVE_INFINITY;
        if (endMinute > window.endMinute || endMinute <= minute - 60) continue;
        if (instant >= earliest && instant <= latest) starts.push(instant);
      }
    }
    calendar.setUTCDate(calendar.getUTCDate() + 1);
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

/** True when `startsAt` is one of the offered starts for its local day (same rules as candidateStarts). */
export function isOfferedStart(input: { timeZone: string; windows: AvailabilityWindow[]; sessionMinutes: number; startsAt: Date; now?: Date }): boolean {
  const day = new Date(input.startsAt.getTime() - 36 * 3600_000);
  return candidateStarts({ timeZone: input.timeZone, windows: input.windows, sessionMinutes: input.sessionMinutes, from: day, days: 3, now: input.now }).includes(input.startsAt.getTime());
}
