/**
 * Capacity engine helpers (master §6). All counter changes happen here so reservation state and
 * pool counters move together exactly once.
 */
import { CommandError, type Row, type Tx } from '@/lib/commands';

/** Locks the pool and claims one unit into `reserved_units`. */
export async function reservePoolUnit(tx: Tx, poolId: string): Promise<Row> {
  const [pool] = await tx<Row[]>`select * from app.capacity_pools where id=${poolId} for update`;
  if (!pool || Number(pool.total_units) - Number(pool.reserved_units) - Number(pool.committed_units) < 1) {
    throw new CommandError('That creator has no available capacity', 'CAPACITY_UNAVAILABLE');
  }
  await tx`update app.capacity_pools set reserved_units=reserved_units+1 where id=${poolId}`;
  return pool;
}

/** Releases an order's claim (HELD/RECONCILING → reserved-1, COMMITTED → committed-1). CONSUMED work is never returned. */
export async function releaseOrderReservation(tx: Tx, orderId: string): Promise<'RELEASED' | 'NONE'> {
  const [reservation] = await tx<Row[]>`select * from app.reservations where order_id=${orderId} for update`;
  if (!reservation || !['HELD', 'RECONCILING', 'COMMITTED'].includes(String(reservation.state))) return 'NONE';
  if (reservation.state === 'COMMITTED') {
    await tx`update app.capacity_pools set committed_units=greatest(committed_units-1,0) where id=${String(reservation.pool_id)}`;
  } else {
    await tx`update app.capacity_pools set reserved_units=greatest(reserved_units-1,0) where id=${String(reservation.pool_id)}`;
  }
  await tx`update app.reservations set state='RELEASED' where id=${String(reservation.id)}`;
  return 'RELEASED';
}

/** Work accepted: the unit stays committed for the bucket it used (§6.1 rule 3). */
export async function consumeOrderReservation(tx: Tx, orderId: string): Promise<void> {
  await tx`update app.reservations set state='CONSUMED' where order_id=${orderId} and state='COMMITTED'`;
}
