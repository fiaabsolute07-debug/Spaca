import { describe, expect, it } from 'vitest';
import { parseRange } from '../../src/modules/storage/range';

describe('byte ranges let a work-sample video play and seek', () => {
  it('reads the windows a media player actually sends', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=200-499', 1000)).toEqual({ start: 200, end: 499 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-300', 1000)).toEqual({ start: 700, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('treats anything it does not understand as no range, so the whole file is served', () => {
    for (const header of [null, '', 'bytes=', 'items=0-10', 'bytes=0-10, 20-30', 'bytes=abc-def']) {
      expect(parseRange(header, 1000)).toBeNull();
    }
    expect(parseRange('bytes=0-10', 0)).toBeNull();
  });

  it('refuses a window that starts past the end instead of answering with the wrong bytes', () => {
    expect(parseRange('bytes=1000-1200', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=500-200', 1000)).toBe('unsatisfiable');
  });
});
