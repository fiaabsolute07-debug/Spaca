import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockPaymentProvider } from '@/modules/payments/providers';
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
const downloadRoute = await import('@/app/api/assets/[id]/download-url/route');
const devUpload = await import('@/app/api/dev/storage/upload/[token]/route');
const devDownload = await import('@/app/api/dev/storage/download/[token]/route');
const requestImageRoute = await import('@/app/api/request-images/[id]/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const storage = await import('@/modules/storage/provider');
const { getOrderData } = await import('@/lib/read-model');
const { sql } = await import('@/lib/db');
const { createSession } = await import('@/lib/auth');

const SECRET = 'storage_suite_signing_secret_0001';
let root = '';
let provider: InstanceType<typeof storage.LocalStorageProvider>;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('IHDR fixture pixels for the storage suite')]);
const HTML_AS_PNG = new TextEncoder().encode('<html><body><script>alert(document.cookie)</script></body></html>');
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

async function createIntent(actor: TestUser | null, fields: { purpose: string; filename: string; mime: string; size: number; order_id?: string }) {
  return callRoute(intents.POST, '/api/assets/upload-intents', actor, { ...fields, size: String(fields.size) } as Record<string, string>);
}
const tokenOf = (url: string) => url.split('/').pop()!;
async function put(url: string, bytes: Uint8Array, type: string) {
  const response = await devUpload.PUT(new Request(`${ORIGIN}${url}`, { method: 'PUT', headers: { 'content-type': type }, body: new Blob([bytes.slice()]) }), params({ token: tokenOf(url) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const finalize = (actor: TestUser, id: string) => callRoute((request) => finalizeRoute.POST(request, params({ id })), `/api/assets/${id}/finalize`, actor, {});
const downloadUrl = (actor: TestUser | null, id: string) => callRoute((request) => downloadRoute.POST(request, params({ id })), `/api/assets/${id}/download-url`, actor, {});
const fetchDownload = (url: string) => devDownload.GET(new Request(`${ORIGIN}${url}`), params({ token: tokenOf(url) }));

async function upload(actor: TestUser, purpose: string, bytes: Uint8Array, options: { mime?: string; filename?: string; orderId?: string } = {}) {
  const mime = options.mime ?? 'image/png';
  const intent = await createIntent(actor, { purpose, filename: options.filename ?? 'frame.png', mime, size: bytes.byteLength, ...(options.orderId ? { order_id: options.orderId } : {}) });
  expect(intent.status, JSON.stringify(intent.body)).toBe(200);
  const { url } = intent.body.upload as { url: string };
  expect((await put(url, bytes, mime)).status).toBe(200);
  const done = await finalize(actor, String(intent.body.id));
  return { id: String(intent.body.id), url, finalize: done };
}

async function orderInProgress(label: string) {
  const creator = await createUser(`${label}-creator`);
  const buyer = await createUser(`${label}-buyer`);
  const { serviceId } = await createPublishedService(command, creator, { capacity: 3 });
  const orderId = String((await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief: 'Storage suite brief with enough detail to start.', accept_terms: 'on' })).body.id);
  expect((await callRoute(checkout.POST, '/api/dev/mock-checkout', buyer, { order_id: orderId })).status).toBe(200);
  expect((await command(creator, { command: 'start', idempotency_key: key('start'), order_id: orderId })).status).toBe(200);
  return { creator, buyer, orderId, serviceId };
}

async function operator(role: 'moderator' | 'support' | 'admin'): Promise<TestUser> {
  const email = `it-storage-${role}-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},${`IT ${role}`},${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},${role},'Storage suite operator grant')`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}

beforeAll(async () => {
  if (!RUN_DB) return;
  root = await mkdtemp(join(tmpdir(), 'cm-storage-it-'));
});
beforeEach(() => {
  if (!RUN_DB) return;
  provider = new storage.LocalStorageProvider({ root, secret: SECRET });
  storage.setStorageProviderForTests(provider);
  funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_storage_suite_secret_1'] }));
});
afterAll(async () => {
  if (!RUN_DB) return;
  storage.setStorageProviderForTests(undefined);
  funding.setMockPaymentProviderForTests(undefined);
  await rm(root, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('SEC-06 — upload validation', () => {
  it('rejects markup types, extension mismatches, oversize files; filenames never shape the object key', async () => {
    const creator = await createUser('sec06-creator');
    const svg = await createIntent(creator, { purpose: 'SAMPLE', filename: 'logo.svg', mime: 'image/svg+xml', size: 200 });
    const html = await createIntent(creator, { purpose: 'SAMPLE', filename: 'page.html', mime: 'text/html', size: 200 });
    const mismatch = await createIntent(creator, { purpose: 'SAMPLE', filename: 'report.png', mime: 'application/pdf', size: 200 });
    const oversize = await createIntent(creator, { purpose: 'SAMPLE', filename: 'huge.png', mime: 'image/png', size: 10 * 1024 * 1024 + 1 });
    expect([svg.status, html.status, mismatch.status, oversize.status]).toEqual([422, 422, 422, 422]);

    const traversal = await createIntent(creator, { purpose: 'SAMPLE', filename: '../../../etc/passwd.png', mime: 'image/png', size: PNG.byteLength });
    expect(traversal.status).toBe(200);
    const [row] = await sql`select object_key,filename,owner_id,bucket from app.upload_intents where id=${String(traversal.body.id)}`;
    expect(row).toMatchObject({ filename: 'passwd.png', owner_id: creator.id, bucket: 'public-portfolio', object_key: `sample/${creator.id}/${String(traversal.body.id)}.png` });
    expect(() => provider.pathFor('private-deliverables', '../../escape.png')).toThrow(/Invalid object key/);
  });

  it('quarantines content that does not match its declared type; it has no download path and cannot be delivered', async () => {
    const { creator, buyer, orderId } = await orderInProgress('sec06q');
    const disguised = await upload(creator, 'DELIVERY', HTML_AS_PNG, { orderId });
    expect(disguised.finalize.status).toBe(422);
    expect(disguised.finalize.body).toMatchObject({ state: 'QUARANTINED' });
    const [asset] = await sql`select bucket,object_key,lifecycle_state,scan_status,scan_detail from app.storage_assets where id=${disguised.id}`;
    expect(asset).toMatchObject({ bucket: 'private-quarantine', lifecycle_state: 'QUARANTINED', scan_status: 'QUARANTINED' });
    expect(String(asset!.scan_detail)).toMatch(/markup/);
    expect(await provider.stat('private-deliverables', String(asset!.object_key))).toBeNull();
    expect(await provider.stat('private-quarantine', String(asset!.object_key))).not.toBeNull();

    expect((await downloadUrl(creator, disguised.id)).status).toBe(409);
    expect((await downloadUrl(buyer, disguised.id)).status).toBe(409);
    await expect(provider.createSignedDownload('private-quarantine', String(asset!.object_key), { filename: 'x.png', contentType: 'image/png', ttlSeconds: 60 })).rejects.toThrow(/Quarantined/);
    const delivered = await command(creator, { command: 'deliver', idempotency_key: key('d'), order_id: orderId, asset_ids: disguised.id });
    expect(delivered.status).toBe(422);
    expect((await sql`select status from app.orders where id=${orderId}`)[0]!.status).toBe('IN_PROGRESS');
    // Finalize is idempotent and keeps the recorded outcome.
    expect((await finalize(creator, disguised.id)).body).toMatchObject({ state: 'QUARANTINED' });
  });

  it('enforces declared size, write-once objects and signed upload scope', async () => {
    const { creator, orderId } = await orderInProgress('sec06s');
    const intent = await createIntent(creator, { purpose: 'DELIVERY', filename: 'short.pdf', mime: 'application/pdf', size: PDF.byteLength + 20, order_id: orderId });
    const url = (intent.body.upload as { url: string }).url;
    expect((await put(url, new Uint8Array([...PDF, ...new Uint8Array(40)]), 'application/pdf')).status).toBe(413);
    expect((await put(url, PDF, 'image/png')).status).toBe(400);
    expect((await put(url, PDF, 'application/pdf')).status).toBe(200);
    expect((await put(url, PDF, 'application/pdf')).status).toBe(409);
    const rejected = await finalize(creator, String(intent.body.id));
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ state: 'REJECTED' });
    const [row] = await sql`select object_key,outcome from app.upload_intents where id=${String(intent.body.id)}`;
    expect(row!.outcome).toBe('REJECTED');
    expect(await provider.stat('private-deliverables', String(row!.object_key))).toBeNull();
    expect((await sql`select count(*)::int as n from app.storage_assets where id=${String(intent.body.id)}`)[0]!.n).toBe(0);

    const [version, payload, mac] = tokenOf(url).split('.');
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>;
    forged.max = 999_999_999;
    const tampered = `/api/dev/storage/upload/${version}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${mac}`;
    expect((await put(tampered, PDF, 'application/pdf')).status).toBe(403);
    const other = await createIntent(creator, { purpose: 'DELIVERY', filename: 'late.pdf', mime: 'application/pdf', size: PDF.byteLength, order_id: orderId });
    storage.setStorageProviderForTests(new storage.LocalStorageProvider({ root, secret: SECRET, now: () => Date.now() + 16 * 60_000 }));
    expect((await put((other.body.upload as { url: string }).url, PDF, 'application/pdf')).status).toBe(403);
    const asDownload = await devDownload.GET(new Request(`${ORIGIN}/x`), params({ token: tokenOf((other.body.upload as { url: string }).url) }));
    expect(asDownload.status).toBe(403);
  });

  it('only the right participant uploads for an order in the right state, within the hourly quota', async () => {
    const { creator, buyer, orderId } = await orderInProgress('sec06p');
    const outsider = await createUser('sec06p-outsider');
    const png = { filename: 'a.png', mime: 'image/png', size: PNG.byteLength, order_id: orderId };
    expect((await createIntent(buyer, { purpose: 'DELIVERY', ...png })).status).toBe(403);
    expect((await createIntent(creator, { purpose: 'BRIEF', ...png })).status).toBe(403);
    expect((await createIntent(outsider, { purpose: 'DISPUTE', ...png })).status).toBe(404);
    expect((await createIntent(null, { purpose: 'DELIVERY', ...png })).status).toBe(401);
    expect((await callRoute(intents.POST, '/api/assets/upload-intents', creator, { purpose: 'DELIVERY', ...png, size: String(PNG.byteLength) }, { origin: 'https://attacker.test' })).status).toBe(403);

    const mine = await upload(creator, 'DELIVERY', PNG, { orderId });
    expect((await finalize(buyer, mine.id)).status).toBe(404);

    await sql`update app.users set status='SUSPENDED' where id=${outsider.id}`;
    expect((await createIntent(outsider, { purpose: 'SAMPLE', filename: 'a.png', mime: 'image/png', size: 10 })).status).toBe(403);

    const busy = await createUser('sec06p-busy');
    for (let i = 0; i < 30; i++) expect((await createIntent(busy, { purpose: 'SAMPLE', filename: `s${i}.png`, mime: 'image/png', size: 10 })).status).toBe(200);
    expect((await createIntent(busy, { purpose: 'SAMPLE', filename: 'over.png', mime: 'image/png', size: 10 })).status).toBe(429);
  }, 30_000);
});

describe.skipIf(!RUN_DB)('SEC-01/SEC-05 — private delivery downloads', () => {
  it('delivers files to the buyer through short-lived attachment URLs and denies everyone else', async () => {
    const { creator, buyer, orderId } = await orderInProgress('sec05');
    const outsider = await createUser('sec05-outsider');
    const file = await upload(creator, 'DELIVERY', PNG, { orderId, filename: 'Final cut (v1).png' });
    expect(file.finalize.status).toBe(200);
    const [asset] = await sql`select sha256,size_bytes,lifecycle_state,bucket from app.storage_assets where id=${file.id}`;
    expect(asset).toMatchObject({ sha256: createHash('sha256').update(PNG).digest('hex'), lifecycle_state: 'READY', bucket: 'private-deliverables' });

    const buyerView = await getOrderData({ id: buyer.id, email: buyer.email, display_name: 'b', roles: ['buyer'], is_test: true, status: 'ACTIVE', timezone: 'UTC' }, orderId);
    expect(buyerView!.files.map((f) => f.id)).not.toContain(file.id);
    const delivered = await command(creator, { command: 'deliver', idempotency_key: key('d'), order_id: orderId, asset_ids: file.id });
    expect(delivered.status).toBe(200);
    const afterDelivery = await getOrderData({ id: buyer.id, email: buyer.email, display_name: 'b', roles: ['buyer'], is_test: true, status: 'ACTIVE', timezone: 'UTC' }, orderId);
    expect(afterDelivery!.files.find((f) => f.id === file.id)).toMatchObject({ filename: 'Final cut (v1).png', lifecycle_state: 'READY' });
    expect((await sql`select body from app.deliveries where order_id=${orderId}`)[0]!.body).toBe('(see attached files)');

    const granted = await downloadUrl(buyer, file.id);
    expect(granted.status).toBe(200);
    expect(new Date(String(granted.body.expires_at)).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000);
    const response = await fetchDownload(String(granted.body.url));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="Final cut \(v1\)\.png"/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('cache-control')).toContain('no-store');

    expect((await downloadUrl(outsider, file.id)).status).toBe(404);
    expect((await downloadUrl(null, file.id)).status).toBe(404);
    expect((await downloadUrl(buyer, randomUUID())).status).toBe(404);

    storage.setStorageProviderForTests(new storage.LocalStorageProvider({ root, secret: SECRET, now: () => Date.now() + 6 * 60_000 }));
    expect((await fetchDownload(String(granted.body.url))).status).toBe(403);
    storage.setStorageProviderForTests(new storage.LocalStorageProvider({ root, secret: 'a_different_storage_secret_9999' }));
    expect((await fetchDownload(String(granted.body.url))).status).toBe(403);
  });

  it('support can open dispute evidence with an audit entry; outsiders cannot', async () => {
    const { creator, buyer, orderId } = await orderInProgress('dispute-files');
    const support = await operator('support');
    const moderator = await operator('moderator');
    expect((await command(buyer, { command: 'dispute', idempotency_key: key('x'), order_id: orderId, body: 'The work is not what we agreed.' })).status).toBe(200);
    const evidence = await upload(buyer, 'DISPUTE', PDF, { orderId, mime: 'application/pdf', filename: 'evidence.pdf' });
    expect(evidence.finalize.status).toBe(200);
    expect((await downloadUrl(creator, evidence.id)).status).toBe(200);
    expect((await downloadUrl(moderator, evidence.id)).status).toBe(404);
    expect((await downloadUrl(support, evidence.id)).status).toBe(200);
    const [entry] = await sql`select action,actor_id,reason from app.audit_log where entity_id=${evidence.id}`;
    expect(entry).toMatchObject({ action: 'asset.operator_download', actor_id: support.id });
  });
});

describe.skipIf(!RUN_DB)('SEC-14 — scope and consent', () => {
  it('a delivery file cannot become a portfolio sample or move to another order, even with direct SQL', async () => {
    const first = await orderInProgress('sec14a');
    const file = await upload(first.creator, 'DELIVERY', PNG, { orderId: first.orderId });
    expect(file.finalize.status).toBe(200);
    const asSample = await command(first.creator, { command: 'add_sample', idempotency_key: key('s'), title: 'Reuse delivery', asset_id: file.id });
    expect(asSample.status).toBe(422);

    // Same creator, second order.
    const buyer2 = await createUser('sec14-buyer2');
    const second = String((await command(buyer2, { command: 'book', idempotency_key: key('b'), service_id: first.serviceId, brief: 'Second order brief with enough detail to start.', accept_terms: 'on' })).body.id);
    expect((await callRoute(checkout.POST, '/api/dev/mock-checkout', buyer2, { order_id: second })).status).toBe(200);
    expect((await command(first.creator, { command: 'start', idempotency_key: key('s'), order_id: second })).status).toBe(200);
    expect((await command(first.creator, { command: 'deliver', idempotency_key: key('d'), order_id: second, asset_ids: file.id })).status).toBe(422);

    expect((await command(first.creator, { command: 'deliver', idempotency_key: key('d'), order_id: second, body: 'Delivered text for the second order, complete.' })).status).toBe(200);
    const [delivery] = await sql`select id from app.deliveries where order_id=${second}`;
    await expect(sql`insert into app.delivery_assets (delivery_id,order_id,asset_id,position) values (${String(delivery!.id)},${second},${file.id},1)`).rejects.toThrow(/foreign key/);
    const [sample] = await sql`insert into app.samples (creator_id,title,url,moderation_status) values (${first.creator.id},'Direct','https://example.com/d','PENDING') returning id`;
    await expect(sql`update app.samples set storage_asset_id=${file.id} where id=${String(sample!.id)}`).rejects.toThrow(/foreign key/);
    await expect(sql`update app.storage_assets set order_id=${second} where id=${file.id}`).rejects.toThrow(/immutable/);
  });

  it('uploaded samples stay private until moderation approves a PUBLIC sample', async () => {
    const creator = await createUser('sample-creator');
    const moderator = await operator('moderator');
    const file = await upload(creator, 'SAMPLE', PNG, { filename: 'portfolio.png' });
    expect(file.finalize.status).toBe(200);
    const sample = await command(creator, { command: 'add_sample', idempotency_key: key('s'), title: 'Uploaded frame', asset_id: file.id, visibility: 'PUBLIC' });
    expect(sample.status).toBe(200);
    expect((await command(creator, { command: 'add_sample', idempotency_key: key('s'), title: 'Same file twice', asset_id: file.id })).status).toBe(422);
    expect((await downloadUrl(null, file.id)).status).toBe(404);
    expect((await downloadUrl(creator, file.id)).status).toBe(200);
    expect((await command(moderator, { command: 'admin_moderate_sample', idempotency_key: key('m'), sample_id: String(sample.body.id), decision: 'APPROVED', reason: 'Portfolio frame meets the content policy.' })).status).toBe(200);
    expect((await downloadUrl(null, file.id)).status).toBe(200);
  });
});

describe.skipIf(!RUN_DB)('ORD-07 / cleanup', () => {
  it('a quarantined delivery file stops auto-accept and downloads', async () => {
    const { creator, buyer, orderId } = await orderInProgress('ord07');
    const moderator = await operator('moderator');
    const file = await upload(creator, 'DELIVERY', PNG, { orderId });
    expect((await command(creator, { command: 'deliver', idempotency_key: key('d'), order_id: orderId, asset_ids: file.id })).status).toBe(200);
    await sql`update app.deliveries set buyer_viewed_at=now() where order_id=${orderId}`;
    await sql`update app.orders set review_due_at=now() - interval '1 minute' where id=${orderId}`;

    expect((await command(buyer, { command: 'admin_quarantine_asset', idempotency_key: key('q'), asset_id: file.id, reason: 'Reported as malware by the buyer.' })).status).toBe(403);
    expect((await command(moderator, { command: 'admin_quarantine_asset', idempotency_key: key('q'), asset_id: file.id, reason: 'Reported as malware by the buyer.' })).status).toBe(200);
    expect((await downloadUrl(buyer, file.id)).status).toBe(409);
    const report = await jobs.autoAcceptDeliveries({ orderId });
    expect(report.outcomes).toEqual({ HOLD_DELIVERY_NOT_VALID: 1 });
    expect((await sql`select status from app.orders where id=${orderId}`)[0]!.status).toBe('DELIVERED');
    expect((await sql`select action from app.audit_log where entity_id=${file.id}`).map((r) => r.action)).toEqual(['asset.quarantine']);
  });

  it('removes abandoned uploads and unattached files, never referenced ones', async () => {
    const { creator, orderId } = await orderInProgress('cleanup');
    const attached = await upload(creator, 'DELIVERY', PNG, { orderId, filename: 'kept.png' });
    const orphan = await upload(creator, 'DELIVERY', PNG, { orderId, filename: 'orphan.png' });
    expect((await command(creator, { command: 'deliver', idempotency_key: key('d'), order_id: orderId, asset_ids: attached.id })).status).toBe(200);
    const abandoned = await createIntent(creator, { purpose: 'DISPUTE', filename: 'never.png', mime: 'image/png', size: PNG.byteLength, order_id: orderId });
    expect((await put((abandoned.body.upload as { url: string }).url, PNG, 'image/png')).status).toBe(200);
    await sql`update app.upload_intents set expires_at=now() - interval '2 hours' where id=${String(abandoned.body.id)}`;
    expect((await finalize(creator, String(abandoned.body.id))).status).toBe(409);

    const report = await jobs.cleanupStorage({ orderId, orphanGraceSeconds: 0 });
    expect(report.outcomes).toEqual({ ABANDONED_UPLOAD_REMOVED: 1, ORPHAN_REMOVED: 1 });
    const states = Object.fromEntries((await sql`select id,lifecycle_state,object_key from app.storage_assets where order_id=${orderId}`).map((r) => [String(r.id), r]));
    expect(states[attached.id]!.lifecycle_state).toBe('READY');
    expect(states[orphan.id]!.lifecycle_state).toBe('DELETED');
    expect(await provider.stat('private-deliverables', String(states[orphan.id]!.object_key))).toBeNull();
    expect(await provider.stat('private-deliverables', String(states[attached.id]!.object_key))).not.toBeNull();
    const [intentRow] = await sql`select outcome,object_key from app.upload_intents where id=${String(abandoned.body.id)}`;
    expect(intentRow!.outcome).toBe('ABANDONED');
    expect(await provider.stat('private-disputes', String(intentRow!.object_key))).toBeNull();
    await expect(sql`update app.storage_assets set lifecycle_state='DELETED',deleted_at=now() where id=${attached.id}`).rejects.toThrow(/referenced/);
    await expect(sql`delete from app.storage_assets where id=${attached.id}`).rejects.toThrow();
  });
});

describe.skipIf(!RUN_DB)('Campaign images — the buyer\'s own uploads, public only while the campaign is visible', () => {
  const inDays = (days: number) => commandInstant(new Date(Date.now() + days * 86_400_000));
  const imageGet = async (actor: TestUser | null, id: string) => {
    sessionState.token = actor?.token ?? null;
    return requestImageRoute.GET(new Request(`${ORIGIN}/api/request-images/${id}`), params({ id }));
  };
  const createCampaign = (buyer: TestUser, fields: Record<string, string>) => command(buyer, {
    command: 'create_request', idempotency_key: key('req'), title: 'Campaign with project images',
    brief: 'Launch threads for our public beta; the screenshots show the product flow.', taxonomy: 'CREATE', budget: '300', target_hires: '1', deadline: inDays(14), ...fields,
  });
  const setImages = (actor: TestUser, fields: Record<string, string>) => command(actor, { command: 'set_request_images', idempotency_key: key('img'), ...fields });

  it('attaches images in the order given; anyone sees them on an open campaign, and an unattached upload stays private', async () => {
    const buyer = await createUser('img-buyer', ['buyer']);
    const first = await upload(buyer, 'REQUEST_IMAGE', PNG, { filename: 'one.png' });
    const second = await upload(buyer, 'REQUEST_IMAGE', PNG, { filename: 'two.png' });
    expect([first.finalize.status, second.finalize.status]).toEqual([200, 200]);
    const [intent] = await sql`select bucket from app.upload_intents where id=${first.id}`;
    expect(intent!.bucket).toBe('public-campaigns');

    const created = await createCampaign(buyer, { image_ids: `${second.id},${first.id}` });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const requestId = String(created.body.id);
    const rows = await sql`select asset_id,position from app.request_images where request_id=${requestId} order by position`;
    expect(rows.map((r) => [String(r.asset_id), Number(r.position)])).toEqual([[second.id, 0], [first.id, 1]]);
    expect((await imageGet(null, first.id)).status).toBe(302);
    expect((await downloadUrl(null, first.id)).status).toBe(200);

    const loose = await upload(buyer, 'REQUEST_IMAGE', PNG, { filename: 'loose.png' });
    expect((await imageGet(null, loose.id)).status).toBe(404);
    expect((await downloadUrl(null, loose.id)).status).toBe(404);
    expect((await downloadUrl(buyer, loose.id)).status).toBe(200);
  });

  it('refuses creator uploads, non-images, other people\'s files, other purposes and more than six images', async () => {
    const buyer = await createUser('img-owner', ['buyer']);
    const other = await createUser('img-other', ['buyer']);
    const creator = await createUser('img-creator', ['creator']);
    expect((await createIntent(creator, { purpose: 'REQUEST_IMAGE', filename: 'c.png', mime: 'image/png', size: PNG.byteLength })).status).toBe(403);
    expect((await createIntent(buyer, { purpose: 'REQUEST_IMAGE', filename: 'brief.pdf', mime: 'application/pdf', size: PDF.byteLength })).status).toBe(422);

    const theirs = await upload(other, 'REQUEST_IMAGE', PNG);
    expect((await createCampaign(buyer, { image_ids: theirs.id })).status).toBe(404);
    const avatar = await upload(buyer, 'AVATAR', PNG);
    expect((await createCampaign(buyer, { image_ids: avatar.id })).status).toBe(404);
    const mine = [];
    for (let n = 0; n < 7; n++) mine.push(await upload(buyer, 'REQUEST_IMAGE', PNG, { filename: `n${n}.png` }));
    const tooMany = await createCampaign(buyer, { image_ids: mine.map((image) => image.id).join(',') });
    expect(tooMany.status).toBe(400);
    expect(JSON.stringify(tooMany.body)).toContain('at most 6 images');
    // Refused commands roll back: no campaign was created.
    expect((await sql`select count(*)::int as n from app.requests where buyer_id=${buyer.id}`)[0]!.n).toBe(0);

    const kept = await createCampaign(buyer, { image_ids: mine[0]!.id });
    expect(kept.status).toBe(200);
    const requestId = String(kept.body.id);
    // The database itself refuses an image that is not the campaign buyer's own REQUEST_IMAGE upload.
    await expect(sql`insert into app.request_images (request_id,buyer_id,asset_id,position) values (${requestId},${buyer.id},${theirs.id},1)`).rejects.toThrow(/foreign key/);
    await expect(sql`insert into app.request_images (request_id,buyer_id,asset_id,position) values (${requestId},${other.id},${theirs.id},1)`).rejects.toThrow(/foreign key/);
    await expect(sql`insert into app.request_images (request_id,buyer_id,asset_id,position) values (${requestId},${buyer.id},${avatar.id},1)`).rejects.toThrow(/foreign key|check constraint/);
    await expect(sql`update app.storage_assets set lifecycle_state='DELETED',deleted_at=now() where id=${mine[0]!.id}`).rejects.toThrow(/referenced/);
  });

  it('the buyer replaces or removes images while the campaign is open; a cancelled campaign\'s images are hidden from others', async () => {
    const buyer = await createUser('img-edit', ['buyer']);
    const stranger = await createUser('img-stranger', ['buyer']);
    const a = await upload(buyer, 'REQUEST_IMAGE', PNG, { filename: 'a.png' });
    const b = await upload(buyer, 'REQUEST_IMAGE', PNG, { filename: 'b.png' });
    const requestId = String((await createCampaign(buyer, { image_ids: a.id })).body.id);

    expect((await setImages(stranger, { request_id: requestId, image_ids: b.id })).status).toBe(404);
    expect((await setImages(buyer, { request_id: requestId })).status).toBe(400);
    expect((await setImages(buyer, { request_id: requestId, image_ids: b.id })).status).toBe(200);
    expect((await sql`select asset_id from app.request_images where request_id=${requestId}`).map((r) => String(r.asset_id))).toEqual([b.id]);
    expect((await imageGet(null, a.id)).status).toBe(404);
    expect((await setImages(buyer, { request_id: requestId, clear: 'true' })).status).toBe(200);
    expect((await sql`select count(*)::int as n from app.request_images where request_id=${requestId}`)[0]!.n).toBe(0);

    expect((await setImages(buyer, { request_id: requestId, image_ids: a.id })).status).toBe(200);
    expect((await command(buyer, { command: 'cancel_request', idempotency_key: key('cancel'), request_id: requestId })).status).toBe(200);
    expect((await imageGet(null, a.id)).status).toBe(404);
    expect((await imageGet(stranger, a.id)).status).toBe(404);
    expect((await imageGet(buyer, a.id)).status).toBe(302);
    expect((await setImages(buyer, { request_id: requestId, image_ids: b.id })).status).toBe(422);
  });

  it('cards get the small copy made at upload; quarantining either picture takes both out of view', async () => {
    const buyer = await createUser('img-thumb', ['buyer']);
    const full = await upload(buyer, 'REQUEST_IMAGE', PNG, { filename: 'screen.png' });
    const small = await upload(buyer, 'REQUEST_IMAGE', PNG, { filename: 'thumb-screen.png' });
    const plain = await upload(buyer, 'REQUEST_IMAGE', PNG, { filename: 'no-thumb.png' });
    // Thumbnails line up with images by position; a blank entry means that image has no copy.
    const created = await createCampaign(buyer, { image_ids: `${full.id},${plain.id}`, thumb_ids: `${small.id},` });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const requestId = String(created.body.id);
    expect((await sql`select asset_id,thumb_asset_id from app.request_images where request_id=${requestId} order by position`).map((r) => [String(r.asset_id), r.thumb_asset_id && String(r.thumb_asset_id)]))
      .toEqual([[full.id, small.id], [plain.id, null]]);
    const [card] = (await sql`select coalesce((select array_agg(coalesce(i.thumb_asset_id,i.asset_id) order by i.position) from app.request_images i where i.request_id=${requestId}),'{}') as thumb_ids`);
    expect((card!.thumb_ids as string[]).map(String)).toEqual([small.id, plain.id]);
    expect((await imageGet(null, small.id)).status).toBe(302);

    // A copy must be the buyer's own image, and never the image itself.
    const other = await createUser('img-thumb-other', ['buyer']);
    const theirs = await upload(other, 'REQUEST_IMAGE', PNG);
    expect((await setImages(buyer, { request_id: requestId, image_ids: full.id, thumb_ids: theirs.id })).status).toBe(404);
    await expect(sql`update app.request_images set thumb_asset_id=asset_id where request_id=${requestId} and position=0`).rejects.toThrow();
    await expect(sql`update app.storage_assets set lifecycle_state='DELETED',deleted_at=now() where id=${small.id}`).rejects.toThrow(/referenced/);

    const email = `it-mod-${randomUUID().slice(0, 8)}@example.test`;
    const [row] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'IT moderator',${[]},true,'ACTIVE') returning id`;
    await sql`insert into app.user_roles (user_id,role,granted_reason) values (${row!.id},'moderator','Integration test operator grant')`;
    const moderator: TestUser = { id: row!.id, email, token: await createSession(row!.id) };
    const quarantined = await command(moderator, { command: 'admin_quarantine_asset', idempotency_key: key('q'), asset_id: full.id, reason: 'The screenshot shows another project\'s private dashboard.' });
    expect(quarantined.status, JSON.stringify(quarantined.body)).toBe(200);
    expect((await sql`select id,lifecycle_state from app.storage_assets where id in (${full.id},${small.id}) order by id`).map((r) => String(r.lifecycle_state))).toEqual(['QUARANTINED', 'QUARANTINED']);
    expect((await imageGet(null, full.id)).status).toBe(404);
    expect((await imageGet(null, small.id)).status).toBe(404);
    expect((await imageGet(buyer, small.id)).status).toBe(404);
    expect((await imageGet(null, plain.id)).status).toBe(302);
  });
});
