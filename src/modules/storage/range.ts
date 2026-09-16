/**
 * HTTP byte ranges, which is how a video element asks for the part of a file it needs before it will play or seek.
 * Only the single `bytes=` window that media players send is understood; anything else counts as no range at all.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!match || size <= 0) return null;
  const [, fromValue = '', toValue = ''] = match;
  if (!fromValue && !toValue) return null;
  const start = fromValue ? Number(fromValue) : Math.max(0, size - Number(toValue));
  const end = fromValue ? (toValue ? Math.min(Number(toValue), size - 1) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}
