import { describe, expect, it } from 'vitest';
import { candidateStarts, isOfferedStart, localMinuteToUtc, validateWindows } from '../../src/modules/access/time';

const iso = (ms: number) => new Date(ms).toISOString();

describe('XPL-03 ACCESS time rules', () => {
  it('converts local wall time to UTC across DST: gap has no instant, overlap uses the first occurrence', () => {
    // New York: 2026-03-08 02:30 does not exist; 2026-11-01 01:30 happens twice (EDT first, then EST).
    expect(localMinuteToUtc('America/New_York', 2026, 3, 8, 150)).toBeNull();
    expect(iso(localMinuteToUtc('America/New_York', 2026, 3, 8, 180)!)).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(localMinuteToUtc('America/New_York', 2026, 11, 1, 90)!)).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(localMinuteToUtc('Asia/Ho_Chi_Minh', 2026, 9, 15, 540)!)).toBe('2026-09-15T02:00:00.000Z');
  });

  it('offers slots on a 15-minute grid inside windows by elapsed session length, skipping local times removed by a DST gap', () => {
    const now = new Date('2026-03-06T00:00:00Z');
    // Sunday 2026-03-08 01:00–04:00 local in New York, 60-minute sessions.
    const starts = candidateStarts({ timeZone: 'America/New_York', windows: [{ weekday: 7, startMinute: 60, endMinute: 240 }], sessionMinutes: 60, from: new Date('2026-03-08T00:00:00Z'), days: 1, now }).map(iso);
    // 01:00–01:45 EST (06:00–06:45Z) end at 03:00–03:45 EDT inside the window; 02:xx does not exist; 03:00 EDT (07:00Z) ends 04:00.
    expect(starts).toEqual(['2026-03-08T06:00:00.000Z', '2026-03-08T06:15:00.000Z', '2026-03-08T06:30:00.000Z', '2026-03-08T06:45:00.000Z', '2026-03-08T07:00:00.000Z']);
  });

  it('does not offer the repeated hour twice on the day clocks go back', () => {
    const now = new Date('2026-10-28T00:00:00Z');
    const starts = candidateStarts({ timeZone: 'America/New_York', windows: [{ weekday: 7, startMinute: 60, endMinute: 180 }], sessionMinutes: 30, from: new Date('2026-11-01T00:00:00Z'), days: 1, now }).map(iso);
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts[0]).toBe('2026-11-01T05:00:00.000Z');
  });

  it('respects the minimum notice and the booking horizon, and validates windows', () => {
    const now = new Date('2026-09-15T00:00:00Z');
    const windows = [{ weekday: 2, startMinute: 0, endMinute: 1440 }];
    const soon = candidateStarts({ timeZone: 'UTC', windows, sessionMinutes: 30, from: now, days: 1, now });
    expect(Math.min(...soon)).toBeGreaterThanOrEqual(now.getTime() + 12 * 3600_000);
    expect(isOfferedStart({ timeZone: 'UTC', windows, sessionMinutes: 30, startsAt: new Date('2026-09-15T13:00:00Z'), now })).toBe(true);
    expect(isOfferedStart({ timeZone: 'UTC', windows, sessionMinutes: 30, startsAt: new Date('2026-09-15T13:05:00Z'), now })).toBe(false);
    expect(isOfferedStart({ timeZone: 'UTC', windows, sessionMinutes: 30, startsAt: new Date('2026-09-15T06:00:00Z'), now })).toBe(false);
    expect(() => validateWindows([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 700, endMinute: 800 }])).toThrow(/overlap/);
    expect(() => validateWindows([{ weekday: 8, startMinute: 0, endMinute: 60 }])).toThrow(/Weekday/);
  });
});
