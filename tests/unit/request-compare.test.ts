import { describe, expect, it } from 'vitest';
import { applicationsCsv, compareApplications, csvCell, parseFilter, parseSort, quoteSummary } from '@/modules/requests/compare';

const apps = [
  { id: 'a', status: 'SUBMITTED', quote_minor: '15000', turnaround_hours: 48, created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-12T10:00:00Z' },
  { id: 'b', status: 'OFFERED', quote_minor: '9000', turnaround_hours: 72, created_at: '2026-09-11T10:00:00Z', updated_at: '2026-09-11T10:00:00Z' },
  { id: 'c', status: 'SUBMITTED', quote_minor: '9000', turnaround_hours: 24, created_at: '2026-09-12T10:00:00Z', updated_at: '2026-09-13T10:00:00Z' },
  { id: 'd', status: 'WITHDRAWN', quote_minor: '100', turnaround_hours: 1, created_at: '2026-09-09T10:00:00Z', updated_at: '2026-09-14T10:00:00Z' },
];
const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe('REQ-11 — comparison controls reorder the view and never pick anyone', () => {
  it('sorts by received time, quote (ties by received time), delivery time and last update', () => {
    expect(ids(compareApplications(apps, 'received', 'all'))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(compareApplications(apps, 'quote_low', 'all'))).toEqual(['d', 'b', 'c', 'a']);
    expect(ids(compareApplications(apps, 'quote_high', 'all'))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(compareApplications(apps, 'turnaround', 'all'))).toEqual(['d', 'c', 'a', 'b']);
    expect(ids(compareApplications(apps, 'updated', 'all'))).toEqual(['d', 'c', 'a', 'b']);
  });

  it('filters by status without changing the input, and falls back to safe defaults for unknown parameters', () => {
    expect(ids(compareApplications(apps, 'quote_low', 'SUBMITTED'))).toEqual(['c', 'a']);
    expect(ids(apps)).toEqual(['a', 'b', 'c', 'd']);
    expect([parseSort('quote_low'), parseSort('toString'), parseSort(['x']), parseSort(undefined)]).toEqual(['quote_low', 'received', 'received', 'received']);
    expect([parseFilter('OFFERED'), parseFilter('__proto__'), parseFilter('offered')]).toEqual(['OFFERED', 'all', 'all']);
  });

  it('summarizes quotes and median delivery across applications that are not withdrawn', () => {
    expect(quoteSummary(apps)).toEqual({ count: 3, lowestMinor: 9000n, highestMinor: 15000n, medianTurnaroundHours: 48 });
    expect(quoteSummary(apps.slice(0, 2))).toMatchObject({ medianTurnaroundHours: 60 });
    expect(quoteSummary([apps[3]!])).toBeNull();
  });

  it('exports CSV with every cell quoted and spreadsheet formulas neutralized', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell(null)).toBe('""');
    const csv = applicationsCsv([{ creator_name: 'Ari, "the writer"', creator_handle: '@ari', status: 'SUBMITTED', quote_minor: '12345', turnaround_hours: 24, version: 2, valid_until: new Date('2026-09-20T00:00:00Z'), offer_status: null, created_at: '2026-09-10', updated_at: '2026-09-11', note: 'line one\nline two' }]);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe('creator,handle,status,quote_usd,turnaround_hours,quote_version,valid_until,offer_status,received_at,updated_at,note');
    expect(row).toContain('"Ari, ""the writer"""');
    expect(row).toContain(`"'@ari"`);
    expect(row).toContain('"123.45"');
    expect(row).toContain('"2026-09-20T00:00:00.000Z"');
    expect(csv).toContain('"line one\nline two"');
  });
});
