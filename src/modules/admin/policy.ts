/**
 * Operator authorization, audit and feature flags (master §2.1, §4.1, §14.3).
 * Privileged roles come only from app.user_roles grants resolved server-side into Actor.roles.
 */
import type postgres from 'postgres';
import type { Actor } from '@/lib/auth';
import { CommandError, text, type Row, type Tx } from '@/lib/commands';
import { PAYMENTS_CLOSED_MESSAGE, paymentsOpen } from '@/lib/environment';

export type PrivilegedRole = 'moderator' | 'finance' | 'support' | 'admin';
export const PRIVILEGED_ROLES: readonly PrivilegedRole[] = ['moderator', 'finance', 'support', 'admin'];

export function hasAnyRole(actor: Actor, roles: readonly PrivilegedRole[]): boolean {
  return roles.some((role) => actor.roles.includes(role));
}

export function requireRole(actor: Actor, roles: readonly PrivilegedRole[], action: string): void {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot perform operator actions', 'ACCOUNT_SUSPENDED');
  if (!hasAnyRole(actor, roles)) throw new CommandError(`${action} requires one of: ${roles.join(', ')}`, 'FORBIDDEN');
}

/** Every privileged action needs a written reason (§14.3). */
export function reasonOf(form: FormData): string {
  const reason = text(form, 'reason', true, 2000);
  if (reason.length < 10) throw new CommandError('Give a reason of at least 10 characters for the audit log');
  return reason;
}

/** Append-only audit entry in the same transaction as the change (DB trigger forbids update/delete). */
export async function audit(
  tx: Tx,
  actor: Actor | null,
  action: string,
  entityType: string,
  entityId: string | null,
  reason: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx`insert into app.audit_log (actor_id,actor_roles,action,entity_type,entity_id,reason,before_state,after_state)
    values (${actor?.id ?? null},${actor ? actor.roles : []},${action},${entityType},${entityId},${reason},
      ${before === undefined ? null : JSON.stringify(before)}::jsonb,${after === undefined ? null : JSON.stringify(after)}::jsonb)`;
}

export type FeatureFlagKey =
  | 'BOOKING_ENABLED'
  | 'REQUESTS_ENABLED'
  | 'AUCTIONS_ENABLED'
  | 'CRYPTO_CHECKOUT_ENABLED'
  | 'TOKEN_REWARDS_ENABLED'
  | 'NFT_REWARDS_ENABLED'
  | 'DISCOVERY_ADVANCED_ENABLED'
  | 'ACCESS_BOOKING_ENABLED'
  | 'DIGITAL_PRODUCTS_ENABLED'
  | 'BANK_FUNDING_ENABLED'
  | 'PERFORMANCE_CAMPAIGNS_ENABLED'
  | 'LIVE_PAYMENTS_ENABLED'
  | 'CHECKOUT_CREATION_ENABLED'
  | 'BIDDING_ENABLED'
  | 'PAYOUT_CREATION_ENABLED';

/** Switches that move money; with PAYMENT_MODE=off they read as off whatever the table says. */
const MONEY_FLAGS: ReadonlySet<FeatureFlagKey> = new Set<FeatureFlagKey>(['CHECKOUT_CREATION_ENABLED', 'BIDDING_ENABLED', 'PAYOUT_CREATION_ENABLED', 'BANK_FUNDING_ENABLED', 'CRYPTO_CHECKOUT_ENABLED', 'LIVE_PAYMENTS_ENABLED']);

/** A missing flag row is treated as disabled (fail closed). */
export async function isFlagEnabled(db: Tx | postgres.Sql, key: FeatureFlagKey): Promise<boolean> {
  if (!paymentsOpen() && MONEY_FLAGS.has(key)) return false;
  const [flag] = await db<Row[]>`select enabled from app.feature_flags where key=${key}`;
  return flag?.enabled === true;
}

/** Blocks new activity when a flag or kill switch is off. Reads, refunds, webhooks and reconciliation never call this. */
export async function assertFlags(tx: Tx, keys: readonly FeatureFlagKey[]): Promise<void> {
  if (!paymentsOpen() && keys.some((key) => MONEY_FLAGS.has(key))) throw new CommandError(PAYMENTS_CLOSED_MESSAGE, 'FEATURE_DISABLED');
  const rows = await tx<Row[]>`select key,enabled from app.feature_flags where key = any(${keys as FeatureFlagKey[]})`;
  const off = keys.filter((key) => rows.find((r) => r.key === key)?.enabled !== true);
  if (off.length > 0) throw new CommandError(`This action is temporarily unavailable (${off.join(', ')})`, 'FEATURE_DISABLED');
}
