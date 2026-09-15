import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider, signMockWebhook } from '@/modules/payments/providers';
import { ORIGIN, RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const bankTransfer = await import('@/app/api/checkout/bank-transfer/route');
const intents = await import('@/app/api/assets/upload-intents/route');
const webhook = await import('@/app/api/webhooks/mock-payment/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const readModel = await import('@/lib/read-model');
const { hashSessionToken } = await import('@/lib/auth');
const { sql } = await import('@/lib/db');

const SECRET = 'whsec_security_suite_secret_01';
let provider: MockPaymentProvider;
const command = (actor: TestUser | null, fields: Record<string, string>, options: { origin?: string } = {}) => callRoute(commands.POST, '/api/commands', actor, { idempotency_key: key('sec'), ...fields }, options);
const pay = (actor: TestUser | null, orderId: string, options: { origin?: string } = {}) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId }, options);
const orderRow = async (orderId: string) => (await sql`select * from app.orders where id=${orderId}`)[0]!;
const actorOf = (user: TestUser, roles: string[]) => ({ id: user.id, email: user.email, display_name: 'x', roles, is_test: true, status: 'ACTIVE' as const, timezone: 'UTC' });
const brief = 'Security suite brief with the audience, goal and three headline options.';

async function deliveredOrder(label: string) {
  const creator = await createUser(`${label}-creator`, ['creator']);
  const buyer = await createUser(`${label}-buyer`, ['buyer']);
  const { serviceId } = await createPublishedService(command, creator);
  const booked = await command(buyer, { command: 'book', service_id: serviceId, brief, accept_terms: 'on' });
  if (booked.status !== 200) throw new Error(JSON.stringify(booked.body));
  const orderId = String(booked.body.id);
  expect((await pay(buyer, orderId)).status).toBe(200);
  expect((await command(creator, { command: 'start', order_id: orderId })).status).toBe(200);
  expect((await command(creator, { command: 'deliver', order_id: orderId, body: 'Launch thread v1 with sources and the CTA.' })).status).toBe(200);
  return { creator, buyer, orderId, serviceId };
}

beforeEach(() => {
  if (!RUN_DB) return;
  provider = new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: [SECRET] });
  funding.setMockPaymentProviderForTests(provider);
});
afterAll(async () => {
  if (RUN_DB) {
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('SEC-01/SEC-02 — foreign buyers and creators', () => {
  it('SEC-01: a foreign buyer can neither read the order nor act on it, and nothing changes', async () => {
    const { creator, buyer, orderId } = await deliveredOrder('sec01');
    const stranger = await createUser('sec01-stranger', ['buyer']);
    const before = await orderRow(orderId);
    const attempts: Record<string, string>[] = [
      { command: 'approve', delivery_version: '1' },
      { command: 'revision', delivery_version: '1', body: 'Change everything please.' },
      { command: 'dispute', body: 'This is not what I paid for.' },
      { command: 'message', body: 'Hello from a stranger.' },
      { command: 'request_cancellation', refund_amount: '650', reason: 'I want this cancelled now.' },
      { command: 'cancel' },
      { command: 'review', rating: '1', body: 'Terrible.' },
      { command: 'mark_delivery_viewed' },
      { command: 'refund_digital_purchase' },
      { command: 'request_deadline_extension', new_due_at: '2099-01-01T00:00', reason: 'Stranger wants more time.' },
    ];
    for (const fields of attempts) {
      const result = await command(stranger, { ...fields, order_id: orderId });
      expect(result.status, `${fields.command}: ${JSON.stringify(result.body)}`).toBe(403);
    }
    expect((await pay(stranger, orderId)).status).toBe(403);
    expect((await callRoute(bankTransfer.POST, '/api/checkout/bank-transfer', stranger, { order_id: orderId })).status).not.toBe(200);
    expect((await command(stranger, { command: 'create_crypto_payment', order_id: orderId, chain_id: '31337' })).status).toBeGreaterThanOrEqual(403);
    expect(await readModel.getOrderData(actorOf(stranger, ['buyer']), orderId)).toBeNull();

    const after = await orderRow(orderId);
    expect({ status: after.status, version: after.version, payment: after.payment_status }).toEqual({ status: before.status, version: before.version, payment: before.payment_status });
    expect((await sql`select count(*)::int as n from app.messages where order_id=${orderId}`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int as n from app.disputes where order_id=${orderId}`)[0]!.n).toBe(0);
    // The real parties still can.
    expect((await command(buyer, { command: 'message', order_id: orderId, body: 'Looks good so far.' })).status).toBe(200);
    expect((await command(creator, { command: 'message', order_id: orderId, body: 'Thanks!' })).status).toBe(200);
  });

  it('SEC-02: a foreign creator cannot see the brief, deliver, upload to the order or answer its requests; payee and price come from the service', async () => {
    const { creator, buyer, orderId, serviceId } = await deliveredOrder('sec02');
    const rival = await createUser('sec02-rival', ['creator']);
    expect(await readModel.getOrderData(actorOf(rival, ['creator']), orderId)).toBeNull();
    const rivalAttempts: Record<string, string>[] = [
      { command: 'start' },
      { command: 'deliver', body: 'A rival delivery trying to replace the work.' },
      { command: 'message', body: 'Rival message.' },
      { command: 'request_deadline_extension', new_due_at: '2099-01-01T00:00', reason: 'Rival wants more time.' },
    ];
    for (const fields of rivalAttempts) expect((await command(rival, { ...fields, order_id: orderId })).status, fields.command).toBe(403);
    const cancellation = await command(buyer, { command: 'request_cancellation', order_id: orderId, refund_amount: '100', reason: 'Scope changed on our side.' });
    expect(cancellation.status).toBe(200);
    expect((await command(rival, { command: 'respond_cancellation', request_id: String(cancellation.body.id), decision: 'accept' })).status).toBe(403);
    const upload = await callRoute(intents.POST, '/api/assets/upload-intents', rival, { purpose: 'DELIVERY', filename: 'x.png', mime: 'image/png', size: '10', order_id: orderId });
    expect(upload.status).toBe(404);
    expect((await command(rival, { command: 'update_service', service_id: serviceId, title: 'Hijacked', description: 'A rival edits someone else’s service.', price: '1', turnaround_hours: '1', expected_version: '1' })).status).toBeGreaterThanOrEqual(403);
    expect((await sql`select title,price_minor from app.services where id=${serviceId}`)[0]).not.toMatchObject({ title: 'Hijacked' });
    expect((await sql`select count(*)::int as n from app.deliveries where order_id=${orderId}`)[0]!.n).toBe(1);
    expect((await orderRow(orderId)).creator_id).toBe(creator.id);
  });
});

describe.skipIf(!RUN_DB)('SEC-04 — client-supplied money, payee and state are ignored', () => {
  it('SEC-04: price, fee, currency, payee, creator and status fields in requests never reach the order or the provider', async () => {
    const creator = await createUser('sec04-creator', ['creator']);
    const buyer = await createUser('sec04-buyer', ['buyer']);
    const { serviceId } = await createPublishedService(command, creator, { price: '650' });
    const booked = await command(buyer, {
      command: 'book', service_id: serviceId, brief, accept_terms: 'on',
      price: '1', amount: '1', amount_minor: '100', platform_fee: '5', platform_fee_minor: '500', provider_fee_minor: '1', currency: 'EUR',
      payee_account_id: 'acct_attacker_000001', creator_id: buyer.id, buyer_id: creator.id, status: 'FUNDED', payment_status: 'SUCCEEDED',
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    const orderId = String(booked.body.id);
    expect(await orderRow(orderId)).toMatchObject({ amount_minor: '65000', platform_fee_minor: '0', currency: 'USD', creator_id: creator.id, buyer_id: buyer.id, status: 'AWAITING_PAYMENT', payment_status: 'PENDING' });

    const paid = await callRoute(checkout.POST, '/api/dev/mock-checkout', buyer, { order_id: orderId, amount: '1', payee_account_id: 'acct_attacker_000001', platform_fee: '9' });
    expect(paid.status).toBe(200);
    const [fund] = await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create'`;
    const status = await provider.getFundingStatus(String(fund!.provider_reference));
    expect({ amount: status.amount, payee: status.payeeAccountId, fee: status.platformFee }).toEqual({ amount: 65000n, payee: `acct_mock_${creator.id.replaceAll('-', '')}`, fee: 0n });

    const step = (actor: TestUser, fields: Record<string, string>) => command(actor, { order_id: orderId, ...fields });
    expect((await step(creator, { command: 'start' })).status).toBe(200);
    expect((await step(creator, { command: 'deliver', body: 'Final thread with sources and the CTA.', amount_minor: '1', payee_account_id: 'acct_attacker_000001' })).status).toBe(200);
    expect((await step(buyer, { command: 'approve', delivery_version: '1', settlement_amount: '1', payee: 'acct_attacker_000001' })).status).toBe(200);
    await jobs.releaseReadySettlements({ orderId });
    const [release] = await sql`select outcome->>'netAmount' as net from app.provider_operations where order_id=${orderId} and kind='release.create'`;
    expect(release!.net).toBe('65000');
    expect(await orderRow(orderId)).toMatchObject({ status: 'COMPLETED', platform_fee_minor: '0' });
  });
});

describe.skipIf(!RUN_DB)('SEC-08 — foreign origins and expired sessions on money routes', () => {
  it('SEC-08: cross-origin calls are refused and an expired session cannot book, pay, approve or request a transfer', async () => {
    const { buyer, orderId, serviceId } = await deliveredOrder('sec08');
    const attacker = 'https://attacker.example';
    expect((await command(buyer, { command: 'approve', order_id: orderId, delivery_version: '1' }, { origin: attacker })).status).toBe(403);
    expect((await pay(buyer, orderId, { origin: attacker })).status).toBe(403);
    expect((await callRoute(bankTransfer.POST, '/api/checkout/bank-transfer', buyer, { order_id: orderId }, { origin: attacker })).status).toBe(403);
    expect((await callRoute(intents.POST, '/api/assets/upload-intents', buyer, { purpose: 'BRIEF', filename: 'b.pdf', mime: 'application/pdf', size: '10', order_id: orderId }, { origin: attacker })).status).toBe(403);

    await sql`update app.sessions set expires_at=now() - interval '1 minute' where token_hash=${hashSessionToken(buyer.token)}`;
    expect((await command(buyer, { command: 'approve', order_id: orderId, delivery_version: '1' })).status).toBe(401);
    expect((await command(buyer, { command: 'book', service_id: serviceId, brief, accept_terms: 'on' })).status).toBe(401);
    expect((await pay(buyer, orderId)).status).toBe(401);
    expect((await callRoute(bankTransfer.POST, '/api/checkout/bank-transfer', buyer, { order_id: orderId })).status).toBe(401);
    expect((await orderRow(orderId)).status).toBe('DELIVERED');
  });
});

describe.skipIf(!RUN_DB)('SEC-10 — suspended sellers keep their obligations', () => {
  it('SEC-10: a suspended creator can still answer a refund request and a deadline proposal, and the buyer still gets the refund', async () => {
    const creator = await createUser('sec10-creator', ['creator']);
    const buyer = await createUser('sec10-buyer', ['buyer']);
    const { serviceId } = await createPublishedService(command, creator);
    const orderId = String((await command(buyer, { command: 'book', service_id: serviceId, brief, accept_terms: 'on' })).body.id);
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await command(creator, { command: 'start', order_id: orderId })).status).toBe(200);
    await sql`update app.users set status='SUSPENDED' where id=${creator.id}`;
    try {
      const due = (await orderRow(orderId)).delivery_due_at;
      const proposal = await command(buyer, { command: 'request_deadline_extension', order_id: orderId, new_due_at: new Date(new Date(due).getTime() + 86_400_000).toISOString().slice(0, 16), reason: 'We need the post a day later.' });
      expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
      expect((await command(creator, { command: 'respond_deadline_extension', amendment_id: String(proposal.body.id), decision: 'accept' })).status).toBe(200);

      const request = await command(buyer, { command: 'request_cancellation', order_id: orderId, refund_amount: '650', reason: 'The creator account was suspended.' });
      expect(request.status).toBe(200);
      const accepted = await command(creator, { command: 'respond_cancellation', request_id: String(request.body.id), decision: 'accept' });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      await funding.deliverPendingMockWebhooks();
      expect(await orderRow(orderId)).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED' });
      expect(await readModel.getOrderData(actorOf(creator, ['creator']), orderId)).not.toBeNull();
      // New business stays blocked.
      expect((await command(creator, { command: 'create_service', title: 'New while suspended', description: 'Should not be created while suspended.', taxonomy: 'CREATE', price: '10', turnaround_hours: '24' })).status).toBe(403);
    } finally {
      await sql`update app.users set status='ACTIVE' where id=${creator.id}`;
    }
  });
});

describe.skipIf(!RUN_DB)('FND-05 / PAY-09 — switched-off sales and wrong-environment facts', () => {
  it('FND-05: with crypto checkout off, the direct command is refused and no payment intent is written', async () => {
    const creator = await createUser('fnd05-creator', ['creator']);
    const buyer = await createUser('fnd05-buyer', ['buyer']);
    const { serviceId } = await createPublishedService(command, creator);
    const orderId = String((await command(buyer, { command: 'book', service_id: serviceId, brief, accept_terms: 'on' })).body.id);
    const [flag] = await sql`select enabled from app.feature_flags where key='CRYPTO_CHECKOUT_ENABLED'`;
    await sql`update app.feature_flags set enabled=false where key='CRYPTO_CHECKOUT_ENABLED'`;
    try {
      const refused = await command(buyer, { command: 'create_crypto_payment', order_id: orderId, chain_id: '31337' });
      expect(refused.status).toBe(422);
      expect(String(refused.body.error)).toMatch(/CRYPTO_CHECKOUT_ENABLED/);
      expect((await sql`select count(*)::int as n from app.crypto_payment_intents where order_id=${orderId}`)[0]!.n).toBe(0);
    } finally {
      await sql`update app.feature_flags set enabled=${flag!.enabled} where key='CRYPTO_CHECKOUT_ENABLED'`;
    }
  });

  it('PAY-09: a correctly signed event from another environment is refused before the inbox', async () => {
    const creator = await createUser('pay09-creator', ['creator']);
    const buyer = await createUser('pay09-buyer', ['buyer']);
    const { serviceId } = await createPublishedService(command, creator);
    const orderId = String((await command(buyer, { command: 'book', service_id: serviceId, brief, accept_terms: 'on' })).body.id);
    const eventId = `evt_live_${key('e')}`;
    const body = new TextEncoder().encode(JSON.stringify({
      id: eventId, type: 'funding.succeeded', mode: 'live', account: 'acct_mock_local', created: new Date().toISOString(),
      data: { objectType: 'funding', reference: 'mock_fund_live_000000000001', fundingReference: 'mock_fund_live_000000000001', operationId: `fund:${orderId}:1`, orderId, status: 'SUCCEEDED', amount: '65000', currency: 'USD', providerFee: '0' },
    }));
    const headers = new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, SECRET, Math.floor(Date.now() / 1000)) });
    const response = await webhook.POST(new Request(`${ORIGIN}/api/webhooks/mock-payment`, { method: 'POST', headers, body }));
    expect(response.status).toBe(400);
    expect((await sql`select count(*)::int as n from app.webhook_inbox where event_id=${eventId}`)[0]!.n).toBe(0);
    expect((await orderRow(orderId)).status).toBe('AWAITING_PAYMENT');
  });
});
