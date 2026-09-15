/**
 * Server error logs keep what an operator needs to find a failure — error name, code, constraint, table and code
 * frames — and never row data or payload text (SEC-11). A PostgreSQL constraint error carries the whole failing row in
 * `detail` (briefs, emails, amounts), so errors are never logged as raw objects.
 */
type LogIds = Record<string, string | number | boolean | null | undefined>;

/** Quoted values longer than this in a message are treated as data and redacted. */
const QUOTED_VALUE = /"([^"]{41,})"/g;

export function safeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { kind: typeof error };
  const e = error as Error & { code?: unknown; constraint_name?: unknown; table_name?: unknown; routine?: unknown };
  const message = (e.message.split('\n')[0] ?? '').replace(QUOTED_VALUE, '"[redacted]"').slice(0, 240);
  const frames = (e.stack ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('at ')).slice(0, 4);
  return {
    name: e.name,
    message,
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    ...(e.constraint_name ? { constraint: String(e.constraint_name) } : {}),
    ...(e.table_name ? { table: String(e.table_name) } : {}),
    ...(e.routine ? { routine: String(e.routine) } : {}),
    frames,
  };
}

export function logError(context: string, error: unknown, ids: LogIds = {}): void {
  console.error(context, JSON.stringify({ ...ids, error: safeError(error) }));
}
