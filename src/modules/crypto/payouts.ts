/**
 * Chain payout outbox (master §6.4, §11.3, §11.7). Business transactions only queue a payout. The dispatch worker then:
 *   1. locks one due payout, signs a fresh single-use authorization and commits it (SUBMITTING);
 *   2. submits it to the escrow outside any database transaction;
 *   3. records CONFIRMED and applies the business effect, or RETRY/UNKNOWN/FAILED.
 * The contract pays each payout reference at most once, so a retry after an unknown outcome can never pay twice:
 * UNKNOWN payouts are first reconciled through findPayout before a new authorization is signed.
 */
import type { Hex } from 'viem';
import type { Row, Tx } from '@/lib/commands';
import { sql } from '@/lib/db';
import { bytes32Of, escrowDomain, newNonce, signFreeze, signRefund, signRelease } from './authorization';
import { ChainUnavailableError, PayoutRejectedError, getPayoutAdapter } from './chain';

export type PayoutKind = 'ALLOCATION' | 'POOL_REFUND' | 'ORDER_RELEASE' | 'ORDER_REFUND' | 'FREEZE' | 'UNFREEZE';
export const AUTHORIZATION_TTL_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 8;
/** Contract states that clear up on their own or through an operator; the payout waits instead of failing. */
const WAITING_CODES = new Set(['EnforcedPause', 'BucketFrozen', 'RPC_UNAVAILABLE']);

export type QueuedPayout = {
  kind: PayoutKind;
  subjectId: string;
  orderId?: string | null;
  chainId: number;
  escrowRef: Hex;
  /** Stable business identity, e.g. `ORDER_RELEASE:<orderId>:full`; hashed into the on-chain payout reference. */
  logicalKey: string;
  recipient?: string | null;
  token?: string | null;
  amountAtomic: bigint;
};

export async function enqueueChainPayout(tx: Tx, payout: QueuedPayout): Promise<Row> {
  const payoutRef = bytes32Of(payout.logicalKey);
  const [inserted] = await tx<Row[]>`insert into app.chain_payouts (kind,subject_id,order_id,chain_id,escrow_ref,payout_ref,recipient,token,amount_atomic)
    values (${payout.kind},${payout.subjectId},${payout.orderId ?? null},${payout.chainId},${payout.escrowRef.toLowerCase()},${payoutRef},
      ${payout.recipient?.toLowerCase() ?? null},${payout.token?.toLowerCase() ?? null},${payout.amountAtomic.toString()})
    on conflict (payout_ref) do nothing returning *`;
  if (inserted) return inserted;
  const [existing] = await tx<Row[]>`select * from app.chain_payouts where payout_ref=${payoutRef}`;
  return existing!;
}

export type PayoutEffects = {
  onConfirmed(tx: Tx, payout: Row): Promise<void>;
  onFailed(tx: Tx, payout: Row, code: string): Promise<void>;
};

const effects = new Map<PayoutKind, PayoutEffects>();

/** Domain modules register what a confirmed or failed payout of their kind means (pools, orders). */
export function registerPayoutEffects(kinds: PayoutKind[], handler: PayoutEffects) {
  for (const kind of kinds) effects.set(kind, handler);
}

async function effectsFor(kind: PayoutKind): Promise<PayoutEffects | undefined> {
  if (!effects.has(kind)) {
    // Registration happens on module load; make sure the owning modules are loaded in this bundle.
    await import('@/modules/pools/service');
    await import('@/modules/payments/funding');
  }
  return effects.get(kind);
}

async function sign(payout: Row, network: Row) {
  const domain = escrowDomain(Number(network.chain_id), String(network.settlement_address));
  const nonce = newNonce();
  const expiry = BigInt(Math.floor(Date.now() / 1000) + AUTHORIZATION_TTL_SECONDS);
  const base = { payoutRef: String(payout.payout_ref) as Hex, escrowRef: String(payout.escrow_ref) as Hex, nonce, expiry };
  const amount = BigInt(String(payout.amount_atomic));
  switch (String(payout.kind)) {
    case 'ALLOCATION':
    case 'ORDER_RELEASE':
      return { nonce, expiry, kind: 'release' as const, signed: await signRelease(domain, { ...base, recipient: String(payout.recipient) as Hex, token: String(payout.token) as Hex, amount }) };
    case 'POOL_REFUND':
    case 'ORDER_REFUND':
      return { nonce, expiry, kind: 'refund' as const, signed: await signRefund(domain, { ...base, amount }) };
    default:
      return { nonce, expiry, kind: 'freeze' as const, signed: await signFreeze(domain, { escrowRef: base.escrowRef, frozen: payout.kind === 'FREEZE', nonce, expiry }) };
  }
}

async function finish(payoutId: string, outcome: { state: 'CONFIRMED'; txHash: string | null } | { state: 'RETRY' | 'UNKNOWN'; code: string } | { state: 'FAILED'; code: string }): Promise<string> {
  return sql.begin(async (tx) => {
    const [payout] = await tx<Row[]>`select * from app.chain_payouts where id=${payoutId} for update`;
    if (!payout || ['CONFIRMED', 'FAILED'].includes(String(payout.state))) return 'SKIPPED_FINAL';
    const handler = await effectsFor(String(payout.kind) as PayoutKind);
    if (outcome.state === 'CONFIRMED') {
      const txHash = outcome.txHash && /^0x[0-9a-fA-F]{64}$/.test(outcome.txHash) ? outcome.txHash.toLowerCase() : null;
      await tx`update app.chain_payouts set state='CONFIRMED',tx_hash=${txHash},confirmed_at=now(),last_error=null where id=${payoutId}`;
      await tx`update app.release_authorizations set consumed_at=coalesce(consumed_at,now()),outcome='TRANSFERRED' where chain_payout_id=${payoutId} and outcome is distinct from 'TRANSFERRED' and consumed_at is null`;
      // Money already moved on chain: a failing business effect must never roll back the confirmation record.
      try {
        await tx.savepoint((sp) => handler ? handler.onConfirmed(sp as unknown as Tx, { ...payout, tx_hash: txHash }) : Promise.resolve());
      } catch (error) {
        await tx`insert into app.reconciliation_cases (order_id,kind,severity,next_action)
          values (${payout.order_id ?? null},'CHAIN_PAYOUT_EFFECT_FAILED','HIGH',${`${String(payout.kind)} payout ${payoutId} confirmed on chain but the order update failed: ${(error instanceof Error ? error.message : 'unknown').slice(0, 200)}`})`;
        return 'CONFIRMED_EFFECT_FAILED';
      }
      return 'CONFIRMED';
    }
    if (outcome.state === 'FAILED' || Number(payout.attempts) >= MAX_ATTEMPTS) {
      const code = outcome.code.slice(0, 300);
      await tx`update app.chain_payouts set state='FAILED',last_error=${code} where id=${payoutId}`;
      await tx`update app.release_authorizations set consumed_at=now(),outcome='FAILED' where chain_payout_id=${payoutId} and consumed_at is null`;
      await handler?.onFailed(tx, payout, code);
      await tx`insert into app.reconciliation_cases (order_id,kind,severity,next_action)
        values (${payout.order_id ?? null},'CHAIN_PAYOUT_FAILED','HIGH',${`${String(payout.kind)} payout ${payoutId} failed (${code}); nothing more is sent automatically`})`;
      return 'FAILED';
    }
    // Exponential backoff: 30 s, 1 min, 2 min … capped at 30 min.
    const delaySeconds = Math.min(1800, 30 * 2 ** Math.max(0, Number(payout.attempts) - 1));
    await tx`update app.chain_payouts set state=${outcome.state},last_error=${outcome.code.slice(0, 300)},next_attempt_at=now() + (${delaySeconds} * interval '1 second') where id=${payoutId}`;
    if (outcome.state === 'RETRY') await tx`update app.release_authorizations set consumed_at=now(),outcome='FAILED' where chain_payout_id=${payoutId} and consumed_at is null`;
    else await tx`update app.release_authorizations set outcome='UNKNOWN' where chain_payout_id=${payoutId} and consumed_at is null`;
    return outcome.state;
  });
}

/** One payout end to end. Exposed for tests and operator retries; the job calls it for each due payout. */
export async function dispatchChainPayout(payoutId: string): Promise<string> {
  const prepared = await sql.begin(async (tx) => {
    const [payout] = await tx<Row[]>`select * from app.chain_payouts where id=${payoutId} and state in ('QUEUED','RETRY','UNKNOWN','SUBMITTING') for update skip locked`;
    if (!payout) return null;
    const [network] = await tx<Row[]>`select * from app.chain_networks where chain_id=${String(payout.chain_id)}`;
    if (!network?.enabled) {
      await tx`update app.chain_payouts set state='RETRY',last_error='NETWORK_DISABLED',next_attempt_at=now() + interval '5 minutes' where id=${payoutId}`;
      return null;
    }
    return { payout, network };
  });
  if (!prepared) return 'SKIPPED';
  const { network } = prepared;
  let adapter;
  try {
    adapter = await getPayoutAdapter(network);
  } catch (error) {
    return finish(payoutId, { state: 'RETRY', code: error instanceof Error ? `NO_ADAPTER:${error.message}` : 'NO_ADAPTER' });
  }

  // A previous attempt may have reached the chain: never sign again until the contract says it has not paid.
  if (['UNKNOWN', 'SUBMITTING'].includes(String(prepared.payout.state)) && !['FREEZE', 'UNFREEZE'].includes(String(prepared.payout.kind))) {
    try {
      const paid = await adapter.findPayout(String(prepared.payout.payout_ref) as Hex);
      if (paid) return finish(payoutId, { state: 'CONFIRMED', txHash: paid });
    } catch {
      return finish(payoutId, { state: 'UNKNOWN', code: 'RPC_UNAVAILABLE' });
    }
  }

  const authorization = await sql.begin(async (tx) => {
    const [payout] = await tx<Row[]>`select * from app.chain_payouts where id=${payoutId} and state in ('QUEUED','RETRY','UNKNOWN','SUBMITTING') for update`;
    if (!payout) return null;
    const signed = await sign(payout, network);
    await tx`update app.chain_payouts set state='SUBMITTING',attempts=attempts+1 where id=${payoutId}`;
    await tx`insert into app.release_authorizations (nonce,payout_kind,payout_id,chain_id,verifying_contract,recipient,token,amount_atomic,expires_at,signature,chain_payout_id)
      values (${signed.nonce},${String(payout.kind)},${String(payout.subject_id)},${Number(network.chain_id)},${String(network.settlement_address)},
        ${payout.recipient ?? null},${payout.token ?? null},${String(payout.amount_atomic)},to_timestamp(${Number(signed.expiry)}),${signed.signed.signature},${payoutId})`;
    return signed;
  });
  if (!authorization) return 'SKIPPED';

  try {
    const { txHash } = authorization.kind === 'release'
      ? await adapter.executeRelease(authorization.signed)
      : authorization.kind === 'refund'
        ? await adapter.executeRefund(authorization.signed)
        : await adapter.executeFreeze(authorization.signed);
    return finish(payoutId, { state: 'CONFIRMED', txHash });
  } catch (error) {
    if (error instanceof PayoutRejectedError) {
      if (error.code.startsWith('ALREADY_RELEASED:')) return finish(payoutId, { state: 'CONFIRMED', txHash: error.code.slice('ALREADY_RELEASED:'.length) });
      if (WAITING_CODES.has(error.code)) return finish(payoutId, { state: 'RETRY', code: error.code });
      return finish(payoutId, { state: 'FAILED', code: error.code });
    }
    // RPC trouble or a transaction submitted without a receipt: outcome unknown, reconcile before retrying.
    const code = error instanceof ChainUnavailableError ? error.message : error instanceof Error ? error.name : 'PAYOUT_ERROR';
    return finish(payoutId, { state: 'UNKNOWN', code });
  }
}

/** Worker body for `dispatch_chain_payouts`: due payouts oldest first; each runs independently. */
export async function dueChainPayouts(options: { limit?: number; orderId?: string } = {}): Promise<string[]> {
  const rows = await sql<Row[]>`select id from app.chain_payouts
    where state in ('QUEUED','RETRY','UNKNOWN') and next_attempt_at <= now()
      and (${options.orderId ?? null}::uuid is null or order_id=${options.orderId ?? null}::uuid)
    order by created_at asc limit ${options.limit ?? 25}`;
  // SUBMITTING rows older than two minutes were interrupted mid-attempt (crash); reconcile them too.
  const stuck = await sql<Row[]>`select id from app.chain_payouts where state='SUBMITTING' and updated_at < now() - interval '2 minutes'
    and (${options.orderId ?? null}::uuid is null or order_id=${options.orderId ?? null}::uuid) order by created_at asc limit 10`;
  return [...rows, ...stuck].map((row) => String(row.id));
}
