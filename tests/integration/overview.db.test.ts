import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const inboxRoute = await import('@/app/api/notifications/route');
const readRoute = await import('@/app/api/notifications/read/route');
const inbox = await import('@/modules/notifications/inbox');
const { getOverview } = await import('@/modules/workspace/overview');
const funding = await import('@/modules/payments/funding');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const asActor = (user: TestUser, roles: string[]) => ({ id: user.id, email: user.email, roles, display_name: '', is_test: true, status: 'ACTIVE' as const, timezone: 'UTC' });

async function notify(userId: string, subject: string, minutesAgo: number, linkPath = '/orders') {
  const [row] = await sql<{ id: string }[]>`insert into app.notifications (recipient_id,channel,template_id,category,subject,body,link_path,dedupe_key,semantic_key,status,created_at)
    values (${userId},'in_app','order.test_event','transactional',${subject},${`${subject} body`},${linkPath},${createHash('sha256').update(randomUUID()).digest('hex')},${randomUUID()},'DELIVERED',now() - make_interval(mins => ${minutesAgo}))
    returning id`;
  return row!.id;
}

beforeEach(() => {
  if (RUN_DB) funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_overview_suite_1'] }));
});
afterAll(async () => {
  if (!RUN_DB) return;
  funding.setMockPaymentProviderForTests(undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('Header bell and workspace overview', () => {
  it('the bell counts unread notifications, lists the newest first, and marks only the reader’s own as read', async () => {
    const reader = await createUser('bell-reader', ['buyer']);
    const other = await createUser('bell-other', ['creator']);
    const older = await notify(reader.id, 'Order approved', 30);
    const newer = await notify(reader.id, 'Delivery received', 5, '/orders/abc');
    const theirs = await notify(other.id, 'Not yours', 1);

    expect(await inbox.unreadCount(reader.id)).toBe(2);
    const listed = await callRoute(inboxRoute.POST, '/api/notifications', reader, {});
    expect(listed.status).toBe(200);
    expect(listed.body.unread).toBe(2);
    expect((listed.body.items as { id: string; read: boolean; linkPath: string }[]).map((item) => [item.id, item.read, item.linkPath])).toEqual([[newer, false, '/orders/abc'], [older, false, '/orders']]);
    expect((await callRoute(inboxRoute.POST, '/api/notifications', null, {})).status).toBe(401);
    expect((await callRoute(inboxRoute.POST, '/api/notifications', reader, {}, { origin: 'https://evil.example' })).status).toBe(403);

    // Marking someone else's notification changes nothing.
    expect((await callRoute(readRoute.POST, '/api/notifications/read', reader, { id: theirs })).body).toEqual({ unread: 2 });
    expect(await inbox.unreadCount(other.id)).toBe(1);
    expect((await callRoute(readRoute.POST, '/api/notifications/read', reader, { id: newer })).body).toEqual({ unread: 1 });
    expect((await callRoute(readRoute.POST, '/api/notifications/read', reader, { all: 'true' })).body).toEqual({ unread: 0 });
    expect((await inbox.listInbox(reader.id)).every((item) => item.read)).toBe(true);
    expect(await inbox.unreadCount(other.id)).toBe(1);

    // The count stops at the cap the bell shows as "99+".
    for (let index = 0; index < inbox.UNREAD_COUNT_CAP + 3; index += 1) await notify(other.id, `Bulk ${index}`, 0);
    expect(await inbox.unreadCount(other.id)).toBe(inbox.UNREAD_COUNT_CAP);
  });

  it('needs-your-action lists what each side must do next, soonest first, with where to do it', async () => {
    const creator = await createUser('overview-creator', ['creator']);
    const buyer = await createUser('overview-buyer', ['buyer']);
    const { serviceId } = await createPublishedService(command, creator);
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief: 'Overview suite brief with the audience, the goal and three headline options.', accept_terms: 'on' });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    const orderId = String(booked.body.id);

    const buyerView = await getOverview(asActor(buyer, ['buyer']));
    expect(buyerView.creator).toBe(false);
    expect(buyerView.actions.find((item) => item.href === `/orders/${orderId}`)).toMatchObject({ kind: 'order', action: 'Pay for the order' });
    expect(buyerView.todo).toBeGreaterThanOrEqual(1);
    expect(buyerView.recent[0]).toMatchObject({ id: orderId, status: 'AWAITING_PAYMENT', counterpart: expect.any(String) });
    // Nothing for the creator to do until the order is paid.
    expect((await getOverview(asActor(creator, ['creator']))).actions.some((item) => item.href === `/orders/${orderId}`)).toBe(false);

    // An item listing still waiting for its collateral is the seller's to-do.
    const now = Date.now();
    const listing = await command(creator, {
      command: 'create_item_listing', idempotency_key: key('item'), origin: 'RESALE', item_type: 'WL spot', title: 'Overview WL spot',
      project_name: 'Overview', network: 'Base', quantity: '1 spot', description: 'One whitelist spot for the overview suite check.',
      delivery_method: 'The project adds your wallet to the allowlist.', buyer_provides: 'EVM wallet address', starting_price: '100', min_increment: '10', collateral: '20',
      starts_at: new Date(now).toISOString().slice(0, 16), ends_at: new Date(now + 3600_000 * 3).toISOString().slice(0, 16), delivery_due_at: new Date(now + 3600_000 * 30).toISOString().slice(0, 16),
    });
    expect(listing.status, JSON.stringify(listing.body)).toBe(200);
    const creatorView = await getOverview(asActor(creator, ['creator']));
    expect(creatorView.actions.find((item) => item.href === `/auctions/${String(listing.body.id)}`)).toMatchObject({ kind: 'auction', action: 'Lock collateral to open bidding' });
    const dues = creatorView.actions.filter((item) => !item.waiting && item.dueAt).map((item) => item.dueAt!);
    expect(dues).toEqual([...dues].sort());
  });
});
