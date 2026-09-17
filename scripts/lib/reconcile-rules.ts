/**
 * Rules for `reconcile:dry-run` (master §17.4: it must never send money). Every function here is pure: the script
 * reads rows and chain answers, these decide whether the books agree with them. Keeping the judgement separate
 * from the reading is what lets the rules be tested without a database or a chain.
 *
 * A finding is drift: the internal record and the outside world disagree about money. "Unchecked" is different
 * and is reported just as loudly — a reconciliation that quietly skips half the estate is worse than none.
 */

export type ReconcileCheck = { name: string; status: 'PASS' | 'FAIL' | 'UNCHECKED'; findings: string[]; note?: string };

const pass = (name: string, findings: string[], note?: string): ReconcileCheck =>
  ({ name, status: findings.length ? 'FAIL' : 'PASS', findings, ...(note ? { note } : {}) });

export const unchecked = (name: string, note: string): ReconcileCheck => ({ name, status: 'UNCHECKED', findings: [], note });

/** Money is conserved inside one transaction: its entries sum to zero, per currency. */
export type LedgerEntry = { transaction_id: string; account: string; amount_minor: string | number | bigint; currency: string; kind?: string };

export function checkLedgerBalances(entries: LedgerEntry[]): ReconcileCheck {
  const totals = new Map<string, bigint>();
  for (const entry of entries) {
    const key = `${entry.transaction_id}|${entry.currency}`;
    totals.set(key, (totals.get(key) ?? 0n) + BigInt(entry.amount_minor));
  }
  const findings: string[] = [];
  for (const [key, total] of totals) {
    if (total !== 0n) {
      const [transaction, currency] = key.split('|');
      findings.push(`ledger transaction ${transaction} does not balance in ${currency}: ${total} minor units unaccounted`);
    }
  }
  return pass(`double-entry balance (${totals.size} transactions)`, findings.sort());
}

/**
 * An order that has finished owes nothing: its own principal account nets to zero once it is completed, refunded
 * or cancelled. A non-zero balance means money is still recorded against work that has stopped.
 */
export type OrderBalance = { order_id: string; status: string; principal_minor: string | number | bigint };
const FINISHED = new Set(['COMPLETED', 'REFUNDED', 'CANCELLED']);

export function checkFinishedOrdersSettled(balances: OrderBalance[]): ReconcileCheck {
  const finished = balances.filter((row) => FINISHED.has(String(row.status).toUpperCase()));
  const findings = finished
    .filter((row) => BigInt(row.principal_minor) !== 0n)
    .map((row) => `order ${row.order_id} is ${row.status} but still holds ${row.principal_minor} minor units of principal`);
  return pass(`finished orders hold no principal (${finished.length} orders)`, findings.sort());
}

/**
 * The outbox against the chain. `paidOnChain` is what the escrow says about each payout reference, so:
 *   - recorded as paid, chain has never heard of it  → the ledger is ahead of the money;
 *   - not recorded as paid, chain has already paid it → the ledger is behind, and the money is already gone.
 * Neither is fixed here. A dry run reports; an operator decides.
 */
export type PayoutRow = { id: string; payout_ref: string; state: string; kind: string; amount_atomic: string | number | bigint; attempts?: number; submitting_minutes?: number | null };

export function checkPayoutsAgainstChain(payouts: PayoutRow[], paidOnChain: Map<string, string | null>): ReconcileCheck {
  const findings: string[] = [];
  let compared = 0;
  for (const payout of payouts) {
    if (!paidOnChain.has(payout.payout_ref)) continue;
    compared += 1;
    const onChain = paidOnChain.get(payout.payout_ref) ?? null;
    const recorded = String(payout.state).toUpperCase() === 'CONFIRMED';
    if (recorded && !onChain) findings.push(`payout ${payout.id} is CONFIRMED but the escrow has no record of ${payout.payout_ref}`);
    if (!recorded && onChain) findings.push(`payout ${payout.id} is ${payout.state} but the escrow already paid ${payout.payout_ref} in ${onChain}`);
  }
  // Comparing nothing is not agreement. Saying PASS here would be the quiet skip this whole file exists to avoid.
  if (compared === 0 && payouts.length > 0) return unchecked('chain payouts match the escrow', `no escrow answered for any of ${payouts.length} payouts`);
  return pass(`chain payouts match the escrow (${compared} compared)`, findings.sort());
}

/** Payouts that stopped moving. Not drift on their own, but nothing retries them and money is waiting. */
export function checkStuckPayouts(payouts: PayoutRow[], options: { submittingMinutes?: number; maxAttempts?: number } = {}): ReconcileCheck {
  const stale = options.submittingMinutes ?? 15;
  const attemptsCeiling = options.maxAttempts ?? 8;
  const findings: string[] = [];
  for (const payout of payouts) {
    const state = String(payout.state).toUpperCase();
    if (state === 'SUBMITTING' && (payout.submitting_minutes ?? 0) >= stale) {
      findings.push(`payout ${payout.id} has been SUBMITTING for ${payout.submitting_minutes} minutes; its outcome is unknown`);
    }
    if (['RETRY', 'UNKNOWN'].includes(state) && (payout.attempts ?? 0) >= attemptsCeiling) {
      findings.push(`payout ${payout.id} is ${state} after ${payout.attempts} attempts and will not be retried again`);
    }
  }
  return pass('no payout is stuck mid-flight', findings.sort());
}

/**
 * Per escrow bucket: what the books say was released or refunded must not exceed what the chain says was
 * deposited. Spending more than a bucket holds is the one error the contract itself would refuse, so seeing it
 * in the books means the books are describing money that does not exist.
 */
export type BucketBalance = { escrow_ref: string; spent_atomic: string | number | bigint };

export function checkBucketsCovered(buckets: BucketBalance[], depositedOnChain: Map<string, bigint>): ReconcileCheck {
  const findings: string[] = [];
  let compared = 0;
  for (const bucket of buckets) {
    const deposited = depositedOnChain.get(bucket.escrow_ref);
    if (deposited === undefined) continue;
    compared += 1;
    const spent = BigInt(bucket.spent_atomic);
    if (spent > deposited) findings.push(`escrow ${bucket.escrow_ref} has ${spent} atomic units released or refunded against ${deposited} deposited`);
  }
  if (compared === 0 && buckets.length > 0) return unchecked('escrow buckets cover what was paid out', `no escrow reported deposits for any of ${buckets.length} buckets`);
  return pass(`escrow buckets cover what was paid out (${compared} compared)`, findings.sort());
}

/** Cases someone already opened. A dry run does not close them; it refuses to call the books clean while they sit. */
export type CaseRow = { id: string; kind: string; severity: string; order_id?: string | null };

export function checkOpenCases(cases: CaseRow[]): ReconcileCheck {
  const findings = cases.map((row) => `${row.severity} case ${row.id}: ${row.kind}${row.order_id ? ` on order ${row.order_id}` : ''}`);
  return pass(`no open reconciliation case (${cases.length} open)`, findings.sort());
}

export function formatReconcileReport(checks: ReconcileCheck[]): string {
  const lines = checks.map((check) => {
    const head = `${check.status.padEnd(9)} | ${check.name}${check.note ? ` — ${check.note}` : ''}`;
    return [head, ...check.findings.map((finding) => `          - ${finding}`)].join('\n');
  });
  const failed = checks.filter((check) => check.status === 'FAIL');
  const skipped = checks.filter((check) => check.status === 'UNCHECKED');
  const summary = failed.length
    ? `\nDRIFT | ${failed.length} of ${checks.length} checks disagree with the outside world; nothing was changed.`
    : `\nCLEAN | ${checks.length - skipped.length} checks agree; nothing was changed.`;
  const caveat = skipped.length ? `\nUNCHECKED | ${skipped.length}: ${skipped.map((check) => check.name).join(', ')}` : '';
  return `${lines.join('\n')}\n${summary}${caveat}`;
}

export const hasDrift = (checks: ReconcileCheck[]) => checks.some((check) => check.status === 'FAIL');
