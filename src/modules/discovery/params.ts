/**
 * Discovery input handling (P5-01/02): allowlisted filters and sorts, bounded limits, and opaque keyset cursors that
 * are bound to the sort they were issued for. Invalid input is rejected instead of being silently ignored.
 */
import { CommandError, UUID_PATTERN, money } from '@/lib/commands';

export const TAXONOMIES = ['CREATE', 'PUBLISH', 'ACCESS', 'DIGITAL'] as const;
export const SERVICE_SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'turnaround'] as const;
export const CREATOR_SORTS = ['relevance', 'reputation', 'newest'] as const;
export type ServiceSort = (typeof SERVICE_SORTS)[number];
export type CreatorSort = (typeof CREATOR_SORTS)[number];

export type Cursor = { sort: string; keys: (string | null)[]; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.sort, cursor.keys, cursor.id])).toString('base64url');
}

export function decodeCursor(value: string | null, sort: string): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error('shape');
    const [cursorSort, keys, id] = parsed as [unknown, unknown, unknown];
    if (cursorSort !== sort || !Array.isArray(keys) || keys.length > 3 || typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new Error('shape');
    if (!keys.every((key) => key === null || (typeof key === 'string' && key.length <= 64))) throw new Error('keys');
    return { sort: cursorSort, keys: keys as (string | null)[], id };
  } catch {
    throw new CommandError('The page cursor is invalid for this sort; start from the first page');
  }
}

/** Search terms become an AND of prefix matches over letters and digits only (no operator injection). */
export function toPrefixQuery(q: string | null): string | null {
  if (!q) return null;
  const terms = (q.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map((term) => term.slice(0, 40));
  return terms.length ? terms.map((term) => `${term}:*`).join(' & ') : null;
}

function limitOf(params: URLSearchParams, max: number, fallback: number): number {
  const value = params.get('limit');
  if (value === null || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new CommandError(`limit must be between 1 and ${max}`);
  return limit;
}

/** Capacity is an active-order limit, so there is no "free from" date to filter by (§6.1 rule 10). */
function rejectAvailableBefore(params: URLSearchParams) {
  if (params.has('available_before')) throw new CommandError('available_before is not supported; use available=true for creators accepting orders now');
}

export type ServiceSearch = {
  q: string | null; tsquery: string | null; taxonomies: string[]; niche: string | null; priceMinMinor: bigint | null; priceMaxMinor: bigint | null;
  turnaroundMaxHours: number | null; availableOnly: boolean; creatorHandle: string | null; sort: ServiceSort; cursor: Cursor | null; limit: number;
};

export function parseServiceSearch(params: URLSearchParams): ServiceSearch {
  const q = params.get('q')?.trim().slice(0, 120) || null;
  const tsquery = toPrefixQuery(q);
  const taxonomies = (params.get('taxonomy') ?? '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (taxonomies.some((t) => !(TAXONOMIES as readonly string[]).includes(t))) throw new CommandError(`taxonomy must be one of ${TAXONOMIES.join(', ')}`);
  const sort = (params.get('sort') || (tsquery ? 'relevance' : 'newest')) as ServiceSort;
  if (!(SERVICE_SORTS as readonly string[]).includes(sort)) throw new CommandError(`sort must be one of ${SERVICE_SORTS.join(', ')}`);
  if (sort === 'relevance' && !tsquery) throw new CommandError('Relevance sort needs a search query');
  const priceMin = params.get('price_min') ? money(params.get('price_min')!, 'price_min') : null;
  const priceMax = params.get('price_max') ? money(params.get('price_max')!, 'price_max') : null;
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) throw new CommandError('price_min cannot exceed price_max');
  const turnaround = params.get('turnaround_max');
  const turnaroundMaxHours = turnaround ? Number(turnaround) : null;
  if (turnaroundMaxHours !== null && (!Number.isInteger(turnaroundMaxHours) || turnaroundMaxHours < 1 || turnaroundMaxHours > 8760)) throw new CommandError('turnaround_max must be hours between 1 and 8760');
  const niche = params.get('niche')?.trim().slice(0, 80) || null;
  const creatorHandle = params.get('creator')?.trim().toLowerCase() || null;
  if (creatorHandle && !/^[a-z0-9][a-z0-9_-]{2,31}$/.test(creatorHandle)) throw new CommandError('creator must be a creator handle');
  rejectAvailableBefore(params);
  const availableOnly = params.get('available') === 'true';
  return { q, tsquery, taxonomies, niche, priceMinMinor: priceMin, priceMaxMinor: priceMax, turnaroundMaxHours, availableOnly, creatorHandle, sort,
    cursor: decodeCursor(params.get('cursor'), sort), limit: limitOf(params, 48, 24) };
}

export type CreatorSearch = { q: string | null; tsquery: string | null; niche: string | null; taxonomy: string | null; availableOnly: boolean; sort: CreatorSort; cursor: Cursor | null; limit: number };

export function parseCreatorSearch(params: URLSearchParams): CreatorSearch {
  const q = params.get('q')?.trim().slice(0, 120) || null;
  const tsquery = toPrefixQuery(q);
  const taxonomy = params.get('taxonomy')?.trim().toUpperCase() || null;
  if (taxonomy && !(TAXONOMIES as readonly string[]).includes(taxonomy)) throw new CommandError(`taxonomy must be one of ${TAXONOMIES.join(', ')}`);
  const sort = (params.get('sort') || (tsquery ? 'relevance' : 'reputation')) as CreatorSort;
  if (!(CREATOR_SORTS as readonly string[]).includes(sort)) throw new CommandError(`sort must be one of ${CREATOR_SORTS.join(', ')}`);
  if (sort === 'relevance' && !tsquery) throw new CommandError('Relevance sort needs a search query');
  rejectAvailableBefore(params);
  return { q, tsquery, niche: params.get('niche')?.trim().slice(0, 80) || null, taxonomy,
    availableOnly: params.get('available') === 'true', sort, cursor: decodeCursor(params.get('cursor'), sort), limit: limitOf(params, 48, 24) };
}

export function parseEndingSoon(params: URLSearchParams) {
  const within = params.get('within_hours') ? Number(params.get('within_hours')) : 48;
  if (!Number.isInteger(within) || within < 1 || within > 168) throw new CommandError('within_hours must be between 1 and 168');
  return { withinHours: within, cursor: decodeCursor(params.get('cursor'), 'ending_soon'), limit: limitOf(params, 24, 12) };
}
