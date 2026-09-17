import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORIGIN, RUN_DB, callRoute, commandInstant, key, runId, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const auth = await import('@/app/api/auth/route');
const intents = await import('@/app/api/assets/upload-intents/route');
const finalizeRoute = await import('@/app/api/assets/[id]/finalize/route');
const devUpload = await import('@/app/api/dev/storage/upload/[token]/route');
const storage = await import('@/modules/storage/provider');
const { getPublicData, getRequestData, getGoalPageData, getDashboardData } = await import('@/lib/read-model');
const { sql } = await import('@/lib/db');
const { createSession } = await import('@/lib/auth');

const SECRET = 'campaign_identity_signing_secret';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('IHDR fixture pixels for the campaign identity suite')]);
const PASSWORD = 'correct horse battery staple 9';
let root = '';

const command = (actor: TestUser, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

async function buyerAccount(): Promise<TestUser> {
  const email = `it-${runId}-identity-${randomUUID().slice(0, 6)}@example.test`;
  expect((await callRoute(auth.POST, '/api/auth', null, { action: 'signup', email, password: PASSWORD, role: 'buyer' })).status).toBe(200);
  const [user] = await sql<{ id: string }[]>`select id from app.users where email=${email}`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}

/** The project logo a buyer uploads during setup. */
async function logo(actor: TestUser): Promise<string> {
  const intent = await callRoute(intents.POST, '/api/assets/upload-intents', actor, { purpose: 'AVATAR', filename: 'logo.png', mime: 'image/png', size: String(PNG.byteLength) });
  expect(intent.status, JSON.stringify(intent.body)).toBe(200);
  const { url } = intent.body.upload as { url: string };
  expect((await devUpload.PUT(new Request(`${ORIGIN}${url}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Blob([PNG.slice()]) }), params({ token: url.split('/').pop()! }))).status).toBe(200);
  const id = String(intent.body.id);
  expect((await callRoute((request) => finalizeRoute.POST(request, params({ id })), `/api/assets/${id}/finalize`, actor, {})).status).toBe(200);
  return id;
}

const postCampaign = (buyer: TestUser, goal?: string) => command(buyer, {
  command: 'create_request', idempotency_key: key('req'), title: `Testnet launch thread ${randomUUID().slice(0, 6)}`,
  brief: 'We need a launch thread and two follow-up posts for our public testnet.', taxonomy: 'CREATE',
  budget: '500', per_creator_cap: '300', target_hires: '1', ...(goal ? { campaign_goal: goal } : {}),
  deadline: commandInstant(new Date(Date.now() + 7 * 24 * 3600 * 1000)),
});

beforeAll(async () => { if (RUN_DB) root = await mkdtemp(join(tmpdir(), 'cm-identity-it-')); });
beforeEach(() => { if (RUN_DB) storage.setStorageProviderForTests(new storage.LocalStorageProvider({ root, secret: SECRET })); });
afterAll(async () => {
  if (!RUN_DB) return;
  storage.setStorageProviderForTests(undefined);
  await rm(root, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('a campaign carries the project that is running it', () => {
  it('gives every campaign read the project name and the logo saved at setup', async () => {
    const buyer = await buyerAccount();
    const assetId = await logo(buyer);
    expect((await command(buyer, {
      command: 'complete_onboarding', idempotency_key: key('onboard'), display_name: 'Restake Labs', headline: 'Restaking for rollups',
      bio: 'We are building a restaking protocol and open our public testnet in October.', asset_ids: assetId,
    })).status).toBe(200);
    const created = await postCampaign(buyer, 'TESTNET');
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const requestId = String(created.body.id);

    // The open-campaign board.
    const board = (await getPublicData()).requests.find((row) => String(row.id) === requestId);
    expect(board, 'a new open campaign is on the board').toBeTruthy();
    expect(String(board!.buyer_name)).toBe('Restake Labs');
    expect(String(board!.buyer_avatar_asset_id)).toBe(assetId);

    // The campaign's own page.
    const detail = await getRequestData(null, requestId);
    expect(String(detail!.request.buyer_name)).toBe('Restake Labs');
    expect(String(detail!.request.buyer_avatar_asset_id)).toBe(assetId);

    // The goal tab that lists it.
    const goalTab = (await getGoalPageData('TESTNET', 'CREATE')).requests.find((row) => String(row.id) === requestId);
    expect(String(goalTab!.buyer_avatar_asset_id)).toBe(assetId);

    // The buyer's own list of campaigns.
    const mine = (await getDashboardData({ id: buyer.id, email: buyer.email, roles: ['buyer'] } as never)).requests
      .find((row: Record<string, unknown>) => String(row.id) === requestId);
    expect(String(mine!.buyer_avatar_asset_id)).toBe(assetId);
  });

  it('leaves the logo null, and the name intact, for a project that has not uploaded one', async () => {
    const buyer = await buyerAccount();
    await sql`update app.users set display_name='Plain Project', onboarded_at=now() where id=${buyer.id}`;
    const created = await postCampaign(buyer);
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const board = (await getPublicData()).requests.find((row) => String(row.id) === String(created.body.id));
    expect(String(board!.buyer_name)).toBe('Plain Project');
    expect(board!.buyer_avatar_asset_id).toBeNull();
  });
});
