import { describe, expect, it } from 'vitest';
import { checkBucketsCovered, checkFinishedOrdersSettled, checkLedgerBalances, checkOpenCases, checkPayoutsAgainstChain,
  checkStuckPayouts, formatReconcileReport, hasDrift, unchecked } from '../../scripts/lib/reconcile-rules';

/**
 * `reconcile:dry-run` exists to notice money that the books and the chain disagree about, so the thing these
 * tests guard hardest is that it never reports agreement it did not actually establish.
 */

describe('double-entry balance', () => {
  it('passes when every transaction nets to zero in its own currency', () => {
    const check = checkLedgerBalances([
      { transaction_id: 't1', account: 'chain_clearing:1', amount_minor: '65000', currency: 'USD' },
      { transaction_id: 't1', account: 'order_principal:o1', amount_minor: '-65000', currency: 'USD' },
    ]);
    expect(check.status).toBe('PASS');
  });

  it('names the transaction that lost money, and does not net two currencies against each other', () => {
    const check = checkLedgerBalances([
      { transaction_id: 't2', account: 'a', amount_minor: '100', currency: 'USD' },
      { transaction_id: 't2', account: 'b', amount_minor: '-100', currency: 'EUR' },
    ]);
    expect(check.status).toBe('FAIL');
    expect(check.findings).toHaveLength(2);
    expect(check.findings.join(' ')).toContain('t2');
  });
});

describe('finished orders', () => {
  it('accepts a finished order whose principal is settled and ignores one still running', () => {
    const check = checkFinishedOrdersSettled([
      { order_id: 'o1', status: 'COMPLETED', principal_minor: '0' },
      { order_id: 'o2', status: 'IN_PROGRESS', principal_minor: '-4000' },
    ]);
    expect(check.status).toBe('PASS');
    expect(check.name).toContain('1 orders');
  });

  it('reports a completed order that still holds principal', () => {
    const check = checkFinishedOrdersSettled([{ order_id: 'o3', status: 'COMPLETED', principal_minor: '-4000' }]);
    expect(check.status).toBe('FAIL');
    expect(check.findings[0]).toContain('o3');
    expect(check.findings[0]).toContain('-4000');
  });
});

describe('payouts against the escrow', () => {
  const payout = { id: 'p1', payout_ref: '0xref', state: 'CONFIRMED', kind: 'ORDER_RELEASE', amount_atomic: '1000' };

  it('agrees when the books and the escrow tell the same story', () => {
    const check = checkPayoutsAgainstChain([payout], new Map([['0xref', '0xtx']]));
    expect(check.status).toBe('PASS');
  });

  it('catches money recorded as paid that the escrow never sent', () => {
    const check = checkPayoutsAgainstChain([payout], new Map([['0xref', null]]));
    expect(check.status).toBe('FAIL');
    expect(check.findings[0]).toContain('no record of');
  });

  it('catches money already sent that the books have not recorded', () => {
    const check = checkPayoutsAgainstChain([{ ...payout, state: 'RETRY' }], new Map([['0xref', '0xtx']]));
    expect(check.status).toBe('FAIL');
    expect(check.findings[0]).toContain('already paid');
  });

  it('refuses to call it agreement when no escrow answered', () => {
    const check = checkPayoutsAgainstChain([payout], new Map());
    expect(check.status).toBe('UNCHECKED');
    expect(check.findings).toEqual([]);
  });

  it('is a clean pass only when there was nothing to compare in the first place', () => {
    expect(checkPayoutsAgainstChain([], new Map()).status).toBe('PASS');
  });
});

describe('stuck payouts', () => {
  it('reports one wedged in SUBMITTING and one out of attempts', () => {
    const check = checkStuckPayouts([
      { id: 'p1', payout_ref: '0x1', state: 'SUBMITTING', kind: 'ORDER_RELEASE', amount_atomic: '1', submitting_minutes: 40 },
      { id: 'p2', payout_ref: '0x2', state: 'RETRY', kind: 'ORDER_RELEASE', amount_atomic: '1', attempts: 8 },
      { id: 'p3', payout_ref: '0x3', state: 'SUBMITTING', kind: 'ORDER_RELEASE', amount_atomic: '1', submitting_minutes: 1 },
    ]);
    expect(check.status).toBe('FAIL');
    expect(check.findings).toHaveLength(2);
    expect(check.findings.join(' ')).not.toContain('p3');
  });
});

describe('escrow buckets', () => {
  it('reports a bucket that paid out more than it ever held', () => {
    const check = checkBucketsCovered([{ escrow_ref: '0xb', spent_atomic: '200' }], new Map([['0xb', 100n]]));
    expect(check.status).toBe('FAIL');
  });

  it('accepts spending within the deposit, and stays unchecked when the chain said nothing', () => {
    expect(checkBucketsCovered([{ escrow_ref: '0xb', spent_atomic: '100' }], new Map([['0xb', 100n]])).status).toBe('PASS');
    expect(checkBucketsCovered([{ escrow_ref: '0xb', spent_atomic: '100' }], new Map()).status).toBe('UNCHECKED');
  });
});

describe('the report', () => {
  it('will not call the books clean while a case is open', () => {
    const check = checkOpenCases([{ id: 'c1', kind: 'REFUND_FAILED', severity: 'HIGH', order_id: 'o1' }]);
    expect(check.status).toBe('FAIL');
    expect(hasDrift([check])).toBe(true);
  });

  it('separates what disagrees from what could not be looked at', () => {
    const report = formatReconcileReport([
      checkLedgerBalances([{ transaction_id: 't', account: 'a', amount_minor: '1', currency: 'USD' }]),
      unchecked('payment provider operations', 'the mock provider lives in the dev server process'),
    ]);
    expect(report).toContain('DRIFT |');
    expect(report).toContain('nothing was changed');
    expect(report).toContain('UNCHECKED | 1');
  });

  it('says clean only when nothing disagreed', () => {
    const report = formatReconcileReport([checkOpenCases([])]);
    expect(report).toContain('CLEAN |');
    expect(hasDrift([checkOpenCases([])])).toBe(false);
  });
});
