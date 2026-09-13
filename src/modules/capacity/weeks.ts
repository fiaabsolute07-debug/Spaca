/**
 * Week bucket boundaries in a creator's IANA timezone (master §6.5): weeks start Monday 00:00 local
 * time and are materialized as UTC instants. DST weeks are 167 or 169 hours. If local midnight does
 * not exist (a DST gap at 00:00), the week starts at the first valid local instant of that Monday.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let existing = formatters.get(timeZone);
  if (!existing) {
    existing = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, existing);
  }
  return existing;
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localParts(timeZone: string, instant: number): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second! };
}

/** Local wall clock minus UTC, in milliseconds, at `instant`. */
function offsetMs(timeZone: string, instant: number): number {
  const p = localParts(timeZone, instant);
  const flooredToSecond = Math.floor(instant / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - flooredToSecond;
}

const sameLocalMidnight = (p: LocalParts, year: number, month: number, day: number) =>
  p.year === year && p.month === month && p.day === day && p.hour === 0 && p.minute === 0 && p.second === 0;

const localDateKey = (p: LocalParts) => p.year * 10000 + p.month * 100 + p.day;

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  if (timeZone === 'UTC') return true;
  try {
    // ICU throws RangeError for unknown zones; aliases (e.g. Asia/Ho_Chi_Minh → Asia/Saigon) are valid.
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** UTC instant of local 00:00 on the given calendar date (earliest occurrence; first valid instant after a gap). */
export function zonedMidnightToUtc(timeZone: string, year: number, month: number, day: number): number {
  const wall = Date.UTC(year, month - 1, day, 0, 0, 0);
  const candidates = [wall - offsetMs(timeZone, wall - 12 * 3600_000), wall - offsetMs(timeZone, wall + 12 * 3600_000), wall - offsetMs(timeZone, wall)]
    .filter((instant) => sameLocalMidnight(localParts(timeZone, instant), year, month, day));
  if (candidates.length > 0) return Math.min(...candidates);

  // Gap: midnight does not exist. Find the first instant whose local date is the target date.
  const target = year * 10000 + month * 100 + day;
  let lo = wall - 16 * 3600_000;
  let hi = wall + 16 * 3600_000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2 / 1000) * 1000;
    if (localDateKey(localParts(timeZone, mid)) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

export type WeekWindow = { startsAt: Date; endsAt: Date; localWeekStart: string };

const isoDate = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** `count` consecutive local weeks, starting with the week that contains `from`. Contiguous and non-overlapping. */
export function weekWindows(timeZone: string, from: Date, count: number): WeekWindow[] {
  if (!isValidTimeZone(timeZone)) throw new Error(`invalid time zone: ${timeZone}`);
  if (!Number.isInteger(count) || count < 1 || count > 104) throw new Error('week count must be 1..104');
  const local = localParts(timeZone, from.getTime());
  // Calendar arithmetic on the local date only (UTC Date used as a plain calendar).
  const calendar = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const daysSinceMonday = (calendar.getUTCDay() + 6) % 7;
  calendar.setUTCDate(calendar.getUTCDate() - daysSinceMonday);

  const starts: { instant: number; label: string }[] = [];
  for (let i = 0; i <= count; i++) {
    const y = calendar.getUTCFullYear();
    const m = calendar.getUTCMonth() + 1;
    const d = calendar.getUTCDate();
    starts.push({ instant: zonedMidnightToUtc(timeZone, y, m, d), label: isoDate(y, m, d) });
    calendar.setUTCDate(calendar.getUTCDate() + 7);
  }
  return starts.slice(0, count).map((start, i) => ({
    startsAt: new Date(start.instant),
    endsAt: new Date(starts[i + 1]!.instant),
    localWeekStart: start.label,
  }));
}
