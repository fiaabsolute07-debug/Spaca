/**
 * Shared command contract (master §13). Every mutation is a typed handler that runs inside the
 * command envelope transaction (`src/app/api/commands/route.ts`), which owns authentication, origin
 * checks and idempotency replay.
 */
import type postgres from 'postgres';
import type { Actor } from './auth';

export type Tx = postgres.TransactionSql;
// SQL rows are untyped at the driver boundary; handlers narrow the fields they use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export type CommandResult = { path: string; message: string; id?: string };
export type CommandContext = { tx: Tx; actor: Actor; form: FormData; command: string };
export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>;

/** Error taxonomy from master §13.3 (subset used by implemented commands). */
export type CommandErrorCode =
  | 'INVALID_INPUT'
  | 'DOMAIN_RULE'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'ACCOUNT_SUSPENDED'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_ACCEPTING_ORDERS'
  | 'SLOT_EXPIRED'
  | 'SOLD_OUT'
  | 'BRIEF_INCOMPLETE'
  | 'ORDER_STATE_CONFLICT'
  | 'REVISION_LIMIT_REACHED'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_CHANGED'
  | 'REQUEST_CLOSED'
  | 'BUDGET_EXCEEDED'
  | 'AUCTION_NOT_LIVE'
  | 'AUCTION_ENDED'
  | 'BID_TOO_LOW'
  | 'BUY_NOW_UNAVAILABLE'
  | 'PAYMENT_UNAVAILABLE'
  | 'FEATURE_DISABLED'
  | 'RATE_LIMITED'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'UNSUPPORTED_ASSET';

export class CommandError extends Error {
  constructor(message: string, readonly code: CommandErrorCode = 'INVALID_INPUT') {
    super(message);
    this.name = 'CommandError';
  }
}

/** HTTP status per master §13.1. */
export function statusForCode(code: CommandErrorCode): number {
  switch (code) {
    case 'FORBIDDEN':
    case 'ACCOUNT_SUSPENDED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'VERSION_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
    case 'NOT_ACCEPTING_ORDERS':
    case 'SOLD_OUT':
    case 'ORDER_STATE_CONFLICT':
    case 'QUOTE_CHANGED':
    case 'BUY_NOW_UNAVAILABLE':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'PAYMENT_UNAVAILABLE':
    case 'TEMPORARILY_UNAVAILABLE':
      return 503;
    case 'INVALID_INPUT':
      return 400;
    default:
      return 422;
  }
}

const CONTROL = (char: string) => char.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(char);

export function text(form: FormData, name: string, required = true, maxLength = 12000): string {
  const value = String(form.get(name) ?? '').trim();
  if (required && !value) throw new CommandError(`${name} is required`);
  if (value.length > maxLength) throw new CommandError(`${name} is too long`);
  if ([...value].some(CONTROL)) throw new CommandError(`${name} contains invalid characters`);
  return value;
}

export function integer(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new CommandError(`${name} must be a whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new CommandError(`${name} is out of range`);
  return parsed;
}

/** Decimal USD string → integer minor units. No floating point. */
export function money(value: string, name: string): bigint {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new CommandError(`${name} must be a positive USD amount`);
  const [whole = '0', fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (minor <= 0n || minor > 100000000000n) throw new CommandError(`${name} is out of range`);
  return minor;
}

/** `datetime-local` value interpreted as UTC (the UI submits UTC wall-clock values). */
export function instant(value: string, name: string): Date {
  const date = new Date(`${value}Z`);
  if (!value || Number.isNaN(date.getTime())) throw new CommandError(`${name} must be a valid date`);
  return date;
}

export function httpUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CommandError(`${name} must be a valid http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new CommandError(`${name} must start with http:// or https://`);
  return parsed.toString();
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(form: FormData, name: string): string {
  const value = text(form, name);
  if (!UUID_PATTERN.test(value)) throw new CommandError(`${name} is invalid`, 'NOT_FOUND');
  return value.toLowerCase();
}

/** Optional expected aggregate version (optimistic concurrency, §13.1). */
export function expectedVersion(form: FormData, name = 'expected_version'): number | null {
  const value = String(form.get(name) ?? '').trim();
  if (!value) return null;
  return integer(value, name, 1, 2_147_483_647);
}

export async function orderEvent(tx: Tx, orderId: string, actorId: string | null, kind: string, payload: Record<string, unknown> = {}) {
  await tx`insert into app.order_events (order_id,actor_id,kind,payload) values (${orderId},${actorId},${kind},${JSON.stringify(payload)}::jsonb)`;
}
