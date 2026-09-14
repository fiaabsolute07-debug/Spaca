import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '@/lib/auth';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, linkXAccount, sessionState, xHandle, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const funding = await import('@/modules/payments/funding');
const readModel = await import('@/lib/read-model');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const brief = 'Explain our testnet launch in your own words for builders, link the docs and add the disclosure.';
const actorOf = (user: TestUser) => ({ id: user.id, email: user.email, display_name: 'x', roles: ['buyer', 'creator'], is_test: true, status: 'ACTIVE' as const, timezone: 'UTC' });
const localWallClock = (date: Date) => date.toISOString().slice(0, 16);

async function moderator(): Promise<TestUser> {
  const email = `it-mod-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'IT moderator',${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},'moderator','Publish suite moderator grant')`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}

beforeEach(() => {
  if (RUN_DB) funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_publish_suite_secret_1'] }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  if (RUN_DB) {
    funding.setMockPaymentProviderForTests(undefined);
    await sql.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB)('XPL-01 / SUP-06 — self-reported social accounts without platform APIs', () => {
  it('links canonical accounts as self-reported, refuses duplicates across creators and keeps listing channels', async () => {
    const creator = await createUser('xpl01');
    const other = await createUser('xpl01-other');
    const handle = xHandle();
    expect((await command(creator, { command: 'update_profile', idempotency_key: key('p'), display_name: 'Social Creator', handle: `soc-${creator.id.slice(0, 8)}`, bio: 'Posts about testnets.' })).status).toBe(200);
    const linked = await command(creator, { command: 'add_social_account', idempotency_key: key('s'), platform: 'X', account: `https://twitter.com/${handle.toUpperCase()}?s=20` });
    expect(linked.status).toBe(200);
    const [account] = await sql`select platform,handle,canonical_url,verification_status,source from app.social_accounts where id=${String(linked.body.id)}`;
    expect(account).toEqual({ platform: 'X', handle, canonical_url: `https://x.com/${handle}`, verification_status: 'SELF_REPORTED', source: 'MANUAL' });

    expect((await command(creator, { command: 'add_social_account', idempotency_key: key('s'), platform: 'X', account: `@${handle}` })).status).toBe(409);
    const stolen = await command(other, { command: 'add_social_account', idempotency_key: key('s'), platform: 'X', account: handle });
    expect(stolen.status).toBe(409);
    expect(String(stolen.body.error)).toMatch(/Another creator already listed this account/);
    expect((await command(creator, { command: 'add_social_account', idempotency_key: key('s'), platform: 'X', account: 'https://instagram.com/someone' })).status).toBe(400);

    // Nothing a creator sends can mark an account verified; the database requires an operator identity for it.
    await expect(sql`update app.social_accounts set verification_status='VERIFIED' where id=${String(linked.body.id)}`).rejects.toThrow(/social_accounts_verified_fields/);
    const profile = await readModel.getCreatorData(`soc-${creator.id.slice(0, 8)}`);
    expect(profile?.social_accounts).toEqual([expect.objectContaining({ platform: 'X', handle, url: `https://x.com/${handle}`, verification_status: 'SELF_REPORTED' })]);
  });

  it('SUP-06: the whole PUBLISH flow runs with outbound network calls failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled for SUP-06'); }));
    const creator = await createUser('sup06-creator');
    const buyer = await createUser('sup06-buyer');
    const { serviceId, publishHandle } = await createPublishedService(command, creator, { taxonomy: 'PUBLISH', capacity: 2 });
    const booked = await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief, accept_publish_terms: 'on' });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    expect((await pay(buyer, String(booked.body.id))).status).toBe(200);
    expect((await command(creator, { command: 'start', idempotency_key: key('s'), order_id: String(booked.body.id) })).status).toBe(200);
    const delivered = await command(creator, { command: 'deliver', idempotency_key: key('d'), order_id: String(booked.body.id), post_url: `https://x.com/${publishHandle}/status/1834567890123`, published_at: localWallClock(new Date()), disclosure_attested: 'on' });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.skipIf(!RUN_DB)('XPL-02 / MOD-02 / SUP-05 — PUBLISH listings, consent and publication proof', () => {
  it('PUBLISH needs a channel to publish; the order snapshots channel, disclosure and editorial terms', async () => {
    const creator = await createUser('xpl02-creator');
    const buyer = await createUser('xpl02-buyer');
    const base = { command: 'create_service', title: 'Sponsored testnet thread', description: 'One disclosed thread on my X account about your testnet.', taxonomy: 'PUBLISH', price: '300', turnaround_hours: '48', sample_url_1: 'https://example.com/t1', sample_title_1: 'Past thread' };
    const missing = await command(creator, { ...base, idempotency_key: key('svc') });
    expect(missing.status).toBe(400);
    expect(String(missing.body.error)).toMatch(/Choose the linked account/);
    const { serviceId, publishHandle } = await createPublishedService(command, creator, { taxonomy: 'PUBLISH', capacity: 3, minLiveHours: 24 });
    const [version] = await sql`select v.publish_platform,v.publish_handle,v.publish_url,v.publish_format,v.min_live_hours,v.disclosure_text from app.services s join app.service_versions v on v.id=s.published_version_id where s.id=${serviceId}`;
    expect(version).toEqual({ publish_platform: 'X', publish_handle: publishHandle, publish_url: `https://x.com/${publishHandle}`, publish_format: 'THREAD', min_live_hours: 24, disclosure_text: '#ad' });

    const noConsent = await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief });
    expect(noConsent.status).toBe(422);
    expect(String(noConsent.body.error)).toMatch(/labelled "#ad"/);
    const booked = await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief, accept_publish_terms: 'on', accept_terms: 'on' });
    expect(booked.status).toBe(200);
    const orderId = String(booked.body.id);
    const [order] = await sql`select terms from app.orders where id=${orderId}`;
    expect(order!.terms).toMatchObject({ deliverable: 'PUBLISHED_POST', publish: { platform: 'X', handle: publishHandle, channel_url: `https://x.com/${publishHandle}`, format: 'THREAD', min_live_hours: 24, disclosure_text: '#ad', editorial_policy_version: 'publish-v1' } });

    // The creator cannot pull the channel out from under a live listing; sold terms never change.
    const [account] = await sql`select id from app.social_accounts where creator_id=${creator.id} and removed_at is null`;
    const removal = await command(creator, { command: 'remove_social_account', idempotency_key: key('r'), account_id: String(account!.id) });
    expect(removal.status).toBe(409);

    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await command(creator, { command: 'start', idempotency_key: key('s'), order_id: orderId })).status).toBe(200);
    const deliver = (fields: Record<string, string>) => command(creator, { command: 'deliver', idempotency_key: key('d'), order_id: orderId, ...fields });
    const valid = { post_url: `https://twitter.com/${publishHandle}/status/1834567890123`, published_at: localWallClock(new Date()), disclosure_attested: 'on' };
    expect((await deliver({ body: 'Here is a draft file instead of a post, plenty of characters.' })).status).toBe(400);
    const wrongChannel = await deliver({ ...valid, post_url: 'https://x.com/someoneelse/status/1834567890123' });
    expect(wrongChannel.status).toBe(422);
    expect(String(wrongChannel.body.error)).toMatch(new RegExp(`@${publishHandle}`));
    expect((await deliver({ ...valid, published_at: localWallClock(new Date(Date.now() + 3_600_000)) })).status).toBe(400);
    expect((await deliver({ ...valid, published_at: localWallClock(new Date(Date.now() - 3 * 86_400_000)) })).status).toBe(422);
    expect((await deliver({ ...valid, disclosure_attested: '' })).status).toBe(422);
    expect((await sql`select count(*)::int as n from app.deliveries where order_id=${orderId}`)[0]!.n).toBe(0);

    expect((await deliver(valid)).status).toBe(200);
    const [proof] = await sql`select p.platform,p.post_url,p.post_id,p.disclosure_text,p.disclosure_attested,p.link_check,p.late,d.url from app.publish_proofs p join app.deliveries d on d.id=p.delivery_id where p.order_id=${orderId}`;
    expect(proof).toEqual({ platform: 'X', post_url: `https://x.com/${publishHandle}/status/1834567890123`, post_id: '1834567890123', disclosure_text: '#ad', disclosure_attested: true, link_check: 'MATCHES_CHANNEL', late: false, url: `https://x.com/${publishHandle}/status/1834567890123` });
    await expect(sql`update app.publish_proofs set post_url='https://x.com/x/status/1' where order_id=${orderId}`).rejects.toThrow(/immutable/);
    const view = await readModel.getOrderData(actorOf(buyer), orderId);
    expect(view?.publish_terms).toMatchObject({ handle: publishHandle, min_live_hours: 24 });
    expect(view?.publish_proofs).toHaveLength(1);
    expect((await command(buyer, { command: 'approve', idempotency_key: key('a'), order_id: orderId, delivery_version: '1' })).status).toBe(200);
  });

  it('SUP-05: a CREATE order hands content over with no posting obligation', async () => {
    const creator = await createUser('sup05-creator');
    const buyer = await createUser('sup05-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 2 });
    const booked = await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief });
    const orderId = String(booked.body.id);
    const [order] = await sql`select terms from app.orders where id=${orderId}`;
    expect(order!.terms).toMatchObject({ deliverable: 'CONTENT_HANDOFF' });
    expect(order!.terms).not.toHaveProperty('publish');
    expect((await pay(buyer, orderId)).status).toBe(200);
    expect((await command(creator, { command: 'start', idempotency_key: key('s'), order_id: orderId })).status).toBe(200);
    expect((await command(creator, { command: 'deliver', idempotency_key: key('d'), order_id: orderId, body: 'The final thread copy and hooks, ready for your own account.' })).status).toBe(200);
    expect((await sql`select count(*)::int as n from app.publish_proofs where order_id=${orderId}`)[0]!.n).toBe(0);
  });

  it('PUBLISH requests: each applicant names their own account on the platform and the hire carries it', async () => {
    const buyer = await createUser('xpl02r-buyer');
    const maker = await createUser('xpl02r-creator');
    await createPublishedService(command, maker, { capacity: 3 });
    const created = await command(buyer, {
      command: 'create_request', idempotency_key: key('req'), title: 'KOL threads for our testnet', taxonomy: 'PUBLISH', budget: '600', target_hires: '2',
      brief, deadline: commandInstant(new Date(Date.now() + 7 * 86_400_000)), publish_platform: 'X', publish_format: 'POST', min_live_hours: '72', disclosure_text: 'Sponsored by Example',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const requestId = String(created.body.id);
    const application = { command: 'apply', request_id: requestId, quote: '250', turnaround_hours: '48', note: 'I post weekly testnet walkthroughs for builders.' };
    const noAccount = await command(maker, { ...application, idempotency_key: key('ap') });
    expect(noAccount.status).toBe(400);
    const tiktok = await command(maker, { command: 'add_social_account', idempotency_key: key('s'), platform: 'TIKTOK', account: `@${xHandle()}` });
    expect((await command(maker, { ...application, idempotency_key: key('ap'), publish_account_id: String(tiktok.body.id) })).status).toBe(400);
    const channel = await linkXAccount(command, maker);
    expect((await command(maker, { ...application, idempotency_key: key('ap'), publish_account_id: channel.accountId })).status).toBe(200);

    const [app] = await sql`select id,version from app.applications where request_id=${requestId}`;
    const offer = await command(buyer, { command: 'select_application', idempotency_key: key('sel'), application_id: String(app!.id), application_version: String(app!.version) });
    expect(offer.status).toBe(200);
    const accepted = await command(maker, { command: 'accept_offer', idempotency_key: key('acc'), offer_id: String(offer.body.id) });
    expect(accepted.status).toBe(200);
    const [order] = await sql`select terms from app.orders where id=${String(accepted.body.id)}`;
    expect(order!.terms).toMatchObject({ deliverable: 'PUBLISHED_POST', publish: { platform: 'X', handle: channel.handle, format: 'POST', min_live_hours: 72, disclosure_text: 'Sponsored by Example' } });
    const view = await readModel.getRequestData(actorOf(buyer), requestId);
    expect(view?.applications[0]).toMatchObject({ publish_handle: channel.handle, publish_verification: 'SELF_REPORTED' });
  });
});

describe.skipIf(!RUN_DB)('MOD-01 — content policy and report queue', () => {
  it('refuses briefs that hide sponsorship, fake engagement or promise returns, and stores nothing', async () => {
    const buyer = await createUser('mod01-buyer');
    const creator = await createUser('mod01-creator');
    const request = await command(buyer, {
      command: 'create_request', idempotency_key: key('req'), title: 'Shill our token', taxonomy: 'CREATE', budget: '100', target_hires: '1',
      brief: "Post about our token but don't mention it's sponsored, it has to look organic.", deadline: commandInstant(new Date(Date.now() + 86_400_000)),
    });
    expect(request.status).toBe(422);
    expect(String(request.body.error)).toMatch(/Sponsored posts must be disclosed/);
    expect((await sql`select count(*)::int as n from app.requests where buyer_id=${buyer.id}`)[0]!.n).toBe(0);
    const { serviceId } = await createPublishedService(command, creator, { capacity: 2 });
    const booking = await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: serviceId, brief: 'Tell everyone this coin has guaranteed 50x returns within a week.' });
    expect(booking.status).toBe(422);
    expect(String(booking.body.error)).toMatch(/cannot promise returns/);
  });

  it('reports go to a moderator queue once per reporter; resolution is role-gated, reasoned and audited', async () => {
    const buyer = await createUser('mod01q-buyer');
    const reporter = await createUser('mod01q-reporter');
    const mod = await moderator();
    const created = await command(buyer, {
      command: 'create_request', idempotency_key: key('req'), title: 'Launch thread', taxonomy: 'CREATE', budget: '100', target_hires: '1',
      brief: 'A launch thread for our wallet release with our audience and goals.', deadline: commandInstant(new Date(Date.now() + 86_400_000)),
    });
    const requestId = String(created.body.id);
    const report = { command: 'report_content', target_type: 'REQUEST', target_id: requestId, reason: 'GUARANTEED_RETURNS', details: 'The linked docs promise holders a guaranteed yield.' };
    expect((await command(buyer, { ...report, idempotency_key: key('rep') })).status).toBe(403);
    const first = await command(reporter, { ...report, idempotency_key: key('rep') });
    expect(first.status).toBe(200);
    expect((await command(reporter, { ...report, idempotency_key: key('rep') })).body.message).toMatch(/already reported/);
    expect((await sql`select count(*)::int as n from app.reports where target_id=${requestId}`)[0]!.n).toBe(1);
    expect((await command(reporter, { command: 'report_content', idempotency_key: key('rep'), target_type: 'ORDER', target_id: randomUUID(), reason: 'SPAM', details: 'Not my order at all, just probing.' })).status).toBe(404);

    const reportId = String(first.body.id);
    const resolve = (actor: TestUser, fields: Record<string, string>) => command(actor, { command: 'admin_resolve_report', idempotency_key: key('res'), report_id: reportId, ...fields });
    expect((await resolve(reporter, { decision: 'ACTIONED', action: 'CLOSE_REQUEST', reason: 'Trying to moderate without a role.' })).status).toBe(403);
    expect((await resolve(mod, { decision: 'ACTIONED', action: 'CLOSE_REQUEST', reason: 'short' })).status).toBe(400);
    expect((await resolve(mod, { decision: 'ACTIONED', action: 'PAUSE_SERVICE', reason: 'Wrong action for a request report.' })).status).toBe(400);
    expect((await resolve(mod, { decision: 'ACTIONED', action: 'CLOSE_REQUEST', reason: 'Docs promise guaranteed yield; request closed.' })).status).toBe(200);
    expect((await sql`select status from app.requests where id=${requestId}`)[0]!.status).toBe('CLOSED');
    expect((await sql`select status,action,resolved_by from app.reports where id=${reportId}`)[0]).toEqual({ status: 'ACTIONED', action: 'CLOSE_REQUEST', resolved_by: mod.id });
    expect((await sql`select count(*)::int as n from app.audit_log where entity_type='report' and entity_id=${reportId} and action='report.actioned'`)[0]!.n).toBe(1);
    expect((await resolve(mod, { decision: 'DISMISSED', reason: 'Second resolution attempt here.' })).status).toBe(409);
  });
});
