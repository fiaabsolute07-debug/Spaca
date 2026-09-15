/**
 * REQ-11: the buyer's comparison view of applications. Sorting and filtering only reorder what the buyer sees; nothing
 * here ranks, scores or selects a creator. An offer is always the buyer's explicit action.
 */
export const APPLICATION_SORTS = {
  received: 'Received first',
  quote_low: 'Lowest quote',
  quote_high: 'Highest quote',
  turnaround: 'Fastest delivery',
  updated: 'Recently updated',
} as const;
export type ApplicationSort = keyof typeof APPLICATION_SORTS;

export const APPLICATION_FILTERS = {
  all: 'All',
  SUBMITTED: 'Waiting for you',
  OFFERED: 'Offer sent',
  ACCEPTED: 'Hired',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn',
} as const;
export type ApplicationFilter = keyof typeof APPLICATION_FILTERS;

type Comparable = { id?: unknown; status?: unknown; quote_minor?: unknown; turnaround_hours?: unknown; created_at?: unknown; updated_at?: unknown };

export const parseSort = (value: unknown): ApplicationSort => (typeof value === 'string' && Object.hasOwn(APPLICATION_SORTS, value) ? value as ApplicationSort : 'received');
export const parseFilter = (value: unknown): ApplicationFilter => (typeof value === 'string' && Object.hasOwn(APPLICATION_FILTERS, value) ? value as ApplicationFilter : 'all');

const time = (value: unknown) => (value instanceof Date ? value.getTime() : new Date(String(value ?? '')).getTime()) || 0;
const minor = (value: unknown): bigint => {
  try { return BigInt(String(value ?? '0')); } catch { return 0n; }
};
const byAmount = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

export function compareApplications<T extends Comparable>(items: readonly T[], sort: ApplicationSort, filter: ApplicationFilter): T[] {
  const shown = filter === 'all' ? [...items] : items.filter((item) => item.status === filter);
  const received = (a: T, b: T) => time(a.created_at) - time(b.created_at) || String(a.id).localeCompare(String(b.id));
  const order: Record<ApplicationSort, (a: T, b: T) => number> = {
    received,
    quote_low: (a, b) => byAmount(minor(a.quote_minor), minor(b.quote_minor)) || received(a, b),
    quote_high: (a, b) => byAmount(minor(b.quote_minor), minor(a.quote_minor)) || received(a, b),
    turnaround: (a, b) => Number(a.turnaround_hours) - Number(b.turnaround_hours) || received(a, b),
    updated: (a, b) => time(b.updated_at) - time(a.updated_at) || received(a, b),
  };
  return shown.sort(order[sort]);
}

/** Range of quotes and the median delivery time across applications that are not withdrawn. */
export function quoteSummary(items: readonly Comparable[]): { count: number; lowestMinor: bigint; highestMinor: bigint; medianTurnaroundHours: number } | null {
  const active = items.filter((item) => item.status !== 'WITHDRAWN');
  if (!active.length) return null;
  const quotes = active.map((item) => minor(item.quote_minor)).sort(byAmount);
  const hours = active.map((item) => Number(item.turnaround_hours)).sort((a, b) => a - b);
  const middle = Math.floor(hours.length / 2);
  const median = hours.length % 2 ? hours[middle]! : (hours[middle - 1]! + hours[middle]!) / 2;
  return { count: active.length, lowestMinor: quotes[0]!, highestMinor: quotes[quotes.length - 1]!, medianTurnaroundHours: median };
}

/** One CSV cell: always quoted, and a value a spreadsheet would run as a formula is prefixed with an apostrophe. */
export function csvCell(value: unknown): string {
  let text = value instanceof Date ? value.toISOString() : value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const usd = (value: unknown) => {
  const amount = minor(value);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
};

export const APPLICATION_CSV_COLUMNS = ['creator', 'handle', 'status', 'quote_usd', 'turnaround_hours', 'quote_version', 'valid_until', 'offer_status', 'received_at', 'updated_at', 'note'] as const;

export function applicationsCsv(rows: readonly Record<string, unknown>[]): string {
  const lines = rows.map((row) => [row.creator_name, row.creator_handle, row.status, usd(row.quote_minor), row.turnaround_hours, row.version, row.valid_until, row.offer_status, row.created_at, row.updated_at, row.note].map(csvCell).join(','));
  return [APPLICATION_CSV_COLUMNS.join(','), ...lines].join('\r\n') + '\r\n';
}
