import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { ORIGIN, RUN_DB, callRoute, createUser, key, sessionState, workloadCounters, type TestUser } from './harness';

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
const assetDownloadRoute = await import('@/app/api/assets/[id]/download-url/route');
const entitlementDownloadRoute = await import('@/app/api/digital/entitlements/[id]/download-url/route');
const servicesRoute = await import('@/app/api/discovery/services/route');
const devUpload = await import('@/app/api/dev/storage/upload/[token]/route');
const devDownload = await import('@/app/api/dev/storage/download/[token]/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const storage = await import('@/modules/storage/provider');
const { getOrderData } = await import('@/lib/read-model');
const { sql } = await import('@/lib/db');

const SECRET = 'digital_suite_signing_secret_0001';
let root = '';
const zip = (label: string) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(`template kit ${label}`)]);
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const tokenOf = (url: string) => url.split('/').pop()!;
const RIGHTS = 'Use the template in unlimited personal and client projects. Do not resell or share the files.';

async function uploadProductFile(creator: TestUser, bytes: Uint8Array): Promise<string> {
  const intent = await callRoute(intents.POST, '/api/assets/upload-intents', creator, { purpose: 'DIGITAL', filename: 'launch-kit.zip', mime: 'application/zip', size: String(bytes.byteLength) });
  expect(intent.status, JSON.stringify(intent.body)).toBe(200);
  const url = String((intent.body.upload as { url: string }).url);
  const put = await devUpload.PUT(new Request(`${ORIGIN}${url}`, { method: 'PUT', headers: { 'content-type': 'application/zip' }, body: new Blob([bytes.slice()]) }), params({ token: tokenOf(url) }));
  expect(put.status).toBe(200);
  const id = String(intent.body.id);
  const done = await callRoute((request) => finalizeRoute.POST(request, params({ id })), `/api/assets/${id}/finalize`, creator, {});
  expect(done.body.state).toBe('READY');
  return id;
}

async function addRelease(creator: TestUser, serviceId: string, label: string) {
  const assetId = await uploadProductFile(creator, zip(label));
  const added = await command(creator, { command: 'add_digital_release', idempotency_key: key('release'), service_id: serviceId, asset_ids: assetId, notes: `Release ${label}` });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  return assetId;
}

async function digitalProduct(label: string, options: { license?: 'EXCLUSIVE' | 'NON_EXCLUSIVE'; updates?: 'LATEST' | 'PURCHASED_VERSION'; downloads?: number; stock?: number } = {}) {
  const creator = await createUser(`${label}-creator`);
  const created = await command(creator, {
    command: 'create_service', idempotency_key: key('svc'), title: `Launch kit ${label}`, description: 'Notion and Figma templates for a token launch week, with copy prompts.',
    taxonomy: 'DIGITAL', price: '40', turnaround_hours: '1', digital_license: options.license ?? 'NON_EXCLUSIVE', digital_rights_text: RIGHTS,
    digital_updates: options.updates ?? 'LATEST', digital_download_limit: String(options.downloads ?? 5), ...(options.stock ? { digital_stock: String(options.stock) } : {}),
    sample_url_1: 'https://example.com/preview', sample_title_1: 'Preview',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const serviceId = String(created.body.id);
  const firstAsset = await addRelease(creator, serviceId, `${label}-v1`);
  const published = await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return { creator, serviceId, firstAsset };
}

const buy = (buyer: TestUser, serviceId: string) => command(buyer, { command: 'book', idempotency_key: key('buy'), service_id: serviceId, accept_license: 'on', accept_terms: 'on' });
async function bought(buyer: TestUser, serviceId: string) {
  const booked = await buy(buyer, serviceId);
  expect(booked.status, JSON.stringify(booked.body)).toBe(200);
  const orderId = String(booked.body.id);
  expect((await pay(buyer, orderId)).status).toBe(200);
  const [entitlement] = await sql`select id,state from app.digital_entitlements where order_id=${orderId}`;
  return { orderId, entitlementId: String(entitlement!.id) };
}
const download = (actor: TestUser | null, entitlementId: string, version?: number) =>
  callRoute((request) => entitlementDownloadRoute.POST(request, params({ id: entitlementId })), `/api/digital/entitlements/${entitlementId}/download-url`, actor, version ? { version: String(version) } : {});
const fetchFile = async (url: string) => {
  const response = await devDownload.GET(new Request(`${ORIGIN}${url}`), params({ token: tokenOf(url) }));
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
};

beforeAll(async () => {
  if (!RUN_DB) return;
  root = await mkdtemp(join(tmpdir(), 'cm-digital-it-'));
  await sql`update app.feature_flags set enabled=true where key='DIGITAL_PRODUCTS_ENABLED'`;
});
beforeEach(() => {
  if (!RUN_DB) return;
  storage.setStorageProviderForTests(new storage.LocalStorageProvider({ root, secret: SECRET }));
  funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_digital_suite_secret_01'] }));
});
afterAll(async () => {
  if (!RUN_DB) return;
  await sql`update app.feature_flags set enabled=false where key='DIGITAL_PRODUCTS_ENABLED'`;
  storage.setStorageProviderForTests(undefined);
  funding.setMockPaymentProviderForTests(undefined);
  await rm(root, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('XPL-04 — non-exclusive digital products', () => {
  it('gives each buyer a separate private entitlement, delivers on payment and never counts as creator work in progress', async () => {
    const { creator, serviceId, firstAsset } = await digitalProduct('xpl04');
    // Paused: service orders would be refused, file sales are not.
    expect((await command(creator, { command: 'set_accepting_orders', idempotency_key: key('p'), accepting: 'false' })).status).toBe(200);
    const [a, b, stranger] = [await createUser('xpl04-a'), await createUser('xpl04-b'), await createUser('xpl04-x')];

    const first = await bought(a, serviceId);
    const second = await bought(b, serviceId);
    expect(first.entitlementId).not.toBe(second.entitlementId);
    const orders = await sql`select o.status,o.terms->'digital' as digital,e.state,e.license,e.release_version from app.orders o join app.digital_entitlements e on e.order_id=o.id where o.id in (${first.orderId},${second.orderId})`;
    expect(orders).toHaveLength(2);
    for (const row of orders) {
      expect(row).toMatchObject({ status: 'DELIVERED', state: 'ACTIVE', license: 'NON_EXCLUSIVE', release_version: 1 });
      expect(row.digital).toMatchObject({ license: 'NON_EXCLUSIVE', rights_text: RIGHTS, updates_policy: 'LATEST', download_limit: 5, release_version: 1, policy_version: 'digital-v1' });
    }
    expect(await sql`select 1 from app.workload_claims where order_id in (${first.orderId},${second.orderId})`).toHaveLength(0);
    expect(await workloadCounters(creator.id)).toMatchObject({ held_units: 0, active_units: 0 });

    const link = await download(a, first.entitlementId);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const file = await fetchFile(String(link.body.url));
    expect(file.status).toBe(200);
    expect(file.bytes).toEqual(zip('xpl04-v1'));

    // No path to the file except the buyer's own entitlement: other buyers, strangers, anonymous and the raw asset route all fail.
    expect((await download(b, first.entitlementId)).status).toBe(404);
    expect((await download(stranger, first.entitlementId)).status).toBe(404);
    expect((await download(null, first.entitlementId)).status).toBe(401);
    for (const actor of [a, stranger]) expect((await callRoute((request) => assetDownloadRoute.POST(request, params({ id: firstAsset })), `/api/assets/${firstAsset}/download-url`, actor, {})).status).toBe(404);
    expect((await callRoute((request) => assetDownloadRoute.POST(request, params({ id: firstAsset })), `/api/assets/${firstAsset}/download-url`, null, {})).status).toBe(404);
    expect((await callRoute((request) => assetDownloadRoute.POST(request, params({ id: firstAsset })), `/api/assets/${firstAsset}/download-url`, creator, {})).status).toBe(200);

    const view = await getOrderData({ id: a.id, email: a.email, display_name: 'a', roles: ['buyer'], is_test: true, status: 'ACTIVE', timezone: 'UTC' }, first.orderId);
    expect(view?.digital?.entitlement).toMatchObject({ state: 'ACTIVE', download_count: 1 });
    expect(JSON.stringify(view)).not.toContain('object_key');

    // Service-style steps do not apply to files: the order is already delivered, and revisions are refused.
    for (const step of ['start', 'deliver']) expect((await command(creator, { command: step, idempotency_key: key(step), order_id: second.orderId, body: 'A delivery note long enough to count.' })).status).toBe(409);
    expect((await command(b, { command: 'revision', idempotency_key: key('rev'), order_id: second.orderId, delivery_version: '1', body: 'Please change it' })).status).toBe(422);
    expect((await command(b, { command: 'approve', idempotency_key: key('ap'), order_id: second.orderId, delivery_version: '1' })).status).toBe(200);
  });

  it('keeps the product behind its flag and requires a file and license terms to publish', async () => {
    const creator = await createUser('digital-flag');
    const created = await command(creator, {
      command: 'create_service', idempotency_key: key('svc'), title: 'Preset pack', description: 'Twenty colour presets for launch visuals and banners.',
      taxonomy: 'DIGITAL', price: '15', turnaround_hours: '1', digital_rights_text: RIGHTS, sample_url_1: 'https://example.com/p', sample_title_1: 'Preview',
    });
    expect(created.status).toBe(200);
    const serviceId = String(created.body.id);
    const noFile = await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId });
    expect(noFile.status).toBe(400);
    expect(String(noFile.body.error)).toMatch(/Upload the product file/);
    expect((await command(creator, { command: 'create_service', idempotency_key: key('svc'), title: 'No rights', description: 'A product without a license description at all.', taxonomy: 'DIGITAL', price: '15', turnaround_hours: '1' })).status).toBe(400);
    // Delivery files cannot become product releases.
    const other = await createUser('digital-flag-other');
    const foreign = await uploadProductFile(other, zip('foreign'));
    expect((await command(creator, { command: 'add_digital_release', idempotency_key: key('r'), service_id: serviceId, asset_ids: foreign })).status).toBe(404);

    const { serviceId: live } = await digitalProduct('digital-flag-live');
    await sql`update app.feature_flags set enabled=false where key='DIGITAL_PRODUCTS_ENABLED'`;
    try {
      expect((await buy(await createUser('flag-buyer'), live)).status).toBe(422);
      expect((await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId })).status).toBe(422);
    } finally {
      await sql`update app.feature_flags set enabled=true where key='DIGITAL_PRODUCTS_ENABLED'`;
    }
    expect((await command(await createUser('no-consent'), { command: 'book', idempotency_key: key('b'), service_id: live })).status).toBe(422);
  });
});

describe.skipIf(!RUN_DB)('XPL-05 — exclusive license, stock 1', () => {
  it('lets exactly one of several concurrent purchases hold the license, frees it on hold expiry, and the database refuses a second one', async () => {
    const { creator, serviceId } = await digitalProduct('xpl05', { license: 'EXCLUSIVE' });
    const buyers = await Promise.all([1, 2, 3, 4, 5].map((n) => createUser(`xpl05-${n}`)));
    const results = await Promise.all(buyers.map((buyer) => buy(buyer, serviceId)));
    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => /exclusive license/.test(String(r.body.error)))).toBe(true);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    // Every run adds a "Launch kit xpl05"; newest first keeps this run's among the first results.
    const listed = await servicesRoute.GET(new Request(`${ORIGIN}/api/discovery/services?taxonomy=DIGITAL&q=${encodeURIComponent('xpl05')}&sort=newest`));
    const item = ((await listed.json()) as { items: Array<{ id: string; availability_status: string }> }).items.find((i) => i.id === serviceId);
    expect(item?.availability_status).toBe('SOLD_OUT');

    // The unpaid hold expires: the license is released and can be sold again.
    const winnerIndex = results.findIndex((r) => r.status === 200);
    const heldOrder = String(results[winnerIndex]!.body.id);
    await sql`update app.digital_entitlements set expires_at=now() - interval '1 minute' where order_id=${heldOrder}`;
    expect((await jobs.expireCheckoutHolds({ orderId: heldOrder })).outcomes).toEqual({ RELEASED: 1 });
    expect((await sql`select state from app.digital_entitlements where order_id=${heldOrder}`)[0]!.state).toBe('RELEASED');
    const late = buyers[(winnerIndex + 1) % buyers.length]!;
    const spareBuyer = buyers[(winnerIndex + 2) % buyers.length]!;
    const owner = await bought(late, serviceId);
    expect((await sql`select state from app.digital_entitlements where id=${owner.entitlementId}`)[0]!.state).toBe('ACTIVE');

    // Neither a raw insert nor switching the listing to non-exclusive sells a second license while this one is live.
    const [row] = await sql`select * from app.digital_entitlements where id=${owner.entitlementId}`;
    const [spare] = await sql`insert into app.orders (buyer_id,creator_id,service_id,service_version_id,source,title,status,amount_minor,platform_fee_minor,currency,brief,brief_ready_at,terms)
      select ${spareBuyer.id},creator_id,service_id,service_version_id,source,title,'AWAITING_PAYMENT',amount_minor,platform_fee_minor,currency,brief,brief_ready_at,terms from app.orders where id=${owner.orderId} returning id`;
    await expect(sql`insert into app.digital_entitlements (order_id,service_id,service_version_id,buyer_id,creator_id,license,release_version,updates_policy,download_limit,expires_at)
      values (${String(spare!.id)},${serviceId},${String(row!.service_version_id)},${spareBuyer.id},${creator.id},'EXCLUSIVE',1,'LATEST',5,now() + interval '15 minutes')`).rejects.toThrow(/exclusive license/);
    const [version] = await sql`select version from app.services where id=${serviceId}`;
    const switched = await command(creator, { command: 'update_service', idempotency_key: key('u'), service_id: serviceId, expected_version: String(version!.version), title: 'Launch kit xpl05', description: 'Notion and Figma templates for a token launch week, with copy prompts.', price: '40', turnaround_hours: '1', digital_license: 'NON_EXCLUSIVE', digital_rights_text: RIGHTS });
    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    const refused = await buy(spareBuyer, serviceId);
    expect(refused.status).toBe(409);
  });
});

describe.skipIf(!RUN_DB)('XPL-06 — versioned private downloads and refund rules', () => {
  it('serves only the versions the license includes and enforces the download limit', async () => {
    const { creator, serviceId } = await digitalProduct('xpl06-versions', { updates: 'PURCHASED_VERSION', downloads: 2 });
    const pinnedBuyer = await createUser('pinned');
    const pinned = await bought(pinnedBuyer, serviceId);
    await addRelease(creator, serviceId, 'xpl06-versions-v2');
    const later = await bought(await createUser('later'), serviceId);
    expect((await sql`select release_version from app.digital_entitlements where id=${later.entitlementId}`)[0]!.release_version).toBe(2);

    const first = await download(pinnedBuyer, pinned.entitlementId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.version).toBe(1);
    expect((await fetchFile(String(first.body.url))).bytes).toEqual(zip('xpl06-versions-v1'));
    expect((await download(pinnedBuyer, pinned.entitlementId, 2)).status).toBe(403);
    expect((await download(pinnedBuyer, pinned.entitlementId, 1)).status).toBe(200);
    const overLimit = await download(pinnedBuyer, pinned.entitlementId, 1);
    expect(overLimit.status).toBe(429);
    expect(await sql`select count(*)::int as n from app.digital_downloads where entitlement_id=${pinned.entitlementId}`).toEqual([{ n: 2 }]);

    const { creator: other, serviceId: latestService } = await digitalProduct('xpl06-latest', { updates: 'LATEST' });
    const follower = await createUser('follower');
    const follow = await bought(follower, latestService);
    await addRelease(other, latestService, 'xpl06-latest-v2');
    const newest = await download(follower, follow.entitlementId);
    expect(newest.body.version).toBe(2);
    expect((await fetchFile(String(newest.body.url))).bytes).toEqual(zip('xpl06-latest-v2'));
    expect((await download(follower, follow.entitlementId, 1)).status).toBe(200);
  });

  it('refunds before the first download and revokes the files; after a download only a dispute or mutual cancellation applies', async () => {
    const { creator, serviceId } = await digitalProduct('xpl06-refund');
    const [early, late, mutual] = [await createUser('refund-early'), await createUser('refund-late'), await createUser('refund-mutual')];

    const a = await bought(early, serviceId);
    expect((await command(creator, { command: 'refund_digital_purchase', idempotency_key: key('rf'), order_id: a.orderId })).status).toBe(403);
    const refunded = await command(early, { command: 'refund_digital_purchase', idempotency_key: key('rf'), order_id: a.orderId });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(200);
    expect((await sql`select state,ended_at is not null as ended from app.digital_entitlements where id=${a.entitlementId}`)[0]).toEqual({ state: 'REVOKED', ended: true });
    // The mock provider confirms the refund at once; a real provider leaves it CANCELLED + REFUND_PENDING until it confirms.
    expect(['CANCELLED', 'REFUNDED']).toContain((await sql`select status from app.orders where id=${a.orderId}`)[0]!.status);
    expect((await sql`select 1 from app.provider_operations where order_id=${a.orderId} and kind='refund.create'`)).toHaveLength(1);
    const blocked = await download(early, a.entitlementId);
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.error)).toMatch(/cancelled or refunded/);

    const b = await bought(late, serviceId);
    expect((await download(late, b.entitlementId)).status).toBe(200);
    const tooLate = await command(late, { command: 'refund_digital_purchase', idempotency_key: key('rf'), order_id: b.orderId });
    expect(tooLate.status).toBe(422);
    expect(String(tooLate.body.error)).toMatch(/already downloaded/);

    const c = await bought(mutual, serviceId);
    expect((await download(mutual, c.entitlementId)).status).toBe(200);
    const request = await command(mutual, { command: 'request_cancellation', idempotency_key: key('rc'), order_id: c.orderId, refund_amount: '40', reason: 'The archive is missing the Figma files.' });
    expect(request.status, JSON.stringify(request.body)).toBe(200);
    expect((await command(creator, { command: 'respond_cancellation', idempotency_key: key('ra'), request_id: String(request.body.id), decision: 'accept' })).status).toBe(200);
    expect((await sql`select state from app.digital_entitlements where id=${c.entitlementId}`)[0]!.state).toBe('REVOKED');
    expect((await download(mutual, c.entitlementId)).status).toBe(409);
    await expect(sql`update app.digital_entitlements set download_count=0,first_downloaded_at=null where id=${c.entitlementId}`).rejects.toThrow(/downloads only increase/);
  });
});
