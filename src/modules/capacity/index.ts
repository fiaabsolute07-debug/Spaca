/**
 * Capacity engine (master §6). Weekly buckets per pool in the pool's timezone; counters are maintained
 * by DB triggers from reservation state (drizzle/0003), and the bucket CHECK forbids oversell.
 * Application code only (1) materializes buckets, (2) locks a bucket before claiming, and (3) moves
 * reservation state. Lock order: pool → bucket(s) by start time → order (§6.4).
 */
import { CommandError, type Row, type Tx } from '@/lib/commands';
import type { Actor } from '@/lib/auth';
import { isValidTimeZone, weekWindows } from './weeks';

export const BOOKING_HORIZON_WEEKS = 8;

type Queryable = Tx | import('postgres').Sql;

/** Creates missing future week buckets for a pool (idempotent; overlaps from an older timezone are skipped). */
export async function ensureBuckets(tx: Tx, poolId: string, weeks = BOOKING_HORIZON_WEEKS): Promise<void> {
  const [pool] = await tx<Row[]>`select id,timezone,weekly_units from app.capacity_pools where id=${poolId}`;
  if (!pool) throw new CommandError('Capacity pool not found', 'NOT_FOUND');
  const windows = weekWindows(String(pool.timezone), new Date(), weeks);
  for (const window of windows) {
    // ON CONFLICT DO NOTHING also absorbs exclusion-constraint conflicts with retained buckets.
    await tx`insert into app.capacity_buckets (pool_id,starts_at,ends_at,local_week_start,timezone,total_units)
      values (${poolId},${window.startsAt.toISOString()},${window.endsAt.toISOString()},${window.localWeekStart},${String(pool.timezone)},${Number(pool.weekly_units)})
      on conflict do nothing`;
  }
}

/**
 * Locks the earliest bookable bucket with a free unit. A bucket is bookable while
 * `now() <= ends_at - turnaround` (latest checkout for work that must fit the week).
 */
export async function lockAvailableBucket(tx: Tx, poolId: string, turnaroundHours: number, preferredBucketId?: string | null): Promise<Row> {
  await tx`select id from app.capacity_pools where id=${poolId} for update`;
  await ensureBuckets(tx, poolId);
  const candidates = await tx<Row[]>`select id from app.capacity_buckets
    where pool_id=${poolId} and ends_at - (${turnaroundHours} * interval '1 hour') >= now() and starts_at < now() + (${BOOKING_HORIZON_WEEKS * 7} * interval '1 day')
      and (${preferredBucketId ?? null}::uuid is null or id=${preferredBucketId ?? null}::uuid)
    order by starts_at asc`;
  if (preferredBucketId && candidates.length === 0) throw new CommandError('That week is no longer bookable; choose another week', 'SLOT_EXPIRED');
  for (const candidate of candidates) {
    const [bucket] = await tx<Row[]>`select * from app.capacity_buckets where id=${String(candidate.id)} for update`;
    if (bucket && Number(bucket.total_units) - Number(bucket.reserved_units) - Number(bucket.committed_units) >= 1) return bucket;
  }
  throw new CommandError('That creator has no available capacity in the booking window', 'CAPACITY_UNAVAILABLE');
}

export async function insertReservation(
  tx: Tx,
  bucket: Row,
  owner: { orderId?: string; auctionId?: string },
  expiresAt: Date | null,
): Promise<Row> {
  const [reservation] = await tx<Row[]>`insert into app.reservations (pool_id,bucket_id,order_id,auction_id,state,expires_at)
    values (${String(bucket.pool_id)},${String(bucket.id)},${owner.orderId ?? null},${owner.auctionId ?? null},'HELD',${expiresAt?.toISOString() ?? null})
    returning *`;
  return reservation!;
}

/** Funding confirmed: HELD/RECONCILING → COMMITTED. Returns false if there was no claim to commit. */
export async function commitOrderReservation(tx: Tx, orderId: string): Promise<boolean> {
  const [reservation] = await tx<Row[]>`select id,state from app.reservations where order_id=${orderId} for update`;
  if (!reservation || !['HELD', 'RECONCILING'].includes(String(reservation.state))) return false;
  await tx`update app.reservations set state='COMMITTED',expires_at=null where id=${String(reservation.id)}`;
  return true;
}

/** Releases an unconsumed claim. CONSUMED work is never returned (CAP-06/12). */
export async function releaseOrderReservation(tx: Tx, orderId: string): Promise<'RELEASED' | 'NONE'> {
  const [reservation] = await tx<Row[]>`select id,state from app.reservations where order_id=${orderId} for update`;
  if (!reservation || !['HELD', 'RECONCILING', 'COMMITTED'].includes(String(reservation.state))) return 'NONE';
  await tx`update app.reservations set state='RELEASED' where id=${String(reservation.id)}`;
  return 'RELEASED';
}

export async function releaseAuctionReservation(tx: Tx, auctionId: string): Promise<'RELEASED' | 'NONE'> {
  const [reservation] = await tx<Row[]>`select id,state from app.reservations where auction_id=${auctionId} for update`;
  if (!reservation || !['HELD', 'RECONCILING'].includes(String(reservation.state))) return 'NONE';
  await tx`update app.reservations set state='RELEASED' where id=${String(reservation.id)}`;
  return 'RELEASED';
}

export async function markOrderReservationReconciling(tx: Tx, orderId: string): Promise<void> {
  await tx`update app.reservations set state='RECONCILING' where order_id=${orderId} and state='HELD'`;
}

/** Work accepted: the unit stays committed to the bucket it used (§6.1 rule 3). */
export async function consumeOrderReservation(tx: Tx, orderId: string): Promise<void> {
  await tx`update app.reservations set state='CONSUMED' where order_id=${orderId} and state='COMMITTED'`;
}

export async function lockOwnedPool(tx: Tx, actor: Actor, poolId: string): Promise<Row> {
  const [pool] = await tx<Row[]>`select * from app.capacity_pools where id=${poolId} and creator_id=${actor.id} for update`;
  if (!pool) throw new CommandError('Capacity pool not found or not owned by this account', 'FORBIDDEN');
  return pool;
}

/** CAP-07: changing weekly units applies to the pool and every current/future bucket, or nothing at all. */
export async function setWeeklyUnits(tx: Tx, actor: Actor, poolId: string, weeklyUnits: number): Promise<void> {
  await lockOwnedPool(tx, actor, poolId);
  await ensureBuckets(tx, poolId);
  const buckets = await tx<Row[]>`select id,local_week_start,reserved_units,committed_units from app.capacity_buckets
    where pool_id=${poolId} and ends_at > now() order by starts_at for update`;
  const conflicts = buckets.filter((b) => Number(b.reserved_units) + Number(b.committed_units) > weeklyUnits);
  if (conflicts.length > 0) {
    throw new CommandError(
      `Capacity cannot go below units already held or committed (weeks of ${conflicts.map((b) => String(b.local_week_start).slice(0, 10)).join(', ')})`,
      'CAPACITY_REDUCTION_CONFLICT',
    );
  }
  await tx`update app.capacity_buckets set total_units=${weeklyUnits},updated_at=now() where pool_id=${poolId} and ends_at > now()`;
  await tx`update app.capacity_pools set weekly_units=${weeklyUnits},version=version+1,updated_at=now() where id=${poolId}`;
}

/**
 * CAP-08: a timezone change only affects future buckets that hold no reservations. Buckets with any
 * reservation row (held, committed, consumed or released history) keep their instants.
 */
export async function setPoolTimezone(tx: Tx, actor: Actor, poolId: string, timeZone: string): Promise<{ removed: number }> {
  if (!isValidTimeZone(timeZone)) throw new CommandError('Time zone is not a valid IANA time zone');
  await lockOwnedPool(tx, actor, poolId);
  const removed = await tx`delete from app.capacity_buckets b where b.pool_id=${poolId} and b.starts_at > now()
    and not exists (select 1 from app.reservations r where r.bucket_id=b.id) returning id`;
  await tx`update app.capacity_pools set timezone=${timeZone},version=version+1,updated_at=now() where id=${poolId}`;
  await ensureBuckets(tx, poolId);
  return { removed: removed.length };
}

export type PoolAvailability = {
  poolId: string;
  weeklyUnits: number;
  timezone: string;
  availableUnits: number;
  nextAvailableStartsAt: string | null;
  nextAvailableEndsAt: string | null;
};

/**
 * Read-side availability without writes: materialized buckets where they exist, otherwise the pool's
 * weekly units for an unmaterialized week. Returns the earliest bookable week with a free unit.
 */
export async function poolAvailability(db: Queryable, pools: { poolId: string; turnaroundHours: number }[]): Promise<Map<string, PoolAvailability>> {
  const result = new Map<string, PoolAvailability>();
  if (pools.length === 0) return result;
  const ids = [...new Set(pools.map((p) => p.poolId))];
  const poolRows = await db<Row[]>`select id,timezone,weekly_units from app.capacity_pools where id = any(${ids}::uuid[])`;
  const bucketRows = await db<Row[]>`select pool_id,starts_at,ends_at,total_units,reserved_units,committed_units from app.capacity_buckets
    where pool_id = any(${ids}::uuid[]) and ends_at > now()`;
  const now = Date.now();
  for (const { poolId, turnaroundHours } of pools) {
    const key = `${poolId}:${turnaroundHours}`;
    const pool = poolRows.find((p) => String(p.id) === poolId);
    if (!pool) continue;
    const buckets = bucketRows.filter((b) => String(b.pool_id) === poolId);
    let found: PoolAvailability | null = null;
    for (const window of weekWindows(String(pool.timezone), new Date(now), BOOKING_HORIZON_WEEKS)) {
      if (window.endsAt.getTime() - turnaroundHours * 3600_000 < now) continue;
      const exact = buckets.find((b) => new Date(b.starts_at).getTime() === window.startsAt.getTime());
      const overlapping = buckets.find((b) => new Date(b.starts_at) < window.endsAt && new Date(b.ends_at) > window.startsAt);
      const available = exact
        ? Number(exact.total_units) - Number(exact.reserved_units) - Number(exact.committed_units)
        : overlapping ? 0 : Number(pool.weekly_units);
      if (available > 0) {
        found = { poolId, weeklyUnits: Number(pool.weekly_units), timezone: String(pool.timezone), availableUnits: available, nextAvailableStartsAt: window.startsAt.toISOString(), nextAvailableEndsAt: window.endsAt.toISOString() };
        break;
      }
    }
    result.set(key, found ?? { poolId, weeklyUnits: Number(pool.weekly_units), timezone: String(pool.timezone), availableUnits: 0, nextAvailableStartsAt: null, nextAvailableEndsAt: null });
  }
  return result;
}
