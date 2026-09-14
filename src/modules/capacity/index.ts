/**
 * Capacity engine (master §6): one active-order limit per creator, shared by every service. Counters are
 * maintained by DB triggers from claim state (drizzle/0012), and the claim INSERT trigger refuses a claim above
 * the limit or while the creator paused new orders. Application code (1) locks the workload row before
 * claiming so callers get a clear error, (2) inserts HELD claims, and (3) activates them on funding.
 * Orders free their units in the order status trigger (APPROVED/COMPLETED → DONE, CANCELLED/REFUNDED → RELEASED).
 * Lock order (§6.4): aggregate (request/auction) → creator workload → order.
 */
import { CommandError, type Row, type Tx } from '@/lib/commands';
import type { Actor } from '@/lib/auth';

type Queryable = Tx | import('postgres').Sql;

export const DEFAULT_MAX_ACTIVE_UNITS = 3;
export const MAX_ACTIVE_UNITS_LIMIT = 100;

export type ClaimOrigin = 'BOOK' | 'OFFER' | 'AUCTION';
export type AvailabilityStatus = 'ACCEPTING' | 'AT_CAPACITY' | 'PAUSED';

/** Locks (creating on first use) the creator's workload row. */
export async function lockWorkload(tx: Tx, creatorId: string): Promise<Row> {
  await tx`insert into app.creator_workloads (creator_id) values (${creatorId}) on conflict (creator_id) do nothing`;
  const [workload] = await tx<Row[]>`select * from app.creator_workloads where creator_id=${creatorId} for update`;
  return workload!;
}

export function availabilityOf(workload: Row | undefined, units = 1): AvailabilityStatus {
  if (!workload) return 'ACCEPTING';
  if (workload.accepting_orders === false) return 'PAUSED';
  return Number(workload.held_units) + Number(workload.active_units) + units <= Number(workload.max_active_units) ? 'ACCEPTING' : 'AT_CAPACITY';
}

/**
 * Holds `units` of the creator's limit for a checkout, hire or auction (CAP-01/02/08). The caller already holds
 * any aggregate lock (request, auction) and has not locked an order yet.
 */
export async function claimWorkload(
  tx: Tx,
  input: { creatorId: string; units: number; origin: ClaimOrigin; orderId?: string; auctionId?: string; expiresAt: Date | null },
): Promise<Row> {
  const workload = await lockWorkload(tx, input.creatorId);
  const status = availabilityOf(workload, input.units);
  if (status === 'PAUSED') throw new CommandError('This creator paused new orders', 'NOT_ACCEPTING_ORDERS');
  if (status === 'AT_CAPACITY') throw new CommandError('This creator is at capacity right now. Post a request or check back later.', 'CAPACITY_UNAVAILABLE');
  const [claim] = await tx<Row[]>`insert into app.workload_claims (creator_id,units,origin,order_id,auction_id,state,expires_at)
    values (${input.creatorId},${input.units},${input.origin},${input.orderId ?? null},${input.auctionId ?? null},'HELD',${input.expiresAt?.toISOString() ?? null})
    returning *`;
  return claim!;
}

/** Funding confirmed: HELD/EXPIRY_RECONCILING → ACTIVE. Returns false if there was no claim to activate. */
export async function activateOrderClaim(tx: Tx, orderId: string): Promise<boolean> {
  const [claim] = await tx<Row[]>`select id,state from app.workload_claims where order_id=${orderId} for update`;
  if (!claim || !['HELD', 'EXPIRY_RECONCILING'].includes(String(claim.state))) return false;
  await tx`update app.workload_claims set state='ACTIVE',expires_at=null where id=${String(claim.id)}`;
  return true;
}

/** An auction that ends without a sale (no bids, cancelled) frees its held units. */
export async function releaseAuctionClaim(tx: Tx, auctionId: string): Promise<'RELEASED' | 'NONE'> {
  const [claim] = await tx<Row[]>`select id,state from app.workload_claims where auction_id=${auctionId} for update`;
  if (!claim || !['HELD', 'EXPIRY_RECONCILING'].includes(String(claim.state))) return 'NONE';
  await tx`update app.workload_claims set state='RELEASED' where id=${String(claim.id)}`;
  return 'RELEASED';
}

/** CAP-07: any limit from 1 up; lowering it never cancels work already accepted, it only blocks new claims. */
export async function setMaxActiveUnits(tx: Tx, actor: Actor, maxActiveUnits: number): Promise<Row> {
  await lockWorkload(tx, actor.id);
  const [updated] = await tx<Row[]>`update app.creator_workloads set max_active_units=${maxActiveUnits},version=version+1,updated_at=now()
    where creator_id=${actor.id} returning *`;
  return updated!;
}

/** CAP-08: pausing blocks new claims immediately; running orders and auctions continue. */
export async function setAcceptingOrders(tx: Tx, actor: Actor, accepting: boolean): Promise<Row> {
  await lockWorkload(tx, actor.id);
  const [updated] = await tx<Row[]>`update app.creator_workloads set accepting_orders=${accepting},version=version+1,updated_at=now()
    where creator_id=${actor.id} returning *`;
  return updated!;
}

/** Read-side workloads without writes; creators without a row use the defaults (accepting, limit 3, nothing held). */
export async function workloadsFor(db: Queryable, creatorIds: string[]): Promise<Map<string, Row>> {
  const ids = [...new Set(creatorIds)];
  const result = new Map<string, Row>();
  if (ids.length === 0) return result;
  const rows = await db<Row[]>`select creator_id,max_active_units,accepting_orders,held_units,active_units,version from app.creator_workloads where creator_id = any(${ids}::uuid[])`;
  for (const row of rows) result.set(String(row.creator_id), row);
  for (const id of ids) {
    if (!result.has(id)) result.set(id, { creator_id: id, max_active_units: DEFAULT_MAX_ACTIVE_UNITS, accepting_orders: true, held_units: 0, active_units: 0, version: 0 });
  }
  return result;
}
