import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider, parseAtomicAmount } from '@/modules/payments/providers';
import { formatAtomicAmount } from '@/modules/notifications';
import { RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const funding = await import('@/modules/payments/funding');
const { money, CommandError } = await import('@/lib/commands');
const { usdMinorToAtomic, atomicToUsdMinor, formatAtomic, parseDecimalToAtomic } = await import('@/modules/crypto/registry');
const { money: displayMoney } = await import('@/components/ui');
const { sql } = await import('@/lib/db');

let provider: MockPaymentProvider;
const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, { idempotency_key: key('money'), ...fields });

beforeEach(() => {
  if (!RUN_DB) return;
  provider = new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_money_suite_secret_0001'] });
  funding.setMockPaymentProviderForTests(provider);
});
afterAll(async () => {
  if (RUN_DB) {
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe('PAY-17 — money inputs parse exactly or not at all', () => {
  it('accepts plain USD decimals with at most two places inside the range and refuses everything else', () => {
    const accepted: [string, bigint][] = [['0.01', 1n], ['1', 100n], ['1.5', 150n], ['1.05', 105n], ['650.99', 65099n], ['999999999.99', 99999999999n], ['1000000000', 100000000000n]];
    for (const [input, minor] of accepted) expect(money(input, 'price'), input).toBe(minor);
    for (const input of ['0', '0.00', '-1', '1.001', '1e3', ' 1', '1 ', '1,000', '0x10', 'NaN', 'Infinity', '1000000000.01', '', '.5', '5.']) {
      expect(() => money(input, 'price'), JSON.stringify(input)).toThrow(CommandError);
    }
  });

  it('converts between USD cents and token units without rounding, and refuses inexact token amounts as cents', () => {
    expect(usdMinorToAtomic(65099n, 6)).toBe(650990000n);
    expect(usdMinorToAtomic(65099n, 18)).toBe(650990000000000000000n);
    expect(atomicToUsdMinor(650990000n, 6)).toBe(65099n);
    expect(atomicToUsdMinor(650990001n, 6)).toBeNull();
    expect(formatAtomic(650990000000000000000n, 18)).toBe('650.99');
    expect(parseDecimalToAtomic('650.990000000000000001', 18)).toBe(650990000000000000001n);
    expect(formatAtomicAmount(65099n, 'USD')).toBe('650.99 USD');
    expect(parseAtomicAmount('65099')).toBe(65099n);
    expect(() => parseAtomicAmount('650.99')).toThrow();
    // Display formatting stays exact across the whole accepted range (under 2^53 cents).
    expect(displayMoney('99999999999')).toBe('$999,999,999.99');
    expect(displayMoney('1')).toBe('$0.01');
  });
});

describe.skipIf(!RUN_DB)('PAY-17 — the database boundary', () => {
  it('stores and returns the largest integer money values exactly in bigint and numeric(78,0) columns', async () => {
    const maxBigint = '9223372036854775807';
    const uint256Max = (2n ** 256n - 1n).toString();
    const [row] = await sql`select ${maxBigint}::bigint as big, ${uint256Max}::numeric(78,0) as token, (${maxBigint}::bigint - 1)::text as big_minus_one,
      (${uint256Max}::numeric(78,0) - 1)::text as token_minus_one`;
    expect(String(row!.big)).toBe(maxBigint);
    expect(String(row!.token)).toBe(uint256Max);
    expect(BigInt(String(row!.big_minus_one)) + 1n).toBe(BigInt(maxBigint));
    expect(BigInt(String(row!.token_minus_one)) + 1n).toBe(2n ** 256n - 1n);
    await expect(sql`select (${maxBigint}::bigint + 1) as overflow`).rejects.toThrow(/out of range/);
    await expect(sql`select ${`1${'0'.repeat(78)}`}::numeric(78,0) as overflow`).rejects.toThrow(/overflow/);
  });

  it('an odd-cents price flows exactly through order, provider funding, ledger and receipt', async () => {
    const creator = await createUser('pay17-creator', ['creator']);
    const buyer = await createUser('pay17-buyer', ['buyer']);
    const { serviceId } = await createPublishedService(command, creator, { price: '650.99' });
    const booked = await command(buyer, { command: 'book', service_id: serviceId, brief: 'Precision brief with the audience, goal and three headline options.', accept_terms: 'on' });
    const orderId = String(booked.body.id);
    expect((await sql`select amount_minor from app.orders where id=${orderId}`)[0]!.amount_minor).toBe('65099');
    expect((await callRoute(checkout.POST, '/api/dev/mock-checkout', buyer, { order_id: orderId })).status).toBe(200);
    const [op] = await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create'`;
    expect((await provider.getFundingStatus(String(op!.provider_reference))).amount).toBe(65099n);
    const entries = await sql`select e.account,e.amount_minor from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId} order by e.account`;
    expect(entries.map((e) => [String(e.account).replace(orderId, '<order>'), String(e.amount_minor)])).toEqual([['order_principal:<order>', '-65099'], ['provider_clearing:mock', '65099']]);
    const [receipt] = await sql`select payload from app.outbox where semantic_key=${`notify:payment.confirmed:${orderId}`}`;
    expect((receipt!.payload as { params: { amount: string } }).params.amount).toBe('65099');
  });
});
