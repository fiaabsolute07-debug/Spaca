import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/lib/auth';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { ORIGIN, RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const summaryRoute = await import('@/app/api/funds/summary/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const funds = await import('@/modules/funds/queries');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const actorOf = (user: TestUser, roles: string[]): Actor => ({ id: user.id, email: user.email, display_name: 'x', roles, is_test: true, status: 'ACTIVE', timezone: 'UTC' });
const brief = 'Funds suite brief: audience, goals, required facts and three headline options.';

beforeEach(() => {
  if (RUN_DB) funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_funds_suite_secret_01'] }));
});
afterAll(async () => {
  if (!RUN_DB) return;
  funding.setMockPaymentProviderForTests(undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('Funds — money at a glance, from the order amount and the ledger', () => {
  it('follows one order from waiting for payment, to held, to released, for both sides and nobody else', async () => {
    const buyerUser = await createUser('funds-buyer', ['buyer']);
    const creatorUser = await createUser('funds-creator', ['creator']);
    const stranger = await createUser('funds-stranger', ['buyer']);
    const buyer = actorOf(buyerUser, ['buyer']);
    const creator = actorOf(creatorUser, ['creator']);
    const { serviceId } = await createPublishedService(command, creatorUser, { price: '240' });
    const booked = await command(buyerUser, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, accept_terms: 'on' });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    const orderId = String(booked.body.id);

    let b = await funds.getFundsSummary(buyer);
    expect(b).toMatchObject({ to_pay_minor: '24000', to_pay_count: 1, held_as_buyer_minor: '0', released_by_buyer_minor: '0' });
    expect((await funds.getFundsSummary(creator)).awaiting_buyer_payment_minor).toBe('24000');
    const waiting = await funds.getFundsOverview(buyer);
    expect(waiting.to_pay.map((o) => String(o.id))).toEqual([orderId]);

    expect((await callRoute(checkout.POST, '/api/dev/mock-checkout', buyerUser, { order_id: orderId })).status).toBe(200);
    b = await funds.getFundsSummary(buyer);
    expect(b).toMatchObject({ to_pay_minor: '0', to_pay_count: 0, held_as_buyer_minor: '24000' });
    let c = await funds.getFundsSummary(creator);
    expect(c).toMatchObject({ held_for_creator_minor: '24000', released_to_creator_minor: '0', awaiting_buyer_payment_minor: '0' });
    const held = await funds.getFundsOverview(creator);
    expect(held.held.map((o) => [String(o.id), String(o.held_minor)])).toEqual([[orderId, '24000']]);
    expect(held.activity.map((e) => [String(e.kind), String(e.amount_minor)])).toEqual([['FUNDING_CAPTURED', '24000']]);

    expect((await command(creatorUser, { command: 'start', idempotency_key: key('st'), order_id: orderId })).status).toBe(200);
    expect((await command(creatorUser, { command: 'deliver', idempotency_key: key('dl'), order_id: orderId, body: 'Funds suite: all agreed files and copy are included here.' })).status).toBe(200);
    expect((await command(buyerUser, { command: 'approve', idempotency_key: key('ap'), order_id: orderId, delivery_version: '1' })).status).toBe(200);
    await jobs.releaseReadySettlements({ orderId });

    b = await funds.getFundsSummary(buyer);
    c = await funds.getFundsSummary(creator);
    expect(b).toMatchObject({ held_as_buyer_minor: '0', released_by_buyer_minor: '24000', refunded_to_buyer_minor: '0' });
    expect(c).toMatchObject({ held_for_creator_minor: '0', released_to_creator_minor: '24000' });
    const after = await funds.getFundsOverview(buyer);
    expect(after.held).toHaveLength(0);
    expect(after.activity.map((e) => funds.activityLabel(String(e.kind), e.after_release === true))).toEqual(['Released to the creator', 'Payment captured']);

    // Another account sees none of it.
    const other = await funds.getFundsOverview(actorOf(stranger, ['buyer']));
    expect(other.summary).toMatchObject({ to_pay_count: 0, held_as_buyer_minor: '0', released_by_buyer_minor: '0' });
    expect([other.to_pay, other.held, other.activity, other.pools]).toEqual([[], [], [], []]);
  });

  it('counts a refund, and the summary route needs a session from this site', async () => {
    const buyerUser = await createUser('funds-refund-buyer', ['buyer']);
    const creatorUser = await createUser('funds-refund-creator', ['creator']);
    const { serviceId } = await createPublishedService(command, creatorUser, { price: '90' });
    const orderId = String((await command(buyerUser, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, accept_terms: 'on' })).body.id);
    expect((await callRoute(checkout.POST, '/api/dev/mock-checkout', buyerUser, { order_id: orderId })).status).toBe(200);
    // Cancelled before work starts: the whole amount goes back.
    const cancelled = await command(buyerUser, { command: 'cancel', idempotency_key: key('cx'), order_id: orderId, reason: 'Plans changed before the work started.' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const [order] = await sql`select payment_status from app.orders where id=${orderId}`;
    // The local provider confirms the refund straight after the command, so the ledger has it.
    expect(order!.payment_status).toBe('REFUNDED');
    const summary = await funds.getFundsSummary(actorOf(buyerUser, ['buyer']));
    expect(summary).toMatchObject({ refunded_to_buyer_minor: '9000', held_as_buyer_minor: '0', released_by_buyer_minor: '0' });
    const activity = (await funds.getFundsOverview(actorOf(buyerUser, ['buyer']))).activity;
    expect(activity.map((e) => funds.activityLabel(String(e.kind), e.after_release === true))).toEqual(['Refunded to the buyer', 'Payment captured']);

    const post = (actor: TestUser | null, origin?: string) => {
      sessionState.token = actor?.token ?? null;
      return summaryRoute.POST(new Request(`${ORIGIN}/api/funds/summary`, { method: 'POST', headers: { origin: origin ?? ORIGIN, accept: 'application/json' } }));
    };
    expect((await post(null)).status).toBe(401);
    expect((await post(buyerUser, 'https://evil.example')).status).toBe(403);
    const ok = await post(buyerUser);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toMatchObject({ to_pay_count: 0, refunded_to_buyer_minor: summary.refunded_to_buyer_minor });
  });
});
