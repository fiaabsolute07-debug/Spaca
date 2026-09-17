import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { ORIGIN, RUN_DB, callRoute, createUser, key, sessionState, type TestUser } from './harness';

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
const imageRoute = await import('@/app/api/item-images/[id]/route');
const funding = await import('@/modules/payments/funding');
const storage = await import('@/modules/storage/provider');
const queries = await import('@/modules/items/queries');
const { sql } = await import('@/lib/db');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('IHDR item picture suite pixels')]);
let root = '';
const command = (actor: TestUser, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const utc = (date: Date) => date.toISOString().slice(0, 16);

async function upload(actor: TestUser, filename = 'art.png'): Promise<string> {
  const intent = await callRoute(intents.POST, '/api/assets/upload-intents', actor, { purpose: 'ITEM_IMAGE', filename, mime: 'image/png', size: String(PNG.byteLength) });
  expect(intent.status, JSON.stringify(intent.body)).toBe(200);
  const { url } = intent.body.upload as { url: string };
  expect((await devUpload.PUT(new Request(`${ORIGIN}${url}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Blob([PNG.slice()]) }), params({ token: url.split('/').pop()! }))).status).toBe(200);
  const done = await callRoute((request) => finalizeRoute.POST(request, params({ id: String(intent.body.id) })), `/api/assets/${String(intent.body.id)}/finalize`, actor, {});
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return String(intent.body.id);
}

async function picture(actor: TestUser | null, id: string): Promise<number> {
  sessionState.token = actor?.token ?? null;
  return (await imageRoute.GET(new Request(`${ORIGIN}/api/item-images/${id}`), params({ id }))).status;
}

function listing(extra: Record<string, string>): Record<string, string> {
  const now = Date.now();
  return {
    command: 'create_item_listing', idempotency_key: key('item'), origin: 'RESALE', item_type: 'NFT', title: 'Nebula Punks #042 genesis NFT',
    project_name: 'Nebula Punks', network: 'Base', quantity: '1 NFT', description: 'Genesis Nebula Punk #042 with the violet background.',
    delivery_method: 'I transfer the NFT to the winner wallet on Base.', buyer_provides: 'Base wallet address',
    starting_price: '200', min_increment: '10', collateral: '60',
    starts_at: utc(new Date(now - 60_000)), ends_at: utc(new Date(now + 2 * 3600_000)), delivery_due_at: utc(new Date(now + 26 * 3600_000)), ...extra,
  };
}

beforeAll(async () => {
  if (RUN_DB) root = await mkdtemp(join(tmpdir(), 'cm-item-images-it-'));
});
beforeEach(() => {
  if (!RUN_DB) return;
  storage.setStorageProviderForTests(new storage.LocalStorageProvider({ root, secret: 'item_images_suite_signing_secret' }));
  funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_item_images_suite_1'] }));
});
afterAll(async () => {
  if (!RUN_DB) return;
  storage.setStorageProviderForTests(undefined);
  funding.setMockPaymentProviderForTests(undefined);
  await rm(root, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('Item auction pictures (drizzle/0034)', () => {
  it('pictures come with the listing, the card uses the small copy, and they show only while the listing does', async () => {
    const seller = await createUser('pic-seller', ['creator']);
    const visitor = await createUser('pic-visitor', ['buyer']);
    const [art, banner, artThumb] = [await upload(seller, 'art.png'), await upload(seller, 'banner.png'), await upload(seller, 'thumb-art.png')];

    const created = await command(seller, listing({ image_ids: `${art},${banner}`, thumb_ids: `${artThumb},` }));
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = String(created.body.id);
    expect((await sql`select asset_id,thumb_asset_id,position from app.item_listing_images where listing_id=${id} order by position`).map((row) => [row.asset_id, row.thumb_asset_id, row.position]))
      .toEqual([[art, artThumb, 0], [banner, null, 1]]);

    // Waiting for collateral: only the seller sees the pictures.
    expect(await picture(seller, art)).toBe(302);
    expect(await picture(visitor, art)).toBe(404);
    expect(await picture(null, artThumb)).toBe(404);
    await command(seller, { command: 'post_item_collateral', idempotency_key: key('col'), listing_id: id });
    expect(await picture(null, art)).toBe(302);
    expect(await picture(visitor, artThumb)).toBe(302);

    const card = (await queries.getItemAuctionBoard({})).live.find((entry) => entry.id === id);
    expect(card?.coverId).toBe(artThumb);
    const detail = await queries.getItemListing(id, null);
    expect(detail!.images).toEqual([{ id: art, thumbId: artThumb }, { id: banner, thumbId: null }]);

    // A picture still shown, or its copy, cannot be deleted.
    await expect(sql`update app.storage_assets set lifecycle_state='DELETED',deleted_at=now() where id=${artThumb}`).rejects.toThrow(/referenced storage assets cannot be deleted/);

    // The seller replaces the pictures; the cover follows.
    const replaced = await command(seller, { command: 'set_item_images', idempotency_key: key('img'), listing_id: id, image_ids: banner, thumb_ids: '' });
    expect(replaced.body.message).toBe('Pictures updated.');
    expect((await queries.getItemAuctionBoard({})).live.find((entry) => entry.id === id)?.coverId).toBe(banner);
    expect(await picture(null, art)).toBe(404);
    expect((await command(seller, { command: 'set_item_images', idempotency_key: key('img'), listing_id: id, clear: 'true' })).body.message).toBe('Pictures removed.');
    expect((await queries.getItemAuctionBoard({})).live.find((entry) => entry.id === id)?.coverId).toBeNull();
  });

  it('only the seller’s own finished pictures, at most six, and not after the listing closes', async () => {
    const seller = await createUser('pic-owner', ['creator']);
    const other = await createUser('pic-other', ['buyer']);
    const mine = await upload(seller);
    const theirs = await upload(other);
    const id = String((await command(seller, listing({}))).body.id);

    expect((await command(seller, { command: 'set_item_images', idempotency_key: key('img'), listing_id: id, image_ids: theirs })).body.error).toBe('Upload the pictures first');
    expect((await command(other, { command: 'set_item_images', idempotency_key: key('img'), listing_id: id, image_ids: theirs })).status).toBe(404);
    const seven = Array.from({ length: 7 }, () => randomUUID()).join(',');
    expect((await command(seller, { command: 'set_item_images', idempotency_key: key('img'), listing_id: id, image_ids: seven })).body.error).toBe('A listing can show at most 6 pictures');
    expect((await command(seller, { command: 'set_item_images', idempotency_key: key('img'), listing_id: id, image_ids: `${mine},${mine}` })).body.error).toBe('The same picture was added twice');
    expect((await command(seller, { command: 'set_item_images', idempotency_key: key('img'), listing_id: id })).body.error).toBe('Upload at least one picture, or remove the current pictures');
    // Another account cannot even attach someone else's picture while creating a listing.
    expect((await command(seller, listing({ image_ids: theirs }))).body.error).toBe('Upload the pictures first');

    await command(seller, { command: 'cancel_item_listing', idempotency_key: key('cx'), listing_id: id });
    expect((await command(seller, { command: 'set_item_images', idempotency_key: key('img'), listing_id: id, image_ids: mine })).body.error).toBe('Pictures cannot change after the listing closes');
    // Item pictures belong to marketplace accounts only.
    const operator = await createUser('pic-operator', []);
    const refused = await callRoute(intents.POST, '/api/assets/upload-intents', operator, { purpose: 'ITEM_IMAGE', filename: 'x.png', mime: 'image/png', size: '10' });
    expect(refused.status).toBe(403);
  });

  it('quarantining a picture takes its card copy out of view too', async () => {
    const seller = await createUser('pic-quarantine', ['creator']);
    const moderator = await createUser('pic-moderator', []);
    await sql`insert into app.user_roles (user_id,role,granted_reason) values (${moderator.id},'moderator','Item picture suite operator grant')`;
    const [art, thumb] = [await upload(seller), await upload(seller, 'thumb.png')];
    const id = String((await command(seller, listing({ image_ids: art, thumb_ids: thumb }))).body.id);
    await command(seller, { command: 'post_item_collateral', idempotency_key: key('col'), listing_id: id });
    expect(await picture(null, thumb)).toBe(302);

    const quarantined = await command(moderator, { command: 'admin_quarantine_asset', idempotency_key: key('q'), asset_id: art, reason: 'Picture shows another project’s artwork.' });
    expect(quarantined.status, JSON.stringify(quarantined.body)).toBe(200);
    expect((await sql`select lifecycle_state from app.storage_assets where id in (${art},${thumb}) order by id`).map((row) => row.lifecycle_state)).toEqual(['QUARANTINED', 'QUARANTINED']);
    expect(await picture(null, art)).toBe(404);
    expect(await picture(null, thumb)).toBe(404);
    expect((await queries.getItemAuctionBoard({})).live.find((entry) => entry.id === id)?.coverId).toBeNull();
    expect((await queries.getItemListing(id, null))!.images).toEqual([]);
  });
});
