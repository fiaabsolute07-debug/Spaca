import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockPaymentProvider, type MockPaymentProviderOptions } from '@/modules/payments/providers';
import { ORIGIN, RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const intents = await import('@/app/api/assets/upload-intents/route');
const finalizeRoute = await import('@/app/api/assets/[id]/finalize/route');
const devUpload = await import('@/app/api/dev/storage/upload/[token]/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const storage = await import('@/modules/storage/provider');
const { sql } = await import('@/lib/db');

let provider: MockPaymentProvider;
let root = '';
function useProvider(options: Partial<MockPaymentProviderOptions> = {}) {
  provider = new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_races_suite_secret_0001'], ...options });
  funding.setMockPaymentProviderForTests(provider);
}
const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, { idempotency_key: key('race'), ...fields });
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const orderRow = async (orderId: string) => (await sql`select * from app.orders where id=${orderId}`)[0]!;
const brief = 'Race suite brief with the audience, goal and three headline options.';
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const count = async (query: Promise<{ n: number }[]>) => (await query)[0]!.n;
const principalOf = async (orderId: string) => String((await sql`select coalesce(sum(e.amount_minor),0)::text as total from app.ledger_entries e
  join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId} and e.account=${`order_principal:${orderId}`}`)[0]!.total);
const ledgerTotal = async (orderId: string) => String((await sql`select coalesce(sum(e.amount_minor),0)::text as total from app.ledger_entries e
  join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId}`)[0]!.total);

async function financeUser(): Promise<TestUser> {
  const { createSession } = await import('@/lib/auth');
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${`it-race-finance-${key('f')}@example.test`},'IT finance',${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},'finance','Race suite operator grant')`;
  return { id: user!.id, email: '', token: await createSession(user!.id) };
}

async function deliveredOrder(label: string) {
  const creator = await createUser(`${label}-creator`, ['creator']);
  const buyer = await createUser(`${label}-buyer`, ['buyer']);
  const { serviceId } = await createPublishedService(command, creator);
  const orderId = String((await command(buyer, { command: 'book', service_id: serviceId, brief, accept_terms: 'on' })).body.id);
  expect((await pay(buyer, orderId)).status).toBe(200);
  expect((await command(creator, { command: 'start', order_id: orderId })).status).toBe(200);
  expect((await command(creator, { command: 'deliver', order_id: orderId, body: 'Launch thread with sources and the CTA.' })).status).toBe(200);
  return { creator, buyer, orderId };
}

beforeAll(async () => {
  if (!RUN_DB) return;
  root = await mkdtemp(join(tmpdir(), 'cm-races-it-'));
  await sql`update app.feature_flags set enabled=true where key='DIGITAL_PRODUCTS_ENABLED'`;
});
beforeEach(() => {
  if (!RUN_DB) return;
  storage.setStorageProviderForTests(new storage.LocalStorageProvider({ root, secret: 'races_suite_signing_secret_0001' }));
  useProvider();
});
afterAll(async () => {
  if (!RUN_DB) return;
  await sql`update app.feature_flags set enabled=false where key='DIGITAL_PRODUCTS_ENABLED'`;
  storage.setStorageProviderForTests(undefined);
  funding.setMockPaymentProviderForTests(undefined);
  await rm(root, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('PAY-13 / ORD-15 — refund and release against one principal', () => {
  it('PAY-13: accepting a full-refund cancellation races the buyer approving and the release job; exactly one money movement happens', async () => {
    // Automatic approval deliberately waits while a cancellation request is open, so the competing path is the buyer's own
    // approval followed by the release job. Staggered starts make both interleavings occur.
    const acceptDelays = [0, 0, 0, 25];
    const approveDelays = [60, 25, 0, 0];
    const outcomes: string[] = [];
    for (let round = 0; round < acceptDelays.length; round++) {
      const { creator, buyer, orderId } = await deliveredOrder(`pay13-${round}`);
      const request = await command(buyer, { command: 'request_cancellation', order_id: orderId, refund_amount: '650', reason: 'Our launch was cancelled this week.' });
      expect(request.status, JSON.stringify(request.body)).toBe(200);
      await sql`update app.orders set review_due_at=now() - interval '1 minute' where id=${orderId}`;
      expect((await jobs.autoAcceptDeliveries({ orderId })).outcomes).toEqual({ SKIPPED_CANCELLATION: 1 });

      const [accepted, approved] = await Promise.all([
        new Promise((resolve) => setTimeout(resolve, acceptDelays[round])).then(() => command(creator, { command: 'respond_cancellation', request_id: String(request.body.id), decision: 'accept' })),
        (async () => { await new Promise((resolve) => setTimeout(resolve, approveDelays[round])); const result = await command(buyer, { command: 'approve', order_id: orderId, delivery_version: '1' }); await jobs.releaseReadySettlements({ orderId }); return result; })(),
      ]);
      await funding.deliverPendingMockWebhooks();
      await jobs.releaseReadySettlements({ orderId });

      expect([accepted.status, approved.status].filter((status) => status === 200)).toHaveLength(1);
      const moves = (await sql`select kind from app.provider_operations where order_id=${orderId} and kind in ('refund.create','release.create')`).map((r) => r.kind);
      const order = await orderRow(orderId);
      if (accepted.status === 200) {
        expect(moves).toEqual(['refund.create']);
        expect(order.status).toBe('REFUNDED');
      } else {
        expect(moves).toEqual(['release.create']);
        expect(order.status).toBe('COMPLETED');
        expect((await sql`select status from app.cancellation_requests where id=${String(request.body.id)}`)[0]!.status).toBe('EXPIRED');
      }
      outcomes.push(String(order.status));
      expect(await principalOf(orderId)).toBe('0');
      expect(await ledgerTotal(orderId)).toBe('0');
    }
    // Both orders of arrival are expected across the rounds.
    expect(new Set(outcomes).size).toBe(2);
  });
});

describe.skipIf(!RUN_DB)('PAY-14 — cumulative refunds stay bounded under concurrency', () => {
  it('PAY-14: concurrent refunds after release serialize; together they never exceed what was transferred, and full refund comes only from provider facts', async () => {
    const { buyer, orderId } = await deliveredOrder('pay14');
    expect((await command(buyer, { command: 'approve', order_id: orderId, delivery_version: '1' })).status).toBe(200);
    await jobs.releaseReadySettlements({ orderId });
    expect((await orderRow(orderId)).status).toBe('COMPLETED');
    const finance = await financeUser();
    const reason = 'Buyer reported a duplicate charge; refund approved.';
    const refund = (amount: string) => command(finance, { command: 'admin_refund_after_release', order_id: orderId, amount, reason });

    const results = await Promise.all([refund('300'), refund('400'), refund('500')]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    await funding.deliverPendingMockWebhooks();
    const [first] = await sql`select amount_minor,status from app.post_release_refunds where order_id=${orderId}`;
    expect(first!.status).toBe('REFUNDED');
    const remaining = 65000 - Number(first!.amount_minor);

    const more = await Promise.all([refund(String((remaining + 1) / 100)), refund(String(remaining / 100))]);
    expect(more.map((r) => r.status).sort()).toEqual([200, 409]);
    await funding.deliverPendingMockWebhooks();
    expect((await refund('0.01')).status).toBe(409);
    const [totals] = await sql`select sum(amount_minor)::text as refunded, count(*)::int as n, bool_and(status='REFUNDED') as all_confirmed from app.post_release_refunds where order_id=${orderId}`;
    expect(totals).toEqual({ refunded: '65000', n: 2, all_confirmed: true });
    const [fund] = await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create'`;
    expect((await provider.getFundingStatus(String(fund!.provider_reference))).refundedSucceeded).toBe(65000n);
    expect(await ledgerTotal(orderId)).toBe('0');
  });
});

describe.skipIf(!RUN_DB)('CAP-10 / REQ-07 — hire timers against acceptance and funding', () => {
  async function selectedOffer(label: string) {
    const buyer = await createUser(`${label}-buyer`, ['buyer']);
    const maker = await createUser(`${label}-creator`, ['creator']);
    await createPublishedService(command, maker);
    const created = await command(buyer, { command: 'create_request', title: `Race campaign ${label}`, brief: 'Launch threads for our public beta across several creators this month.',
      taxonomy: 'CREATE', budget: '500', target_hires: '1', deadline: commandInstant(new Date(Date.now() + 14 * 86_400_000)) });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const requestId = String(created.body.id);
    expect((await command(maker, { command: 'apply', request_id: requestId, quote: '200', turnaround_hours: '48', note: 'Shipped launch threads for three developer tools.' })).status).toBe(200);
    const [application] = await sql`select id,version from app.applications where request_id=${requestId} and creator_id=${maker.id}`;
    const offer = await command(buyer, { command: 'select_application', application_id: String(application!.id), application_version: String(application!.version) });
    expect(offer.status, JSON.stringify(offer.body)).toBe(200);
    return { buyer, maker, requestId, offerId: String(offer.body.id) };
  }
  const consistent = async (requestId: string) => {
    const [request] = await sql`select reserved_minor,committed_minor from app.requests where id=${requestId}`;
    const [sums] = await sql`select coalesce(sum(amount_minor) filter (where state='HELD'),0)::text as held, coalesce(sum(amount_minor) filter (where state='COMMITTED'),0)::text as committed
      from app.request_budget_reservations where request_id=${requestId}`;
    expect({ reserved: String(request!.reserved_minor), committed: String(request!.committed_minor) }).toEqual({ reserved: sums!.held, committed: sums!.committed });
  };

  it('REQ-07: accepting an offer races its expiry job; each offer ends accepted with its order and hold, or expired with nothing left behind', async () => {
    for (let round = 0; round < 6; round++) {
      const { maker, requestId, offerId } = await selectedOffer(`req07-${round}`);
      await sql`update app.hire_offers set expires_at=now() + (${round * 15} * interval '1 millisecond') where id=${offerId}`;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await Promise.all([command(maker, { command: 'accept_offer', offer_id: offerId }), jobs.expireHireOffers({ requestId })]);
      const [offer] = await sql`select status,order_id from app.hire_offers where id=${offerId}`;
      const [reservation] = await sql`select state,order_id from app.request_budget_reservations where offer_id=${offerId}`;
      expect(['ACCEPTED', 'EXPIRED']).toContain(offer!.status);
      if (offer!.status === 'ACCEPTED') {
        expect(reservation).toMatchObject({ state: 'HELD' });
        expect(reservation!.order_id).not.toBeNull();
        expect((await sql`select state from app.workload_claims where order_id=${String(reservation!.order_id)}`)[0]!.state).toBe('HELD');
      } else {
        expect(reservation).toMatchObject({ state: 'RELEASED', order_id: null });
        expect(await count(sql`select count(*)::int as n from app.orders where source='REQUEST' and source_ref=${requestId}`)).toBe(0);
      }
      await consistent(requestId);
    }
  });

  it('CAP-10: the provider confirming payment races the hold expiry job; the hire is funded and committed exactly once either way', async () => {
    for (let round = 0; round < 3; round++) {
      const { buyer, maker, requestId, offerId } = await selectedOffer(`cap10-${round}`);
      const accepted = await command(maker, { command: 'accept_offer', offer_id: offerId });
      expect(accepted.status).toBe(200);
      const orderId = String(accepted.body.id);
      const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, buyer.id, orderId));
      if (intent.state !== 'READY') throw new Error('intent not ready');
      await provider.simulateFundingOutcome(intent.reference, { status: 'SUCCEEDED' });
      const deliveries = provider.takeWebhookDeliveries();
      await sql`update app.workload_claims set expires_at=now() - interval '1 second' where order_id=${orderId}`;

      await Promise.all([
        (async () => { for (const d of deliveries) await funding.receivePaymentWebhook(d.rawBody, d.headers); })(),
        jobs.expireCheckoutHolds({ orderId }),
      ]);
      await jobs.expireCheckoutHolds({ orderId });
      expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED' });
      expect((await sql`select state from app.workload_claims where order_id=${orderId}`)[0]!.state).toBe('ACTIVE');
      expect((await sql`select state from app.request_budget_reservations where offer_id=${offerId}`)[0]!.state).toBe('COMMITTED');
      expect(await count(sql`select count(*)::int as n from app.ledger_transactions where order_id=${orderId} and kind='FUNDING_CAPTURED'`)).toBe(1);
      await consistent(requestId);
    }
  });
});

async function exclusiveProduct(label: string) {
    const creator = await createUser(`${label}-creator`, ['creator']);
    const created = await command(creator, { command: 'create_service', title: `Exclusive launch kit ${label}`, description: 'One exclusive set of launch templates for a single project.',
      taxonomy: 'DIGITAL', price: '40', turnaround_hours: '1', digital_license: 'EXCLUSIVE', digital_rights_text: 'Exclusive use for one project. Do not resell or share the files.', digital_updates: 'LATEST', digital_download_limit: '5',
      sample_url_1: 'https://example.com/preview', sample_title_1: 'Preview' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const serviceId = String(created.body.id);
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode('exclusive kit')]);
    const intent = await callRoute(intents.POST, '/api/assets/upload-intents', creator, { purpose: 'DIGITAL', filename: 'kit.zip', mime: 'application/zip', size: String(bytes.byteLength) });
    const url = String((intent.body.upload as { url: string }).url);
    expect((await devUpload.PUT(new Request(`${ORIGIN}${url}`, { method: 'PUT', headers: { 'content-type': 'application/zip' }, body: new Blob([bytes.slice()]) }), params({ token: url.split('/').pop()! }))).status).toBe(200);
    expect((await callRoute((request) => finalizeRoute.POST(request, params({ id: String(intent.body.id) })), '/api/assets/x/finalize', creator, {})).body.state).toBe('READY');
    expect((await command(creator, { command: 'add_digital_release', service_id: serviceId, asset_ids: String(intent.body.id) })).status).toBe(200);
    expect((await command(creator, { command: 'publish_service', service_id: serviceId })).status).toBe(200);
    return { creator, serviceId };
}

describe.skipIf(!RUN_DB)('CAP-04 — uncertain payment keeps an exclusive sale from being sold twice', () => {
  it('CAP-04: an UNKNOWN payment attempt keeps the exclusive license reserved through hold expiry; a competing buyer racing the expiry cannot take it', async () => {
    const { serviceId } = await exclusiveProduct('cap04');
    const buy = (buyer: TestUser) => command(buyer, { command: 'book', service_id: serviceId, accept_license: 'on', accept_terms: 'on' });

    const first = await createUser('cap04-first', ['buyer']);
    const booked = await buy(first);
    expect(booked.status).toBe(200);
    const orderId = String(booked.body.id);
    useProvider({ failureInjection: [{ kind: 'funding.create', effect: 'ACCEPT_THEN_TIMEOUT' }] });
    expect((await pay(first, orderId)).status).toBe(503);
    expect((await sql`select status from app.provider_operations where order_id=${orderId}`)[0]!.status).toBe('UNKNOWN');
    await sql`update app.digital_entitlements set expires_at=now() - interval '1 second' where order_id=${orderId}`;

    const rivals = await Promise.all([1, 2, 3].map((n) => createUser(`cap04-rival-${n}`, ['buyer'])));
    const [expiry, ...attempts] = await Promise.all([jobs.expireCheckoutHolds({ orderId }), ...rivals.map((rival) => buy(rival))]);
    expect(attempts.every((a) => a.status === 409)).toBe(true);
    expect(expiry.outcomes).toEqual({ RECONCILING: 1 });
    expect((await sql`select state from app.digital_entitlements where order_id=${orderId}`)[0]!.state).toBe('EXPIRY_RECONCILING');

    // The provider did create the attempt; the buyer then pays, and the verified payment wins over the expired hold.
    expect((await jobs.reconcileProviderOperations({ orderId, minAgeSeconds: 0 })).outcomes).toMatchObject({ RESOLVED_APPLIED: 1 });
    const [op] = await sql`select provider_reference from app.provider_operations where order_id=${orderId} and kind='funding.create'`;
    await provider.simulateFundingOutcome(String(op!.provider_reference), { status: 'SUCCEEDED' });
    await funding.deliverPendingMockWebhooks();
    expect((await orderRow(orderId)).status).toBe('DELIVERED');
    expect((await buy(rivals[0]!)).status).toBe(409);
    expect(await count(sql`select count(*)::int as n from app.digital_entitlements where service_id=${serviceId} and state in ('HELD','EXPIRY_RECONCILING','ACTIVE')`)).toBe(1);
  });
});

describe.skipIf(!RUN_DB)('CAP-05 — late funds after the sale went to someone else', () => {
  it('CAP-05: money captured for a released exclusive license after it was resold is booked, refunded in full and never becomes a second license', async () => {
    const { serviceId } = await exclusiveProduct('cap05');
    const buy = (buyer: TestUser) => command(buyer, { command: 'book', service_id: serviceId, accept_license: 'on', accept_terms: 'on' });
    const late = await createUser('cap05-late', ['buyer']);
    const lateOrder = String((await buy(late)).body.id);
    const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, late.id, lateOrder));
    if (intent.state !== 'READY') throw new Error('intent not ready');
    await sql`update app.digital_entitlements set expires_at=now() - interval '1 second' where order_id=${lateOrder}`;
    expect((await jobs.expireCheckoutHolds({ orderId: lateOrder })).outcomes).toEqual({ RELEASED: 1 });
    expect((await orderRow(lateOrder)).status).toBe('CANCELLED');

    const winner = await createUser('cap05-winner', ['buyer']);
    const winnerOrder = String((await buy(winner)).body.id);
    expect((await pay(winner, winnerOrder)).status).toBe(200);
    expect((await orderRow(winnerOrder)).status).toBe('DELIVERED');

    // The first buyer's capture completes at the provider after all.
    await provider.simulateLateCapture(intent.reference);
    await funding.deliverPendingMockWebhooks();
    expect(await orderRow(lateOrder)).toMatchObject({ status: 'CANCELLED' });
    expect(await count(sql`select count(*)::int as n from app.reconciliation_cases where order_id=${lateOrder} and kind='LATE_FUNDING' and status='OPEN'`)).toBe(1);
    expect(await principalOf(lateOrder)).toBe('-4000');
    expect((await sql`select state from app.digital_entitlements where order_id=${lateOrder}`)[0]!.state).not.toBe('ACTIVE');
    expect((await sql`select state from app.digital_entitlements where order_id=${winnerOrder}`)[0]!.state).toBe('ACTIVE');
    expect(await count(sql`select count(*)::int as n from app.digital_entitlements where service_id=${serviceId} and state in ('HELD','EXPIRY_RECONCILING','ACTIVE')`)).toBe(1);

    const finance = await financeUser();
    const refund = () => command(finance, { command: 'admin_refund_late_funding', order_id: lateOrder, reason: 'Late capture after the license was resold; full refund.' });
    expect((await command(late, { command: 'admin_refund_late_funding', order_id: lateOrder, reason: 'Trying to refund myself here.' })).status).toBe(403);
    expect((await refund()).status).toBe(200);
    await funding.deliverPendingMockWebhooks();
    expect(await orderRow(lateOrder)).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED' });
    expect(await principalOf(lateOrder)).toBe('0');
    expect(await ledgerTotal(lateOrder)).toBe('0');
    expect((await provider.getFundingStatus(intent.reference)).refundedSucceeded).toBe(4000n);
    expect(await count(sql`select count(*)::int as n from app.outbox where semantic_key=${`notify:refund.updated:SUCCEEDED:${lateOrder}`}`)).toBe(1);
    expect((await refund()).status).toBe(409);
    expect((await sql`select state from app.digital_entitlements where order_id=${winnerOrder}`)[0]!.state).toBe('ACTIVE');
  });
});
