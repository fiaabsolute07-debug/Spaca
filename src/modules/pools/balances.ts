/**
 * Per-asset pool buckets (master §11.5). Every movement is journaled once per reference and moves value between
 * disjoint buckets; the conservation and non-negative CHECKs in drizzle/0010 reject any movement that would
 * spend principal that is not there (CRY-07).
 */
import { CommandError, type Tx } from '@/lib/commands';

export type Movement = 'DEPOSIT' | 'ALLOCATE' | 'DEALLOCATE' | 'RELEASE_START' | 'RELEASE_DONE' | 'RELEASE_FAILED' | 'REFUND_START' | 'REFUND_DONE' | 'REFUND_FAILED';

const MOVES: Record<Movement, [from: string | null, to: string]> = {
  DEPOSIT: [null, 'unallocated'],
  ALLOCATE: ['unallocated', 'allocated_active'],
  DEALLOCATE: ['allocated_active', 'unallocated'],
  RELEASE_START: ['allocated_active', 'pending_outflow'],
  RELEASE_DONE: ['pending_outflow', 'released'],
  RELEASE_FAILED: ['pending_outflow', 'allocated_active'],
  REFUND_START: ['unallocated', 'pending_outflow'],
  REFUND_DONE: ['pending_outflow', 'refunded'],
  REFUND_FAILED: ['pending_outflow', 'unallocated'],
};

/** Returns false when this (movement, reference) was already applied. */
export async function moveBalance(tx: Tx, poolAssetId: string, movement: Movement, amount: bigint, reference: string): Promise<boolean> {
  if (amount <= 0n) throw new Error('pool movements must be positive');
  const [journaled] = await tx`insert into app.pool_ledger (pool_asset_id,movement,amount_atomic,reference) values (${poolAssetId},${movement},${amount.toString()},${reference})
    on conflict (movement,reference) do nothing returning id`;
  if (!journaled) return false;
  const [from, to] = MOVES[movement];
  const value = amount.toString();
  try {
    if (movement === 'DEPOSIT') {
      await tx`update app.pool_assets set confirmed_deposit=confirmed_deposit + ${value}::numeric, unallocated=unallocated + ${value}::numeric, updated_at=now() where id=${poolAssetId}`;
    } else {
      await tx`update app.pool_assets set ${tx(from!)}=${tx(from!)} - ${value}::numeric, ${tx(to)}=${tx(to)} + ${value}::numeric, updated_at=now() where id=${poolAssetId}`;
    }
  } catch (error) {
    if ((error as { constraint_name?: string }).constraint_name === 'pool_assets_nonnegative') {
      throw new CommandError('The pool does not hold enough of this asset for that movement', 'BUDGET_EXCEEDED');
    }
    throw error;
  }
  return true;
}

/** ACTIVE once every required asset's net deposits cover its target; a closed pool stays closed. */
export async function refreshPoolStatus(tx: Tx, poolId: string): Promise<string> {
  const [pool] = await tx`update app.campaign_pools set status=case
      when status='CLOSED' then 'CLOSED'
      when not exists (select 1 from app.pool_assets a where a.pool_id=${poolId} and a.required and a.confirmed_deposit - a.refunded < a.target_atomic) then 'ACTIVE'
      else 'FUNDING' end
    where id=${poolId} returning status`;
  return String(pool?.status);
}
