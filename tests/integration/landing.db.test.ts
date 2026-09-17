import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORIGIN, RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const intents = await import('@/app/api/assets/upload-intents/route');
const finalizeRoute = await import('@/app/api/assets/[id]/finalize/route');
const devUpload = await import('@/app/api/dev/storage/upload/[token]/route');
const storage = await import('@/modules/storage/provider');
const { getLandingShowcase } = await import('@/lib/read-model');
const { sql } = await import('@/lib/db');
const { createSession } = await import('@/lib/auth');

const SECRET = 'landing_suite_signing_secret_001';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('IHDR fixture pixels for the landing suite')]);
let root = '';

/**
 * The test database keeps every row earlier runs made — over 13,000 creators with a published service when this
 * was written — so these tests ask for far more than the page a real visitor gets. A fixed page size would sort
 * the fixture off the end as the database grows and fail for a reason that has nothing to do with the code. If a
 * lookup below ever misses, raise this rather than assuming the query broke.
 */
const LOTS = 50_000;

const command = (actor: TestUser, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const tokenOf = (url: string) => url.split('/').pop()!;

async function moderator(): Promise<TestUser> {
  const email = `it-landing-mod-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'IT moderator',${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},'moderator','Landing suite operator grant')`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}

/** An uploaded, scanned, READY image the way a creator actually adds one. */
async function uploadImage(actor: TestUser): Promise<string> {
  const intent = await callRoute(intents.POST, '/api/assets/upload-intents', actor,
    { purpose: 'SAMPLE', filename: 'frame.png', mime: 'image/png', size: String(PNG.byteLength) });
  expect(intent.status, JSON.stringify(intent.body)).toBe(200);
  const { url } = intent.body.upload as { url: string };
  const put = await devUpload.PUT(new Request(`${ORIGIN}${url}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Blob([PNG.slice()]) }), params({ token: tokenOf(url) }));
  expect(put.status).toBe(200);
  const id = String(intent.body.id);
  expect((await callRoute((request) => finalizeRoute.POST(request, params({ id })), `/api/assets/${id}/finalize`, actor, {})).status).toBe(200);
  return id;
}

/** A service that is allowed on the landing: published, with a public image sample a moderator approved. */
async function serviceWithPicture(label: string, price: string) {
  const creator = await createUser(`landing-${label}`, ['creator']);
  const { serviceId } = await createPublishedService(command, creator, { price });
  const assetId = await uploadImage(creator);
  const added = await command(creator, { command: 'add_sample', idempotency_key: key('sample'), title: 'A previous launch thread', asset_id: assetId, visibility: 'PUBLIC', service_id: serviceId });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const sampleId = String(added.body.id);
  await sql`insert into app.service_samples (service_id,sample_id,creator_id) values (${serviceId},${sampleId},${creator.id}) on conflict do nothing`;
  return { creator, serviceId, sampleId, assetId };
}

beforeAll(async () => { if (RUN_DB) root = await mkdtemp(join(tmpdir(), 'cm-landing-it-')); });
beforeEach(() => { if (RUN_DB) storage.setStorageProviderForTests(new storage.LocalStorageProvider({ root, secret: SECRET })); });
afterAll(async () => {
  if (!RUN_DB) return;
  storage.setStorageProviderForTests(undefined);
  await rm(root, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('the landing page reads only real stock', () => {
  it('lists a published service once its picture is public and approved, and not before', async () => {
    const mod = await moderator();
    const { serviceId, sampleId } = await serviceWithPicture('approved', '250');

    // Pending moderation: the work is not public yet, so the landing must not show it.
    const before = await getLandingShowcase({ services: LOTS });
    expect(before.services.map((service) => String(service.id))).not.toContain(serviceId);

    expect((await command(mod, { command: 'admin_moderate_sample', idempotency_key: key('mod'), sample_id: sampleId, decision: 'APPROVED', reason: 'Portfolio frame meets the content policy.' })).status).toBe(200);

    const after = await getLandingShowcase({ services: LOTS });
    const listed = after.services.find((service) => String(service.id) === serviceId);
    expect(listed, 'an approved public image should put the service on the landing').toBeTruthy();
    expect(Number(listed!.price_minor)).toBe(25000);
    expect(String(listed!.sample_asset_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(listed!.creator_name)).toBeTruthy();
  });

  it('never lists a published service whose only sample is a link, because there is no picture to show', async () => {
    const creator = await createUser('landing-linkonly', ['creator']);
    const { serviceId } = await createPublishedService(command, creator, { price: '300' });
    await sql`update app.samples set moderation_status='APPROVED', visibility='PUBLIC' where creator_id=${creator.id}`;
    const showcase = await getLandingShowcase({ services: LOTS });
    expect(showcase.services.map((service) => String(service.id))).not.toContain(serviceId);
  });

  it('calls the strip "new" while no service has the completed orders and views that trending needs (DSC-04)', async () => {
    const showcase = await getLandingShowcase();
    expect(showcase.services_label).toBe('NEW');
  });

  it('shows a creator with the lowest price they publish and whether they can take an order', async () => {
    const creator = await createUser('landing-creator', ['creator']);
    await createPublishedService(command, creator, { price: '400' });
    await createPublishedService(command, creator, { price: '120' });

    const listed = (await getLandingShowcase({ creators: LOTS })).creators.find((row) => String(row.id) === creator.id);
    expect(listed, `a creator with published services belongs on the landing (raise LOTS past ${LOTS} if the test database has outgrown it)`).toBeTruthy();
    expect(Number(listed!.from_price_minor)).toBe(12000);
    expect(listed!.availability_status).toBe('ACCEPTING');

    expect((await command(creator, { command: 'set_accepting_orders', idempotency_key: key('pause'), accepting: 'false' })).status).toBe(200);
    const paused = (await getLandingShowcase({ creators: LOTS })).creators.find((row) => String(row.id) === creator.id);
    expect(paused!.availability_status).toBe('PAUSED');
  });
});

describe.skipIf(!RUN_DB)('the landing auctions strip, in both of its states', () => {
  const HOUR = 3600_000;
  const utc = (date: Date) => date.toISOString().slice(0, 16);

  async function openListing(seller: TestUser, overrides: Record<string, string> = {}) {
    const now = Date.now();
    const created = await command(seller, {
      command: 'create_item_listing', idempotency_key: key('item'), origin: 'RESALE', item_type: 'WL spot',
      title: `Landing suite WL spot ${randomUUID().slice(0, 8)}`, project_name: 'Arcadia', project_url: 'arcadia.example',
      network: 'Base', quantity: '1 spot', description: 'One whitelist spot for the Arcadia genesis mint, mint price 0.02 ETH.',
      delivery_method: 'The project adds your wallet to the allowlist before the mint.', buyer_provides: 'EVM wallet address',
      starting_price: '100', min_increment: '10', collateral: '20',
      starts_at: utc(new Date(now - 60_000)), ends_at: utc(new Date(now + 2 * HOUR)), delivery_due_at: utc(new Date(now + 26 * HOUR)),
      ...overrides,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = String(created.body.id);
    expect((await command(seller, { command: 'post_item_collateral', idempotency_key: key('col'), listing_id: id })).status).toBe(200);
    return id;
  }

  it('carries an open auction with dates a browser can parse, and drops it once it is cancelled', async () => {
    const seller = await createUser('landing-seller', ['creator']);
    const id = await openListing(seller);

    const live = await getLandingShowcase({ auctions: LOTS });
    const listing = live.auctions.find((row) => String(row.id) === id);
    expect(listing, 'an open listing belongs on the landing').toBeTruthy();
    expect(Number(listing!.starting_price_minor)).toBe(10000);
    expect(Number(listing!.min_increment_minor)).toBe(1000);
    // `<time datetime>` and the countdown both need ISO 8601, not Postgres' own spelling.
    expect(String(listing!.ends_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(String(listing!.ends_at)))).toBe(false);
    expect(Number.isNaN(Date.parse(live.server_now))).toBe(false);

    expect((await command(seller, { command: 'cancel_item_listing', idempotency_key: key('cancel'), listing_id: id, reason: 'The allowlist spot was withdrawn by the project.' })).status).toBe(200);
    const after = await getLandingShowcase({ auctions: LOTS });
    expect(after.auctions.map((row) => String(row.id))).not.toContain(id);
  });

  it('leaves the strip empty rather than showing an auction that has already ended', async () => {
    const seller = await createUser('landing-seller-ended', ['creator']);
    const id = await openListing(seller);
    await sql`update app.item_listings set starts_at=now() - interval '3 hours', ends_at=now() - interval '1 hour' where id=${id}`;
    const showcase = await getLandingShowcase({ auctions: LOTS });
    expect(showcase.auctions.map((row) => String(row.id))).not.toContain(id);
  });
});
