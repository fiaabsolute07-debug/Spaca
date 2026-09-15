import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider, type MockPaymentProviderOptions } from '@/modules/payments/providers';
import { RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const bankTransfer = await import('@/app/api/checkout/bank-transfer/route');
const sandboxBank = await import('@/app/api/dev/mock-bank-transfer/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const { sql } = await import('@/lib/db');

let provider: MockPaymentProvider;
function useProvider(options: Partial<MockPaymentProviderOptions> = {}) {
  provider = new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_bank_suite_secret_00001'], bankTransferFunding: true, ...options });
  funding.setMockPaymentProviderForTests(provider);
}

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const payByCard = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const requestBankTransfer = (actor: TestUser, orderId: string) => callRoute(bankTransfer.POST, '/api/checkout/bank-transfer', actor, { order_id: orderId });
/** The sandbox bank answers with redirects; the outcome is read back from the database. */
const bank = async (actor: TestUser, orderId: string, outcome: 'SENT' | 'SETTLED' | 'FAILED' | 'RETURNED') => {
  sessionState.token = actor.token;
  const form = new FormData();
  form.set('order_id', orderId);
  form.set('outcome', outcome);
  const response = await sandboxBank.POST(new Request('http://localhost:3000/api/dev/mock-bank-transfer', { method: 'POST', headers: { origin: 'http://localhost:3000' }, body: form }));
  return decodeURIComponent(new URL(response.headers.get('location')!).search);
};
const orderRow = async (orderId: string) => (await sql`select * from app.orders where id=${orderId}`)[0]!;
const claimOf = async (orderId: string) => (await sql`select state,expires_at from app.workload_claims where order_id=${orderId}`)[0]!;
const count = async (query: Promise<{ count: number }[]>) => (await query)[0]!.count;
const setBankFlag = (enabled: boolean) => sql`update app.feature_flags set enabled=${enabled} where key='BANK_FUNDING_ENABLED'`;
const brief = 'Bank funding brief with the audience, the goal and three headline options.';

async function bookedOrder(label: string) {
  const creator = await createUser(`${label}-creator`, ['creator']);
  const buyer = await createUser(`${label}-buyer`, ['buyer']);
  const { serviceId } = await createPublishedService(command, creator);
  const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, accept_terms: 'on' });
  if (booked.status !== 200) throw new Error(JSON.stringify(booked.body));
  return { creator, buyer, orderId: String(booked.body.id) };
}

beforeAll(async () => {
  if (RUN_DB) await setBankFlag(false);
});
beforeEach(() => {
  if (RUN_DB) useProvider();
});
afterAll(async () => {
  if (RUN_DB) {
    await setBankFlag(false);
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('BNK-03 — bank funding is refused unless switched on and supported', () => {
  it('BNK-03: the direct API refuses bank funding while the flag is off or the provider account cannot take transfers; card checkout is unaffected', async () => {
    const { creator, buyer, orderId } = await bookedOrder('bnk03');
    const off = await requestBankTransfer(buyer, orderId);
    expect(off).toMatchObject({ status: 422, body: { code: 'FEATURE_DISABLED' } });
    expect(await count(sql`select count(*)::int as count from app.provider_operations where order_id=${orderId}`)).toBe(0);

    await setBankFlag(true);
    try {
      // This account pays creators out (releases work) but cannot take bank transfers from buyers.
      useProvider({ bankTransferFunding: false });
      const unsupported = await requestBankTransfer(buyer, orderId);
      expect(unsupported).toMatchObject({ status: 400, body: { code: 'UNSUPPORTED_CAPABILITY' } });
      expect((await requestBankTransfer(creator, orderId)).status).toBe(403);
      const claim = await claimOf(orderId);
      expect(new Date(claim.expires_at).getTime()).toBeLessThan(Date.now() + 16 * 60_000);
      expect(await orderRow(orderId)).toMatchObject({ status: 'AWAITING_PAYMENT', payment_status: 'PENDING' });

      expect((await payByCard(buyer, orderId)).status).toBe(200);
      expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', funding_method: 'CARD' });
    } finally {
      await setBankFlag(false);
    }
  });
});

describe.skipIf(!RUN_DB)('BNK-01/02 — asynchronous bank funding', () => {
  beforeAll(async () => {
    if (RUN_DB) await setBankFlag(true);
  });
  afterAll(async () => {
    if (RUN_DB) await setBankFlag(false);
  });

  it('BNK-01: a bank transfer reserves the order on its own hold and funds nothing until the provider confirms the money arrived', async () => {
    const { creator, buyer, orderId } = await bookedOrder('bnk01');
    const started = await requestBankTransfer(buyer, orderId);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(String(started.body.reference)).toMatch(/^mock_fund_/);
    const claim = await claimOf(orderId);
    expect(claim.state).toBe('HELD');
    expect(new Date(claim.expires_at).getTime()).toBeGreaterThan(Date.now() + 119 * 3_600_000);
    expect(await count(sql`select count(*)::int as count from app.order_events where order_id=${orderId} and kind='BANK_TRANSFER_REQUESTED'`)).toBe(1);
    // Asking again reuses the same transfer.
    expect((await requestBankTransfer(buyer, orderId)).body.reference).toBe(started.body.reference);

    expect(await bank(buyer, orderId, 'SENT')).toContain('on its way');
    expect(await orderRow(orderId)).toMatchObject({ status: 'AWAITING_PAYMENT', payment_status: 'PROCESSING', funded_at: null });
    const start = await command(creator, { command: 'start', idempotency_key: key('s'), order_id: orderId });
    expect(start.status).toBe(409);
    // A transfer on its way cannot be swapped for a card payment, so the order is never paid twice.
    const card = await payByCard(buyer, orderId);
    expect(card.status).toBe(400);
    expect(String(card.body.error)).toMatch(/bank transfer for this order is already on its way/);
    expect((await orderRow(orderId)).status).toBe('AWAITING_PAYMENT');

    expect(await bank(buyer, orderId, 'SETTLED')).toContain('settled');
    expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED', funding_method: 'BANK_TRANSFER' });
    expect((await command(creator, { command: 'start', idempotency_key: key('s'), order_id: orderId })).status).toBe(200);
  });

  it('BNK-02: at the end of the bank hold a transfer still on its way keeps the reservation for reconciliation; an unsent one is released; a failed one is released on the next run', async () => {
    const pending = await bookedOrder('bnk02-pending');
    expect((await requestBankTransfer(pending.buyer, pending.orderId)).status).toBe(200);
    await bank(pending.buyer, pending.orderId, 'SENT');
    await sql`update app.workload_claims set expires_at=now() - interval '1 minute' where order_id=${pending.orderId}`;
    expect((await jobs.expireCheckoutHolds({ orderId: pending.orderId })).outcomes).toEqual({ RECONCILING: 1 });
    expect((await claimOf(pending.orderId)).state).toBe('EXPIRY_RECONCILING');
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${pending.orderId} and kind='HOLD_EXPIRED_PAYMENT_UNRESOLVED'`)).toBe(1);
    await bank(pending.buyer, pending.orderId, 'SETTLED');
    expect(await orderRow(pending.orderId)).toMatchObject({ status: 'FUNDED', funding_method: 'BANK_TRANSFER' });

    const unsent = await bookedOrder('bnk02-unsent');
    expect((await requestBankTransfer(unsent.buyer, unsent.orderId)).status).toBe(200);
    await sql`update app.workload_claims set expires_at=now() - interval '1 minute' where order_id=${unsent.orderId}`;
    expect((await jobs.expireCheckoutHolds({ orderId: unsent.orderId })).outcomes).toEqual({ RELEASED: 1 });
    expect(await orderRow(unsent.orderId)).toMatchObject({ status: 'CANCELLED' });
    expect(await bank(unsent.buyer, unsent.orderId, 'SETTLED')).toContain('cannot do that now');
    expect((await orderRow(unsent.orderId)).payment_status).not.toBe('SUCCEEDED');

    const failed = await bookedOrder('bnk02-failed');
    expect((await requestBankTransfer(failed.buyer, failed.orderId)).status).toBe(200);
    await bank(failed.buyer, failed.orderId, 'SENT');
    await sql`update app.workload_claims set expires_at=now() - interval '1 minute' where order_id=${failed.orderId}`;
    expect((await jobs.expireCheckoutHolds({ orderId: failed.orderId })).outcomes).toEqual({ RECONCILING: 1 });
    await bank(failed.buyer, failed.orderId, 'FAILED');
    expect((await orderRow(failed.orderId)).payment_status).toBe('FAILED');
    expect((await jobs.expireCheckoutHolds({ orderId: failed.orderId })).outcomes).toEqual({ RELEASED: 1 });
    expect((await claimOf(failed.orderId)).state).toBe('RELEASED');
  });

  it('BNK-02: a returned transfer cancels an order not yet started; after work started it freezes the payout and alerts operators', async () => {
    const early = await bookedOrder('bnk02-return-early');
    await requestBankTransfer(early.buyer, early.orderId);
    await bank(early.buyer, early.orderId, 'SETTLED');
    expect(await bank(early.buyer, early.orderId, 'RETURNED')).toContain('returned');
    expect(await orderRow(early.orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'RETURNED', settlement_status: 'NOT_READY' });
    expect((await claimOf(early.orderId)).state).toBe('RELEASED');
    expect((await sql`select sum(e.amount_minor)::text as total from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${early.orderId}`)[0]!.total).toBe('0');
    expect(await count(sql`select count(*)::int as count from app.outbox where semantic_key like ${`notify:payment.returned:${early.orderId}:%`}`)).toBe(2);

    const late = await bookedOrder('bnk02-return-late');
    await requestBankTransfer(late.buyer, late.orderId);
    await bank(late.buyer, late.orderId, 'SETTLED');
    const step = (actor: TestUser, fields: Record<string, string>) => command(actor, { idempotency_key: key('step'), order_id: late.orderId, ...fields });
    expect((await step(late.creator, { command: 'start' })).status).toBe(200);
    expect((await step(late.creator, { command: 'deliver', body: 'Final launch thread with sources and the CTA.' })).status).toBe(200);
    expect((await step(late.buyer, { command: 'approve', delivery_version: '1' })).status).toBe(200);
    await bank(late.buyer, late.orderId, 'RETURNED');
    expect(await orderRow(late.orderId)).toMatchObject({ status: 'APPROVED', payment_status: 'RETURNED', settlement_status: 'READY' });
    expect((await jobs.releaseReadySettlements({ orderId: late.orderId })).examined).toBe(0);
    expect(await count(sql`select count(*)::int as count from app.reconciliation_cases where order_id=${late.orderId} and kind='BANK_FUNDS_RETURNED' and status='OPEN'`)).toBe(1);
    expect(await count(sql`select count(*)::int as count from app.deliveries where order_id=${late.orderId}`)).toBe(1);
    // A card order can never be marked returned.
    await expect(sql`update app.orders set payment_status='RETURNED' where id=${(await bookedOrder('bnk02-card')).orderId}`).rejects.toThrow(/orders_returned_is_bank/);
  });
});
