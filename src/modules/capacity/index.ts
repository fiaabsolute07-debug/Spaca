/**
 * Creator workload (master §6). Decision 2026-09-15: there is no limit on orders at once. Claims count the orders a
 * creator has in checkout (HELD) and in progress (ACTIVE) for their dashboard, and the claim INSERT trigger refuses
 * new claims only while the creator paused new orders (drizzle/0017). Application code (1) locks the workload row
 * before claiming so callers get a clear error, (2) inserts HELD claims, and (3) activates them on funding.
 * Orders free their units in the order status trigger (APPROVED/COMPLETED → DONE, CANCELLED/REFUNDED → RELEASED).
 * Lock order (§6.4): aggregate (request/auction) → creator workload → order.
 */
import { CommandError, type Row, type Tx } from '@/lib/commands';
import type { Actor } from '@/lib/auth';

type Queryable = Tx | import('postgres').Sql;

export type ClaimOrigin = 'BOOK' | 'OFFER' | 'AUCTION';
export type AvailabilityStatus = 'ACCEPTING' | 'PAUSED';

/** Locks (creating on first use) the creator's workload row. */
export async function lockWorkload(tx: Tx, creatorId: string): Promise<Row> {
  await tx`insert into app.creator_workloads (creator_id) values (${creatorId}) on conflict (creator_id) do nothing`;
  const [workload] = await tx<Row[]>`select * from app.creator_workloads where creator_id=${creatorId} for update`;
  return workload!;
}

export function availabilityOf(workload: Row | undefined): AvailabilityStatus {
  return workload?.accepting_orders === false ? 'PAUSED' : 'ACCEPTING';
}

/**
 * Counts `units` for a checkout, hire or auction; refused only while the creator paused new orders (CAP-08). The caller already holds
 * any aggregate lock (request, auction) and has not locked an order yet.
 */
export async function claimWorkload(
  tx: Tx,
  input: { creatorId: string; units: number; origin: ClaimOrigin; orderId?: string; auctionId?: string; expiresAt: Date | null },
): Promise<Row> {
  const workload = await lockWorkload(tx, input.creatorId);
  if (availabilityOf(workload) === 'PAUSED') throw new CommandError('This creator paused new orders', 'NOT_ACCEPTING_ORDERS');
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

/** CAP-08: pausing blocks new claims immediately; running orders and auctions continue. */
export async function setAcceptingOrders(tx: Tx, actor: Actor, accepting: boolean): Promise<Row> {
  await lockWorkload(tx, actor.id);
  const [updated] = await tx<Row[]>`update app.creator_workloads set accepting_orders=${accepting},version=version+1,updated_at=now()
    where creator_id=${actor.id} returning *`;
  return updated!;
}

/** Read-side workloads without writes; creators without a row use the defaults (accepting, nothing held). */
export async function workloadsFor(db: Queryable, creatorIds: string[]): Promise<Map<string, Row>> {
  const ids = [...new Set(creatorIds)];
  const result = new Map<string, Row>();
  if (ids.length === 0) return result;
  const rows = await db<Row[]>`select creator_id,accepting_orders,held_units,active_units,version from app.creator_workloads where creator_id = any(${ids}::uuid[])`;
  for (const row of rows) result.set(String(row.creator_id), row);
  for (const id of ids) {
    if (!result.has(id)) result.set(id, { creator_id: id, accepting_orders: true, held_units: 0, active_units: 0, version: 0 });
  }
  return result;
}
