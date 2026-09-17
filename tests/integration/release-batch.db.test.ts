import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Hex } from 'viem';
import { RUN_DB } from './harness';

const chain = await import('@/modules/crypto/chain');
const payouts = await import('@/modules/crypto/payouts');
const jobs = await import('@/modules/jobs');
const { sql } = await import('@/lib/db');

/**
 * Batched releases (master §11.7). A few dollars each would pay a network fee per payout, so small releases go out
 * in one `releaseBatch`. What matters is that batching changes only the transaction, never the accounting: every
 * release keeps its own reference and authorization, nobody is paid twice, and a rejected batch pays nobody.
 */

const CHAIN = 9_300_000 + Math.floor(Math.random() * 500_000);
const SETTLEMENT = '0x5e7713e0000000000000000000000000000000bb' as Hex;
const TOKEN = '0x05dc0000000000000000000000000000000000c6' as Hex;
const PAYER = '0xpayer00000000000000000000000000000000001'.replace('payer', 'a11ce') as Hex;
const ESCROW = '0x' + 'ab'.repeat(32) as Hex;
let dev: InstanceType<typeof chain.LocalDevChain>;

/** A queued release of `amount`, already funded in the simulator's bucket. */
async function queueRelease(amount: bigint, options: { token?: Hex; escrowRef?: Hex } = {}) {
  const escrowRef = options.escrowRef ?? ESCROW;
  const recipient = `0x${randomUUID().replaceAll('-', '')}${'0'.repeat(8)}`.slice(0, 42).toLowerCase() as Hex;
  return sql.begin(async (tx) => payouts.enqueueChainPayout(tx as never, {
    kind: 'ORDER_RELEASE', subjectId: randomUUID(), chainId: CHAIN, escrowRef,
    logicalKey: `release-batch:${randomUUID()}`, recipient, token: options.token ?? TOKEN, amountAtomic: amount,
  }));
}

const stateOf = async (id: string) => (await sql`select state,tx_hash,last_error,attempts from app.chain_payouts where id=${id}`)[0]!;
/**
 * These payouts are synthetic: they carry no real order, so the business effect after a confirmation has nothing
 * to update and opens a reconciliation case. That is the designed behaviour — money that moved on chain is never
 * rolled back by a failing effect — so both outcomes mean "paid", and the row's own state is the real assertion.
 */
const PAID = ['CONFIRMED', 'CONFIRMED_EFFECT_FAILED'];

beforeAll(async () => {
  if (!RUN_DB) return;
  await sql`insert into app.chain_networks (chain_id,name,mode,settlement_address,finality_confirmations,enabled)
    values (${CHAIN},${`IT batch devnet ${CHAIN}`},'LOCAL',${SETTLEMENT},1,true) on conflict (chain_id) do nothing`;
});
beforeEach(() => {
  if (!RUN_DB) return;
  dev = new chain.LocalDevChain(CHAIN, SETTLEMENT);
  // One deposit large enough for every release in this file.
  dev.submitDeposit({ emitter: SETTLEMENT, escrowRef: ESCROW, reference: ('0x' + 'cd'.repeat(32)) as Hex, payer: PAYER, token: TOKEN, amount: 1_000_000_000n });
  chain.setChainReaderForTests(CHAIN, dev);
});
afterAll(async () => {
  if (!RUN_DB) return;
  chain.setChainReaderForTests(CHAIN, undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('which releases are worth batching', () => {
  it('groups small releases by chain and token, and leaves large ones to go alone', async () => {
    const small = [await queueRelease(1_000_000n), await queueRelease(2_000_000n), await queueRelease(3_000_000n)];
    const large = await queueRelease(payouts.BATCH_MAX_AMOUNT_ATOMIC + 1n);
    const batches = await payouts.dueReleaseBatches();
    const mine = batches.filter((batch) => batch.some((id) => small.some((row) => String(row.id) === id)));
    expect(mine).toHaveLength(1);
    const ids = mine[0]!;
    for (const row of small) expect(ids).toContain(String(row.id));
    expect(ids).not.toContain(String(large.id));
    expect(ids.length).toBeLessThanOrEqual(payouts.BATCH_MAX_SIZE);
  });

  it('never batches a refund or a freeze: only a release names its own recipient', async () => {
    const refund = await sql.begin(async (tx) => payouts.enqueueChainPayout(tx as never, {
      kind: 'ORDER_REFUND', subjectId: randomUUID(), chainId: CHAIN, escrowRef: ESCROW,
      logicalKey: `refund:${randomUUID()}`, amountAtomic: 1_000_000n,
    }));
    const flat = (await payouts.dueReleaseBatches()).flat();
    expect(flat).not.toContain(String(refund.id));
  });
});

describe.skipIf(!RUN_DB)('sending a batch', () => {
  it('pays every release in one transaction, each keeping its own reference', async () => {
    const rows = [await queueRelease(1_000_000n), await queueRelease(1_500_000n), await queueRelease(2_500_000n)];
    const ids = rows.map((row) => String(row.id));
    const results = await payouts.dispatchChainPayoutBatch(ids);
    for (const outcome of Object.values(results)) expect(PAID).toContain(outcome);

    const states = await Promise.all(ids.map(stateOf));
    for (const state of states) expect(state.state).toBe('CONFIRMED');
    // One transaction: the same hash on every row.
    expect(new Set(states.map((state) => String(state.tx_hash))).size).toBe(1);
    // The simulator moved each release separately, to its own recipient, under its own payout reference.
    const paid = dev.transfers.filter((transfer) => transfer.kind === 'RELEASE');
    expect(paid).toHaveLength(3);
    expect(new Set(paid.map((transfer) => transfer.payoutRef)).size).toBe(3);
    expect(paid.reduce((total, transfer) => total + transfer.amount, 0n)).toBe(5_000_000n);

    // Every release has exactly one authorization on record, which is what reconciliation counts.
    for (const id of ids) {
      const [count] = await sql`select count(*)::int as n from app.release_authorizations where chain_payout_id=${id}`;
      expect(Number(count!.n)).toBe(1);
    }
  });

  it('pays nobody when the batch is refused, and sends each one back to be retried alone', async () => {
    // A bucket holding only enough for the first release: the second is refused and takes the transaction with
    // it, which is also what proves the batch is all-or-nothing rather than half applied.
    const thin = ('0x' + 'ef'.repeat(32)) as Hex;
    dev.submitDeposit({ emitter: SETTLEMENT, escrowRef: thin, reference: ('0x' + '12'.repeat(32)) as Hex, payer: PAYER, token: TOKEN, amount: 1_000_000n });
    const rows = [await queueRelease(1_000_000n, { escrowRef: thin }), await queueRelease(1_000_000n, { escrowRef: thin })];
    const ids = rows.map((row) => String(row.id));

    const results = await payouts.dispatchChainPayoutBatch(ids);
    for (const id of ids) {
      const state = await stateOf(id);
      expect(state.state, `payout ${id} must wait, never fail on a batch refusal`).toBe('RETRY');
      expect(String(state.last_error)).toContain('BATCH_REJECTED');
      expect(state.tx_hash).toBeNull();
    }
    expect(Object.values(results).every((outcome) => outcome === 'RETRY')).toBe(true);
    // Nothing moved: a reverted batch leaves no half-paid state behind.
    expect(dev.transfers.filter((transfer) => transfer.kind === 'RELEASE')).toHaveLength(0);
  });

  it('a single payout is just an ordinary release, not a batch', async () => {
    const one = await queueRelease(1_000_000n);
    const results = await payouts.dispatchChainPayoutBatch([String(one.id)]);
    expect(PAID).toContain(results[String(one.id)]);
    expect((await stateOf(String(one.id))).state).toBe('CONFIRMED');
    // One release, one transfer: the single path was taken, not a batch of one.
    expect(dev.transfers.filter((transfer) => transfer.kind === 'RELEASE')).toHaveLength(1);
  });

  it('the job batches what it can and reports it', async () => {
    const rows = [await queueRelease(1_000_000n), await queueRelease(1_000_000n), await queueRelease(1_000_000n)];
    const report = await jobs.dispatchReleaseBatches();
    expect(report.job).toBe('dispatch_release_batches');
    expect(report.outcomes.ERROR ?? 0).toBe(0);
    for (const row of rows) expect((await stateOf(String(row.id))).state).toBe('CONFIRMED');
  });
});
