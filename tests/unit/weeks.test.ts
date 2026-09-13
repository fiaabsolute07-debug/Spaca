import { describe, expect, it } from 'vitest';
import { isValidTimeZone, weekWindows, zonedMidnightToUtc } from '../../src/modules/capacity/weeks';

const hours = (w: { startsAt: Date; endsAt: Date }) => (w.endsAt.getTime() - w.startsAt.getTime()) / 3600_000;
const localLabel = (tz: string, d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

describe('CAP-08 — week buckets in creator timezone', () => {
  it('UTC weeks start Monday 00:00Z and last 168h', () => {
    const [w] = weekWindows('UTC', new Date('2026-09-16T15:00:00Z'), 1);
    expect(w).toEqual({ startsAt: new Date('2026-09-14T00:00:00Z'), endsAt: new Date('2026-09-21T00:00:00Z'), localWeekStart: '2026-09-14' });
  });

  it('Europe/Berlin spring-forward week is 167h and fall-back week is 169h, both starting Monday 00:00 local', () => {
    const spring = weekWindows('Europe/Berlin', new Date('2026-03-25T12:00:00Z'), 1)[0]!;
    expect(spring.localWeekStart).toBe('2026-03-23');
    expect(spring.startsAt.toISOString()).toBe('2026-03-22T23:00:00.000Z');
    expect(hours(spring)).toBe(167);
    const autumn = weekWindows('Europe/Berlin', new Date('2026-10-21T12:00:00Z'), 1)[0]!;
    expect(autumn.localWeekStart).toBe('2026-10-19');
    expect(hours(autumn)).toBe(169);
    for (const w of [spring, autumn]) expect(localLabel('Europe/Berlin', w.startsAt)).toBe('Mon 00:00');
  });

  it('a year of weeks is contiguous, non-overlapping and always starts on local Monday', () => {
    for (const tz of ['Europe/Berlin', 'America/New_York', 'Asia/Ho_Chi_Minh', 'Australia/Lord_Howe', 'America/Santiago', 'Pacific/Chatham']) {
      const windows = weekWindows(tz, new Date('2026-01-01T00:00:00Z'), 60);
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i]!;
        expect(w.endsAt.getTime()).toBeGreaterThan(w.startsAt.getTime());
        expect([167, 167.5, 168, 168.5, 169]).toContain(hours(w));
        if (i > 0) expect(w.startsAt.getTime()).toBe(windows[i - 1]!.endsAt.getTime());
        expect(localLabel(tz, w.startsAt).startsWith('Mon')).toBe(true);
      }
    }
  });

  it('handles a DST gap at local midnight by starting at the first valid instant', () => {
    // America/Havana springs forward at 00:00 → 01:00 on 2026-03-08 (a Sunday); build the midnight directly.
    const instant = zonedMidnightToUtc('America/Havana', 2026, 3, 8);
    const label = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
    expect(label).toBe('08/03/2026, 01:00');
    const before = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Havana', day: '2-digit', hourCycle: 'h23' }).format(new Date(instant - 1000));
    expect(before).toBe('07');
  });

  it('picks the earliest occurrence when midnight repeats (fall-back at 00:00)', () => {
    // America/Havana falls back 01:00 → 00:00 on 2026-11-01; 00:00 local occurs twice.
    const instant = zonedMidnightToUtc('America/Havana', 2026, 11, 1);
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    expect(hour.format(new Date(instant))).toBe('00:00');
    expect(hour.format(new Date(instant - 3600_000))).toBe('23:00');
  });

  it('a timezone change keeps instants absolute: old week and new week are different ranges', () => {
    const from = new Date('2026-09-16T12:00:00Z');
    const [utc] = weekWindows('UTC', from, 1);
    const [hcm] = weekWindows('Asia/Ho_Chi_Minh', from, 1);
    expect(hcm!.startsAt.toISOString()).toBe('2026-09-13T17:00:00.000Z');
    expect(utc!.startsAt.getTime() - hcm!.startsAt.getTime()).toBe(7 * 3600_000);
  });

  it('validates IANA names', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(() => weekWindows('Nope/Zone', new Date(), 1)).toThrowError(/invalid time zone/);
  });
});
