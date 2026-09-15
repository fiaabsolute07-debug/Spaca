import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, safeError } from '@/lib/log';

afterEach(() => vi.restoreAllMocks());

describe('SEC-11 — error logs carry no row data or payload text', () => {
  it('keeps the error code, constraint and table of a database error but drops the failing row', () => {
    const pgError = Object.assign(new Error('new row for relation "orders" violates check constraint "orders_amount_positive"'), {
      name: 'PostgresError', code: '23514', constraint_name: 'orders_amount_positive', table_name: 'orders', routine: 'ExecConstraints',
      detail: 'Failing row contains (brief: our secret token launch on 2026-10-01, buyer@example.test, 65000).',
      parameters: ['our secret token launch on 2026-10-01', 'buyer@example.test'],
    });
    const logged = JSON.stringify(safeError(pgError));
    expect(logged).toContain('"code":"23514"');
    expect(logged).toContain('orders_amount_positive');
    expect(logged).not.toContain('secret token launch');
    expect(logged).not.toContain('buyer@example.test');
    expect(logged).not.toContain('Failing row');
  });

  it('redacts long quoted values in messages and logs only through a single JSON line', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error(`invalid input "${'x'.repeat(30)}private brief text that should never be logged"\nsecond line with more data`);
    logError('command failed', error, { order_id: 'ord_1' });
    expect(spy).toHaveBeenCalledTimes(1);
    const [context, payload] = spy.mock.calls[0]!;
    expect(context).toBe('command failed');
    expect(String(payload)).toContain('"order_id":"ord_1"');
    expect(String(payload)).toContain('[redacted]');
    expect(String(payload)).not.toContain('private brief text');
    expect(String(payload)).not.toContain('second line');
    expect(safeError('plain string')).toEqual({ kind: 'string' });
  });
});
