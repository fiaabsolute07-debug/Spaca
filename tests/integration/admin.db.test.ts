import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MockPaymentProvider, type MockPaymentProviderOptions } from '@/modules/payments/providers';
import { RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const queries = await import('@/modules/admin/queries');
const { sql } = await import('@/lib/db');
const { createSession } = await import('@/lib/auth');

let provider: MockPaymentProvider;
function useProvider(options: Partial<MockPaymentProviderOptions> = {}) {
  provider = new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_admin_suite_secret_01'], ...options });
  funding.setMockPaymentProviderForTests(provider);
}

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const orderRow = async (orderId: string) => (await sql`select * from app.orders where id=${orderId}`)[0]!;
const brief = 'Admin suite brief with enough detail for a real order to start.';
const note = 'Delivered content with all agreed files and copy included.';
const reason = 'Operator decision recorded for the admin integration suite.';

async function operator(role: 'moderator' | 'finance' | 'support' | 'admin'): Promise<TestUser> {
  const email = `it-op-${role}-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},${`IT ${role}`},${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},${role},'Integration test operator grant')`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}

async function disputedOrder(label: string, stage: 'IN_PROGRESS' | 'DELIVERED' = 'DELIVERED') {
  const creator = await createUser(`${label}-creator`);
  const buyer = await createUser(`${label}-buyer`);
  const { serviceId } = await createPublishedService(command, creator, { capacity: 3 });
  const orderId = String((await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief, accept_terms: 'on' })).body.id);
  expect((await pay(buyer, orderId)).status).toBe(200);
  expect((await command(creator, { command: 'start', idempotency_key: key('s'), order_id: orderId })).status).toBe(200);
  if (stage === 'DELIVERED') expect((await command(creator, { command: 'deliver', idempotency_key: key('d'), order_id: orderId, body: note })).status).toBe(200);
  expect((await command(buyer, { command: 'dispute', idempotency_key: key('x'), order_id: orderId, body: 'The delivery misses the agreed scope.' })).status).toBe(200);
  const [dispute] = await sql`select id from app.disputes where order_id=${orderId} and status='OPEN'`;
  return { creator, buyer, serviceId, orderId, disputeId: String(dispute!.id) };
}

async function setFlag(admin: TestUser, flag: string, enabled: boolean) {
  return command(admin, { command: 'admin_set_flag', idempotency_key: key('flag'), key: flag, enabled: String(enabled), reason });
}

beforeEach(() => {
  if (RUN_DB) useProvider();
});
afterAll(async () => {
  if (RUN_DB) {
    const admin = await operator('admin');
    for (const flag of ['BOOKING_ENABLED', 'AUCTIONS_ENABLED', 'CHECKOUT_CREATION_ENABLED', 'BIDDING_ENABLED', 'PAYOUT_CREATION_ENABLED']) await setFlag(admin, flag, true);
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('SEC-12/SEC-13 — privileged actions', () => {
  it('SEC-12: a moderator cannot refund, resolve money outcomes, grant roles or flip flags; finance can, with audit', async () => {
    const moderator = await operator('moderator');
    const finance = await operator('finance');
    const { orderId, disputeId } = await disputedOrder('sec12');
    const denied = [
      await command(moderator, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: disputeId, outcome: 'REFUND_FULL', reason }),
      await command(moderator, { command: 'admin_refund_order', idempotency_key: key('r'), order_id: orderId, reason }),
      await command(moderator, { command: 'admin_grant_role', idempotency_key: key('g'), user_id: finance.id, role: 'admin', reason }),
      await command(moderator, { command: 'admin_set_flag', idempotency_key: key('f'), key: 'BOOKING_ENABLED', enabled: 'false', reason }),
    ];
    expect(denied.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect((await orderRow(orderId)).status).toBe('DISPUTED');
    expect((await command(finance, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: disputeId, outcome: 'REFUND_FULL', reason: 'short' })).status).toBe(400);

    const resolved = await command(finance, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: disputeId, outcome: 'REFUND_FULL', reason });
    expect(resolved.status).toBe(200);
    expect(await orderRow(orderId)).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED' });
    const [entry] = await sql`select action,actor_id,actor_roles,reason,before_state,after_state from app.audit_log where entity_id=${orderId} and action like 'dispute.resolve%'`;
    expect(entry).toMatchObject({ action: 'dispute.resolve.refund_full', actor_id: finance.id, reason });
    expect(entry!.actor_roles).toContain('finance');
    expect(entry!.before_state).toMatchObject({ status: 'DISPUTED' });
    // app_server has UPDATE/DELETE revoked; the append-only trigger is the second layer for owners.
    await expect(sql`update app.audit_log set reason='rewritten' where entity_id=${orderId}`).rejects.toThrow(/permission denied|immutable/);
    await expect(sql`delete from app.audit_log where entity_id=${orderId}`).rejects.toThrow(/permission denied|immutable/);
  });

  it('SEC-13 / SEC-04: actor, role and system fields in the body are never trusted', async () => {
    const { buyer, orderId } = await disputedOrder('sec13', 'IN_PROGRESS');
    const outsider = await createUser('sec13-outsider');
    const forged = await command(outsider, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: String((await sql`select id from app.disputes where order_id=${orderId}`)[0]!.id),
      outcome: 'APPROVE', reason, actor_id: 'system', roles: 'admin,finance', system_actor: 'true' });
    expect(forged.status).toBe(403);
    const asSystem = await command(outsider, { command: 'approve', idempotency_key: key('a'), order_id: orderId, delivery_version: '1', actor: 'SYSTEM', buyer_id: buyer.id });
    expect(asSystem.status).toBe(403);
    await expect(sql`update app.users set roles=array['admin'] where id=${outsider.id}`).rejects.toThrow(/users_marketplace_roles_only/);
  });

  it('roles come only from active grants; admins cannot self-grant; revocation removes access', async () => {
    const admin = await operator('admin');
    const colleague = await createUser('role-target');
    expect((await command(admin, { command: 'admin_grant_role', idempotency_key: key('g'), user_id: admin.id, role: 'finance', reason })).status).toBe(403);
    expect((await command(admin, { command: 'admin_grant_role', idempotency_key: key('g'), user_id: colleague.id, role: 'finance', reason })).status).toBe(200);
    const queues = await queries.getOperatorQueues({ id: colleague.id, email: colleague.email, display_name: 'x', roles: ['buyer', 'creator', 'finance'], is_test: true, status: 'ACTIVE', timezone: 'UTC' });
    expect(Array.isArray(queues.cases)).toBe(true);
    expect((await command(colleague, { command: 'admin_resolve_case', idempotency_key: key('c'), case_id: randomUUID(), status: 'RESOLVED', reason })).status).toBe(404);
    expect((await command(admin, { command: 'admin_revoke_role', idempotency_key: key('g'), user_id: colleague.id, role: 'finance', reason })).status).toBe(200);
    expect((await command(colleague, { command: 'admin_resolve_case', idempotency_key: key('c'), case_id: randomUUID(), status: 'RESOLVED', reason })).status).toBe(403);
    const actions = (await sql`select action from app.audit_log where entity_id=${colleague.id} order by created_at`).map((r) => r.action);
    expect(actions).toEqual(['role.grant', 'role.revoke']);
    await expect(queries.getOperatorQueues({ id: colleague.id, email: colleague.email, display_name: 'x', roles: ['buyer', 'creator'], is_test: true, status: 'ACTIVE', timezone: 'UTC' })).rejects.toThrow(/Operator access required/);
  });
});

describe.skipIf(!RUN_DB)('§7.2 dispute resolution outcomes', () => {
  it('RESUME returns to the prior state with a fresh review window', async () => {
    const support = await operator('support');
    const { orderId, disputeId } = await disputedOrder('resume');
    await sql`update app.orders set review_due_at=now() - interval '1 day' where id=${orderId}`;
    expect((await command(support, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: disputeId, outcome: 'REFUND_FULL', reason })).status).toBe(403);
    expect((await command(support, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: disputeId, outcome: 'RESUME', reason })).status).toBe(200);
    const row = await orderRow(orderId);
    expect(row).toMatchObject({ status: 'DELIVERED', status_before_dispute: null });
    expect(new Date(row.review_due_at).getTime() - Date.now()).toBeGreaterThan(71 * 3600_000);
    expect((await sql`select status,outcome from app.disputes where id=${disputeId}`)[0]).toMatchObject({ status: 'RESOLVED', outcome: 'RESUME' });
    expect((await command(support, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: disputeId, outcome: 'RESUME', reason })).status).toBe(409);
  });

  it('APPROVE queues settlement; REFUND_PARTIAL refunds the decided amount and releases the remainder', async () => {
    const finance = await operator('finance');
    const approved = await disputedOrder('approve');
    expect((await command(finance, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: approved.disputeId, outcome: 'APPROVE', reason })).status).toBe(200);
    expect(await orderRow(approved.orderId)).toMatchObject({ status: 'APPROVED', settlement_status: 'READY' });
    await jobs.releaseReadySettlements({ orderId: approved.orderId });
    expect((await orderRow(approved.orderId)).status).toBe('COMPLETED');

    const partial = await disputedOrder('partial', 'IN_PROGRESS');
    expect((await command(finance, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: partial.disputeId, outcome: 'REFUND_PARTIAL', refund_amount: '150', reason })).status).toBe(200);
    expect(await orderRow(partial.orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'PARTIALLY_REFUNDED', cancellation_refund_minor: '15000', settlement_status: 'READY' });
    expect((await jobs.releaseReadySettlements({ orderId: partial.orderId })).outcomes).toEqual({ RELEASE_REQUESTED: 1 });
    expect((await orderRow(partial.orderId)).settlement_status).toBe('RELEASED');
    // No work remains after the resolution, so the creator's place is freed (§6.1 rule 8, CAP-12).
    const [claim] = await sql`select state from app.workload_claims where order_id=${partial.orderId}`;
    expect(claim!.state).toBe('RELEASED');
  });
});

describe.skipIf(!RUN_DB)('FND-05 / OPS-04 — feature flags and kill switches', () => {
  it('FND-05: disabling auctions blocks direct API commands without side effects, while reads continue', async () => {
    const admin = await operator('admin');
    const seller = await createUser('flag-seller');
    const { serviceId } = await createPublishedService(command, seller, { capacity: 2 });
    const auction = await command(seller, { command: 'create_auction', idempotency_key: key('a'), service_id: serviceId, starting_price: '100', minimum_increment: '10',
      starts_at: commandInstant(new Date(Date.now() - 60_000)), ends_at: commandInstant(new Date(Date.now() + 3_600_000)) });
    expect(auction.status).toBe(200);
    expect((await setFlag(admin, 'AUCTIONS_ENABLED', false)).status).toBe(200);
    try {
      const blocked = await command(seller, { command: 'create_auction', idempotency_key: key('a'), service_id: serviceId, starting_price: '100', minimum_increment: '10',
        starts_at: commandInstant(new Date(Date.now() - 60_000)), ends_at: commandInstant(new Date(Date.now() + 3_600_000)) });
      expect(blocked.status).toBe(422);
      expect(String(blocked.body.error)).toMatch(/AUCTIONS_ENABLED/);
      const bidder = await createUser('flag-bidder');
      expect((await command(bidder, { command: 'bid', idempotency_key: key('b'), auction_id: String(auction.body.id), amount: '110' })).status).toBe(422);
      expect((await sql`select count(*)::int as n from app.auctions where seller_id=${seller.id}`)[0]!.n).toBe(1);
      expect((await sql`select count(*)::int as n from app.bids where auction_id=${String(auction.body.id)}`)[0]!.n).toBe(0);
      const { getAuctionData } = await import('@/lib/read-model');
      expect((await getAuctionData(null, String(auction.body.id)))?.auction.id).toBe(String(auction.body.id));
    } finally {
      await setFlag(admin, 'AUCTIONS_ENABLED', true);
    }
  });

  it('OPS-04: the checkout kill switch stops new charges while webhooks, refunds and reconciliation continue; payout switch holds releases', async () => {
    const admin = await operator('admin');
    const creator = await createUser('kill-creator');
    const buyer = await createUser('kill-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 3 });
    const funded = String((await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief })).body.id);
    const unpaid = String((await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief })).body.id);
    const intent = await sql.begin((tx) => funding.ensureFundingIntent(tx, buyer.id, funded));
    if (intent.state !== 'READY') throw new Error('intent not ready');
    await provider.simulateFundingOutcome(intent.reference, { status: 'SUCCEEDED' });
    const inFlight = provider.takeWebhookDeliveries();

    expect((await setFlag(admin, 'CHECKOUT_CREATION_ENABLED', false)).status).toBe(200);
    expect((await setFlag(admin, 'PAYOUT_CREATION_ENABLED', false)).status).toBe(200);
    try {
      expect((await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief })).status).toBe(422);
      expect((await pay(buyer, unpaid)).status).toBe(400);
      expect((await funding.receivePaymentWebhook(inFlight[0]!.rawBody, inFlight[0]!.headers)).outcome).toBe('FUNDED');
      expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: funded })).status).toBe(200);
      expect(await orderRow(funded)).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED' });
      expect((await jobs.reconcileProviderOperations({ orderId: funded, minAgeSeconds: 0 })).job).toBe('reconcile_provider_operations');

      const other = await createUser('kill-buyer-2');
      await setFlag(admin, 'CHECKOUT_CREATION_ENABLED', true);
      const completed = String((await command(other, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief })).body.id);
      expect((await pay(other, completed)).status).toBe(200);
      await command(creator, { command: 'start', idempotency_key: key('s'), order_id: completed });
      await command(creator, { command: 'deliver', idempotency_key: key('d'), order_id: completed, body: note });
      await command(other, { command: 'approve', idempotency_key: key('ap'), order_id: completed, delivery_version: '1' });
      expect((await jobs.releaseReadySettlements({ orderId: completed })).outcomes).toEqual({ BLOCKED_UNAVAILABLE: 1 });
      expect(await orderRow(completed)).toMatchObject({ status: 'APPROVED', settlement_status: 'READY' });
    } finally {
      await setFlag(admin, 'CHECKOUT_CREATION_ENABLED', true);
      await setFlag(admin, 'PAYOUT_CREATION_ENABLED', true);
    }
  });

  it('live payments cannot be switched on from the admin UI without the environment gate', async () => {
    const admin = await operator('admin');
    const attempt = await setFlag(admin, 'LIVE_PAYMENTS_ENABLED', true);
    expect(attempt.status).toBe(422);
    expect((await sql`select enabled from app.feature_flags where key='LIVE_PAYMENTS_ENABLED'`)[0]!.enabled).toBe(false);
  });
});

describe.skipIf(!RUN_DB)('operator read models and console redirects', () => {
  it('order view and user search are role-scoped, omit private text, and reject malformed ids', async () => {
    const finance = await operator('finance');
    const moderator = await operator('moderator');
    const { orderId, buyer } = await disputedOrder('opview');
    const asActor = (user: TestUser, roles: string[]) => ({ id: user.id, email: user.email, display_name: 'x', roles, is_test: true, status: 'ACTIVE' as const, timezone: 'UTC' });
    const view = await queries.getOperatorOrder(asActor(finance, ['finance']), orderId);
    expect(view!.order).toMatchObject({ id: orderId, status: 'DISPUTED' });
    expect(view!.order).not.toHaveProperty('brief');
    expect(view!.disputes.length).toBe(1);
    expect(await queries.getOperatorOrder(asActor(finance, ['finance']), 'not-a-uuid-0000-0000-0000-000000000000')).toBeNull();
    await expect(queries.getOperatorOrder(asActor(moderator, ['moderator']), orderId)).rejects.toThrow(/Operator access required/);
    expect(await queries.getAuditLog(asActor(finance, ['finance']), { entityId: "x' or 1=1 --" })).toEqual([]);

    const found = await queries.searchOperatorUsers(asActor(moderator, ['moderator']), buyer.email.slice(0, 20));
    expect(found.map((u) => u.id)).toContain(buyer.id);
    expect(await queries.searchOperatorUsers(asActor(moderator, ['moderator']), 'x')).toEqual([]);
    await expect(queries.searchOperatorUsers(asActor(finance, ['finance']), buyer.email)).rejects.toThrow(/Operator access required/);
  });

  it('console forms return to their page with the message; errors keep existing query strings valid', async () => {
    const admin = await operator('admin');
    const post = async (fields: Record<string, string>) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      sessionState.token = admin.token;
      return commands.POST(new Request('http://localhost:3000/api/commands', { method: 'POST', headers: { origin: 'http://localhost:3000' }, body: form }));
    };
    const ok = await post({ command: 'admin_set_flag', idempotency_key: key('flag'), key: 'DISCOVERY_ADVANCED_ENABLED', enabled: 'false', reason, return_to: '/admin/flags' });
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get('location')!).pathname).toBe('/admin/flags');
    expect(new URL(ok.headers.get('location')!).searchParams.get('message')).toMatch(/DISCOVERY_ADVANCED_ENABLED/);
    const failed = await post({ command: 'admin_set_flag', idempotency_key: key('flag'), key: 'LIVE_PAYMENTS_ENABLED', enabled: 'true', reason, return_to: '/admin/users?q=abc' });
    const location = new URL(failed.headers.get('location')!);
    expect(location.searchParams.get('q')).toBe('abc');
    expect(location.searchParams.get('error')).toBeTruthy();
  });
});

describe.skipIf(!RUN_DB)('OPS-05 / moderation / queues', () => {
  it('OPS-05: an operator retries the same provider operation and closes the case without forcing state', async () => {
    const finance = await operator('finance');
    useProvider({ failureInjection: [{ kind: 'funding.create', effect: 'ACCEPT_THEN_TIMEOUT' }] });
    const creator = await createUser('ops05-creator');
    const buyer = await createUser('ops05-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 1 });
    const orderId = String((await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief })).body.id);
    expect((await pay(buyer, orderId)).status).toBe(503);
    const [op] = await sql`select operation_id,status from app.provider_operations where order_id=${orderId}`;
    expect(op!.status).toBe('UNKNOWN');
    const queues = await queries.getOperatorQueues({ id: finance.id, email: finance.email, display_name: 'x', roles: ['finance'], is_test: true, status: 'ACTIVE', timezone: 'UTC' });
    const listed = queues.provider_operations.find((p) => p.operation_id === op!.operation_id);
    expect(listed).toBeDefined();

    const retried = await command(finance, { command: 'admin_retry_operation', idempotency_key: key('rt'), operation_id: String(op!.operation_id), reason });
    expect(retried.status).toBe(200);
    const [after] = await sql`select operation_id,status from app.provider_operations where order_id=${orderId}`;
    expect(after).toMatchObject({ operation_id: op!.operation_id, status: 'SUCCEEDED' });
    expect((await sql`select count(*)::int as n from app.provider_operations where order_id=${orderId}`)[0]!.n).toBe(1);
    expect((await orderRow(orderId)).status).toBe('AWAITING_PAYMENT');
    expect((await sql`select action from app.audit_log where action='provider_operation.retry' and actor_id=${finance.id}`).length).toBe(1);
  });

  it('moderators approve samples with a reason; suspension blocks new sales only', async () => {
    const moderator = await operator('moderator');
    const creator = await createUser('mod-creator');
    const sample = await command(creator, { command: 'add_sample', idempotency_key: key('s'), title: 'Case study', url: 'https://example.com/case' });
    const queues = await queries.getOperatorQueues({ id: moderator.id, email: moderator.email, display_name: 'x', roles: ['moderator'], is_test: true, status: 'ACTIVE', timezone: 'UTC' });
    expect(queues.pending_samples.map((s) => String(s.id))).toContain(String(sample.body.id));
    expect(queues.cases).toEqual([]);
    expect(queues.provider_operations).toEqual([]);
    expect((await command(moderator, { command: 'admin_moderate_sample', idempotency_key: key('m'), sample_id: String(sample.body.id), decision: 'APPROVED', reason })).status).toBe(200);
    expect((await sql`select moderation_status,moderated_by from app.samples where id=${String(sample.body.id)}`)[0]).toMatchObject({ moderation_status: 'APPROVED', moderated_by: moderator.id });

    expect((await command(moderator, { command: 'admin_suspend_user', idempotency_key: key('u'), user_id: moderator.id, reason })).status).toBe(403);
    expect((await command(moderator, { command: 'admin_suspend_user', idempotency_key: key('u'), user_id: creator.id, reason })).status).toBe(200);
    expect((await command(creator, { command: 'create_service', idempotency_key: key('svc'), title: 'Blocked', description: 'Suspended accounts cannot create listings.', taxonomy: 'CREATE', price: '10', turnaround_hours: '24' })).status).toBe(403);
    expect((await command(moderator, { command: 'admin_reactivate_user', idempotency_key: key('u'), user_id: creator.id, reason })).status).toBe(200);
  });
});
