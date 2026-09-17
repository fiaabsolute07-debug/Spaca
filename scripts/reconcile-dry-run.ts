/**
 * `reconcile:dry-run` (master §17.4). Reads the books and the chain, reports where they disagree, and changes
 * nothing: no writes, no payouts, no retries. Exit code 1 means drift a person has to look at.
 *
 *   ./node_modules/.bin/tsx scripts/reconcile-dry-run.ts
 *
 * What it cannot see, it says so about rather than passing quietly: a network with no configured reader is
 * reported UNCHECKED, and the mock payment provider keeps its state in the dev server's memory, so nothing on
 * the provider side survives a restart to be reconciled against.
 */
import { checkBucketsCovered, checkFinishedOrdersSettled, checkLedgerBalances, checkOpenCases, checkPayoutsAgainstChain,
  checkStuckPayouts, formatReconcileReport, hasDrift, unchecked, type ReconcileCheck } from './lib/reconcile-rules';

// Read-only by construction: this script imports no command, job or payout dispatcher.
const { sql } = await import('../src/lib/db');
const chain = await import('../src/modules/crypto/chain');

type Row = Record<string, unknown>;
const checks: ReconcileCheck[] = [];

try {
  const [entries, orderBalances, payouts, buckets, cases] = await Promise.all([
    sql<Row[]>`select transaction_id::text,account,amount_minor::text,currency from app.ledger_entries`,
    sql<Row[]>`select o.id::text as order_id,o.status,
        coalesce(sum(e.amount_minor) filter (where e.account = 'order_principal:' || o.id::text),0)::text as principal_minor
      from app.orders o
        left join app.ledger_transactions t on t.order_id = o.id
        left join app.ledger_entries e on e.transaction_id = t.id
      group by o.id,o.status`,
    sql<Row[]>`select p.id::text,p.payout_ref,p.state,p.kind,p.amount_atomic::text,p.attempts,p.chain_id::text,
        case when p.state='SUBMITTING' then floor(extract(epoch from now() - p.updated_at) / 60)::int end as submitting_minutes,
        n.settlement_address,n.mode,n.enabled
      from app.chain_payouts p join app.chain_networks n on n.chain_id = p.chain_id`,
    sql<Row[]>`select p.escrow_ref,p.chain_id::text,
        coalesce(sum(p.amount_atomic) filter (where p.state='CONFIRMED' and p.kind in ('ALLOCATION','ORDER_RELEASE','POOL_REFUND','ORDER_REFUND')),0)::text as spent_atomic,
        min(n.settlement_address) as settlement_address
      from app.chain_payouts p join app.chain_networks n on n.chain_id = p.chain_id
      group by p.escrow_ref,p.chain_id`,
    sql<Row[]>`select id::text,kind,severity,order_id::text from app.reconciliation_cases where resolved_at is null`,
  ]);

  checks.push(checkLedgerBalances(entries as never));
  checks.push(checkFinishedOrdersSettled(orderBalances as never));
  checks.push(checkOpenCases(cases as never));
  checks.push(checkStuckPayouts(payouts as never));

  // Ask each network's escrow what it actually paid. A network without a reader is named, not skipped silently.
  const paidOnChain = new Map<string, string | null>();
  const depositedOnChain = new Map<string, bigint>();
  const unreachable: string[] = [];
  const networks = [...new Set(payouts.map((row) => String(row.chain_id)))];
  for (const chainId of networks) {
    const rows = payouts.filter((row) => String(row.chain_id) === chainId);
    const settlement = String(rows[0]!.settlement_address ?? '');
    let reader;
    try {
      reader = await chain.getPayoutAdapter({ chain_id: Number(chainId), settlement_address: settlement, mode: rows[0]!.mode, enabled: rows[0]!.enabled });
    } catch {
      unreachable.push(`chain ${chainId}`);
      continue;
    }
    for (const row of rows) {
      try {
        paidOnChain.set(String(row.payout_ref), await reader.findPayout(String(row.payout_ref) as `0x${string}`));
      } catch {
        unreachable.push(`payout ${String(row.id)}`);
      }
    }
    const local = chain.getLocalDevChain(Number(chainId), settlement || undefined);
    if (local) {
      for (const bucket of buckets.filter((row) => String(row.chain_id) === chainId)) {
        const state = local.bucket(String(bucket.escrow_ref) as `0x${string}`);
        if (state) depositedOnChain.set(String(bucket.escrow_ref), state.deposited);
      }
    }
  }

  checks.push(checkPayoutsAgainstChain(payouts as never, paidOnChain));
  checks.push(depositedOnChain.size
    ? checkBucketsCovered(buckets as never, depositedOnChain)
    : unchecked('escrow buckets cover what was paid out', 'no escrow reported its deposits; needs a reachable node'));
  if (unreachable.length) checks.push(unchecked('escrow reachable for every payout', `could not ask: ${unreachable.slice(0, 5).join(', ')}${unreachable.length > 5 ? ` and ${unreachable.length - 5} more` : ''}`));
  checks.push(unchecked('payment provider operations', 'the mock provider keeps its objects in the dev server process; a restart leaves nothing to reconcile against'));

  console.log(formatReconcileReport(checks));
  process.exitCode = hasDrift(checks) ? 1 : 0;
} catch {
  // Errors here can carry row data or connection strings. Say that it failed, not what was in it.
  console.error('FAIL | reconcile:dry-run could not read the records it needs');
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => undefined);
}
