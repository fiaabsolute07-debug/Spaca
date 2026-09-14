import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Actor } from '@/lib/auth';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const chain = await import('@/modules/crypto/chain');
const deposits = await import('@/modules/crypto/deposits');
const wallets = await import('@/modules/crypto/wallets');
const authorization = await import('@/modules/crypto/authorization');
const pools = await import('@/modules/pools/service');
const { NATIVE_TOKEN } = await import('@/modules/crypto/abi');
const { sql } = await import('@/lib/db');
const { createSession } = await import('@/lib/auth');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const asActor = (user: TestUser): Actor => ({ id: user.id, email: user.email, display_name: 'x', roles: ['buyer', 'creator'], is_test: true, status: 'ACTIVE', timezone: 'UTC' });
const reason = 'Pool integration suite toggles reward flags.';
const USDC = 10n ** 18n;
const RWD = 10n ** 18n;

const CHAIN = 9_500_000 + Math.floor(Math.random() * 400_000);
const SETTLEMENT = '0x5e7713e0000000000000000000000000000000bb' as Hex;
const RWD_TOKEN = '0x0000000000000000000000000000000000a0a0a1' as Hex;
const BONUS_TOKEN = '0x0000000000000000000000000000000000b0b0b1' as Hex;
const NFT_CONTRACT = '0x00000000000000000000000000000000000f7f7f' as Hex;
let dev: InstanceType<typeof chain.LocalDevChain>;
let admin: TestUser;
const assets: { usdc: string; rwd: string; bonus: string } = { usdc: '', rwd: '', bonus: '' };

async function operator(): Promise<TestUser> {
  const email = `it-pool-admin-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'IT admin',${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},'admin','Pool suite operator grant')`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}
const setFlag = (flag: string, enabled: boolean) => command(admin, { command: 'admin_set_flag', idempotency_key: key('flag'), key: flag, enabled: String(enabled), reason });

async function linkWallet(user: TestUser): Promise<Hex> {
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await wallets.createWalletChallenge(asActor(user), { chainId: CHAIN, address: account.address, domain: 'localhost:3000', uri: 'http://localhost:3000' });
  await wallets.verifyWalletChallenge(asActor(user), { challengeId: challenge.challenge_id, signature: await account.signMessage({ message: challenge.message }), domain: 'localhost:3000' });
  return account.address.toLowerCase() as Hex;
}

type Creator = TestUser & { poolId: string; wallet: Hex };
async function creator(label: string, withWallet = true): Promise<Creator> {
  const user = await createUser(label);
  const { poolId } = await createPublishedService(command, user, { capacity: 5 });
  return { ...user, poolId, wallet: withWallet ? await linkWallet(user) : ('0x' as Hex) };
}

const cash = (amount: string, extra: Record<string, unknown> = {}) => ({ key: 'cash', kind: 'CASH', required: true, asset_id: assets.usdc, amount, ...extra });
const token = (amount: string, extra: Record<string, unknown> = {}) => ({ key: 'rwd', kind: 'TOKEN', required: true, asset_id: assets.rwd, amount, ...extra });

async function pooledRequest(buyer: TestUser, items: unknown[], hires = 2) {
  const created = await command(buyer, { command: 'create_request', idempotency_key: key('req'), title: 'Pool campaign', brief: 'Launch posts rewarded from a funded campaign pool with tokens.',
    taxonomy: 'CREATE', budget: '1000', target_hires: String(hires), deadline: commandInstant(new Date(Date.now() + 14 * 86_400_000)) });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const requestId = String(created.body.id);
  const pool = await command(buyer, { command: 'create_campaign_pool', idempotency_key: key('pool'), request_id: requestId, chain_id: String(CHAIN), items: JSON.stringify(items) });
  expect(pool.status, JSON.stringify(pool.body)).toBe(200);
  return { requestId, poolId: String(pool.body.id) };
}

async function fund(buyer: TestUser, poolId: string, assetId: string, amount: string, tokenAddress: Hex) {
  const created = await command(buyer, { command: 'create_pool_funding', idempotency_key: key('fund'), pool_id: poolId, asset_id: assetId, amount });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const [intent] = await sql`select * from app.pool_funding_intents where id=${String(created.body.id)}`;
  const txHash = dev.submitDeposit({ emitter: SETTLEMENT, reference: intent!.reference as Hex, payer: '0x00000000000000000000000000000000000000f2', token: tokenAddress, amount: BigInt(String(intent!.amount_atomic)) });
  dev.mine(3);
  const [result] = await deposits.verifyChainTransaction(CHAIN, txHash);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'CREDITED' });
  return result!;
}

async function offerTo(buyer: TestUser, requestId: string, maker: Creator, quote: string) {
  const applied = await command(maker, { command: 'apply', idempotency_key: key('apply'), request_id: requestId, quote, turnaround_hours: '48', note: 'Creator application for a pool funded campaign.' });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  const [application] = await sql`select id,version from app.applications where request_id=${requestId} and creator_id=${maker.id}`;
  const offer = await command(buyer, { command: 'select_application', idempotency_key: key('sel'), application_id: String(application!.id), application_version: String(application!.version) });
  expect(offer.status, JSON.stringify(offer.body)).toBe(200);
  return String(offer.body.id);
}
const accept = (maker: Creator, offerId: string) => command(maker, { command: 'accept_offer', idempotency_key: key('acc'), offer_id: offerId, pool_id: maker.poolId });

async function deliverAndApprove(buyer: TestUser, maker: Creator, orderId: string) {
  expect((await command(maker, { command: 'start', idempotency_key: key('s'), order_id: orderId })).status).toBe(200);
  expect((await command(maker, { command: 'deliver', idempotency_key: key('d'), order_id: orderId, body: 'Delivered posts with every agreed item included.' })).status).toBe(200);
  expect((await command(buyer, { command: 'approve', idempotency_key: key('a'), order_id: orderId, delivery_version: '1' })).status).toBe(200);
}
const poolAssets = async (poolId: string) => Object.fromEntries((await sql`select pa.*,a.symbol from app.pool_assets pa join app.chain_assets a on a.id=pa.asset_id where pa.pool_id=${poolId}`)
  .map((row) => [String(row.symbol), row]));
const conserved = (row: Record<string, unknown>) => BigInt(String(row.confirmed_deposit)) === ['unallocated', 'allocated_active', 'pending_outflow', 'released', 'refunded'].reduce((sum, c) => sum + BigInt(String(row[c])), 0n);

beforeAll(async () => {
  if (!RUN_DB) return;
  await sql`insert into app.chain_networks (chain_id,name,mode,settlement_address,finality_confirmations,enabled) values (${CHAIN},${`IT pool devnet ${CHAIN}`},'LOCAL',${SETTLEMENT},3,true)`;
  const [usdc] = await sql`insert into app.chain_assets (chain_id,symbol,kind,decimals,balance_key,usd_pegged,transfer_behavior,allowlisted) values (${CHAIN},'USDC','NATIVE',18,'USDC',true,'STANDARD',true) returning id`;
  const [rwd] = await sql`insert into app.chain_assets (chain_id,symbol,kind,contract_address,decimals,balance_key,transfer_behavior,allowlisted) values (${CHAIN},'RWD','ERC20',${RWD_TOKEN},18,'RWD','STANDARD',true) returning id`;
  const [bonus] = await sql`insert into app.chain_assets (chain_id,symbol,kind,contract_address,decimals,balance_key,transfer_behavior,allowlisted) values (${CHAIN},'BONUS','ERC20',${BONUS_TOKEN},18,'BONUS','STANDARD',true) returning id`;
  assets.usdc = String(usdc!.id);
  assets.rwd = String(rwd!.id);
  assets.bonus = String(bonus!.id);
  admin = await operator();
});
beforeEach(async () => {
  if (!RUN_DB) return;
  funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_pools_suite_secret_001'] }));
  dev = new chain.LocalDevChain(CHAIN, SETTLEMENT);
  chain.setChainReaderForTests(CHAIN, dev);
  await sql`update app.chain_networks set enabled=true where chain_id=${CHAIN}`;
  for (const flag of ['CRYPTO_CHECKOUT_ENABLED', 'TOKEN_REWARDS_ENABLED', 'NFT_REWARDS_ENABLED']) expect((await setFlag(flag, true)).status).toBe(200);
});
afterAll(async () => {
  if (!RUN_DB) return;
  for (const flag of ['CRYPTO_CHECKOUT_ENABLED', 'TOKEN_REWARDS_ENABLED', 'NFT_REWARDS_ENABLED']) await setFlag(flag, false);
  await sql`update app.chain_networks set enabled=false where chain_id=${CHAIN}`;
  chain.setChainReaderForTests(CHAIN, undefined);
  funding.setMockPaymentProviderForTests(undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('CRY-06/07 — funding every required asset and conserving each balance', () => {
  it('CRY-06: a pool missing one required asset is not fully funded and hires cannot allocate', async () => {
    const buyer = await createUser('cry06-buyer');
    await linkWallet(buyer);
    const maker = await creator('cry06-creator');
    const { requestId, poolId } = await pooledRequest(buyer, [cash('100'), token('50')]);
    expect(await sql`select status from app.campaign_pools where id=${poolId}`.then((r) => r[0]!.status)).toBe('FUNDING');
    await fund(buyer, poolId, assets.usdc, '200', NATIVE_TOKEN as Hex);
    const partial = await pools.getPoolData(asActor(buyer), requestId);
    expect(partial!.pool).toMatchObject({ status: 'FUNDING', fully_funded: false, missing_required: [expect.objectContaining({ symbol: 'RWD', missing: '100.00' })] });
    const applicantView = await pools.getPoolData(asActor(maker), requestId);
    expect(applicantView).not.toHaveProperty('assets');

    const offerId = await offerTo(buyer, requestId, maker, '100');
    const refused = await accept(maker, offerId);
    expect(refused.status).toBe(422);
    expect(String(refused.body.error)).toMatch(/RWD/);
    expect((await sql`select count(*)::int as n from app.orders where source='REQUEST' and source_ref=${requestId}`)[0]!.n).toBe(0);
    expect((await sql`select status from app.hire_offers where id=${offerId}`)[0]!.status).toBe('OFFERED');

    await fund(buyer, poolId, assets.rwd, '100', RWD_TOKEN);
    expect(await sql`select status from app.campaign_pools where id=${poolId}`.then((r) => r[0]!.status)).toBe('ACTIVE');
    const accepted = await accept(maker, offerId);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const orderId = String(accepted.body.id);
    expect((await sql`select status,payment_status,payment_rail,amount_minor from app.orders where id=${orderId}`)[0]).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED', payment_rail: 'POOL', amount_minor: '10000' });
    expect((await sql`select state from app.reservations where order_id=${orderId}`)[0]!.state).toBe('COMMITTED');
    const balances = await poolAssets(poolId);
    expect(balances.USDC).toMatchObject({ confirmed_deposit: (200n * USDC).toString(), unallocated: (100n * USDC).toString(), allocated_active: (100n * USDC).toString() });
    expect(balances.RWD).toMatchObject({ unallocated: (50n * RWD).toString(), allocated_active: (50n * RWD).toString() });
    expect(Object.values(balances).every(conserved)).toBe(true);
    expect((await sql`select committed_hires from app.requests where id=${requestId}`)[0]!.committed_hires).toBe(1);
  });

  it('CRY-07: two hires racing for the last balance allocate once; the database refuses any non-conserving write', async () => {
    const buyer = await createUser('cry07-buyer');
    const [a, b] = await Promise.all([creator('cry07-a'), creator('cry07-b')]);
    const { requestId, poolId } = await pooledRequest(buyer, [cash('100')], 2);
    await fund(buyer, poolId, assets.usdc, '100', NATIVE_TOKEN as Hex);
    const offers = [await offerTo(buyer, requestId, a, '100'), await offerTo(buyer, requestId, b, '100')];
    const results = await Promise.all([accept(a, offers[0]!), accept(b, offers[1]!)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const balances = await poolAssets(poolId);
    expect(balances.USDC).toMatchObject({ unallocated: '0', allocated_active: (100n * USDC).toString() });
    expect((await sql`select count(*)::int as n from app.pool_allocations where pool_id=${poolId}`)[0]!.n).toBe(1);
    const poolAssetId = String(balances.USDC!.id);
    await expect(sql`update app.pool_assets set unallocated=unallocated + 1 where id=${poolAssetId}`).rejects.toThrow(/pool_assets_conservation/);
    await expect(sql`update app.pool_assets set unallocated=unallocated - 1, allocated_active=allocated_active + 1 where id=${poolAssetId}`).rejects.toThrow(/pool_assets_nonnegative/);
    await expect(sql`update app.pool_assets set confirmed_deposit=confirmed_deposit - 1, allocated_active=allocated_active - 1 where id=${poolAssetId}`).rejects.toThrow(/cumulative/);
    await expect(sql`update app.pool_ledger set amount_atomic=1 where pool_asset_id=${poolAssetId}`).rejects.toThrow(/immutable/);
  });
});

describe.skipIf(!RUN_DB)('CRY-08/09/10 — settlement per asset, unused refunds and release authorization', () => {
  it('CRY-08: cash releases while a token payout fails; only the token retries, and the order completes once required rewards land', async () => {
    const buyer = await createUser('cry08-buyer');
    const maker = await creator('cry08-creator');
    const bonus = { key: 'bonus', kind: 'TOKEN', required: false, asset_id: assets.bonus, amount: '5' };
    const { requestId, poolId } = await pooledRequest(buyer, [cash('100'), token('50'), bonus], 1);
    await fund(buyer, poolId, assets.usdc, '100', NATIVE_TOKEN as Hex);
    await fund(buyer, poolId, assets.rwd, '50', RWD_TOKEN);
    await fund(buyer, poolId, assets.bonus, '5', BONUS_TOKEN);
    const orderId = String((await accept(maker, await offerTo(buyer, requestId, maker, '100'))).body.id);
    await deliverAndApprove(buyer, maker, orderId);

    dev.failTransfersOf(RWD_TOKEN);
    dev.failTransfersOf(BONUS_TOKEN);
    expect((await jobs.releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_RETRY_PARTIAL_TOKEN_TRANSFER_FAILED_TOKEN_TRANSFER_FAILED: 1 });
    const states = Object.fromEntries((await sql`select item_key,state,attempts,last_error from app.pool_allocations where order_id=${orderId}`).map((r) => [String(r.item_key), r]));
    expect(states.cash).toMatchObject({ state: 'RELEASED', attempts: 1 });
    expect(states.rwd).toMatchObject({ state: 'ACTIVE', attempts: 1, last_error: 'TOKEN_TRANSFER_FAILED' });
    expect((await sql`select status,settlement_status from app.orders where id=${orderId}`)[0]).toMatchObject({ status: 'APPROVED', settlement_status: 'PENDING' });
    expect(dev.transfers.map((t) => t.token)).toEqual([NATIVE_TOKEN]);
    expect((await sql`select count(*)::int as n from app.reconciliation_cases where order_id=${orderId} and kind='POOL_PAYOUT_PARTIAL'`)[0]!.n).toBe(1);

    dev.failTransfersOf(RWD_TOKEN, false);
    expect((await jobs.releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_REQUESTED: 1 });
    expect(dev.transfers.map((t) => t.token)).toEqual([NATIVE_TOKEN, RWD_TOKEN]);
    expect((await sql`select status,settlement_status from app.orders where id=${orderId}`)[0]).toMatchObject({ status: 'COMPLETED', settlement_status: 'RELEASED' });
    expect((await sql`select state,last_error from app.pool_allocations where order_id=${orderId} and item_key='bonus'`)[0]).toMatchObject({ state: 'ACTIVE', last_error: 'TOKEN_TRANSFER_FAILED' });
    const balances = await poolAssets(poolId);
    expect(balances.USDC).toMatchObject({ released: (100n * USDC).toString(), pending_outflow: '0', allocated_active: '0' });
    expect(balances.RWD).toMatchObject({ released: (50n * RWD).toString(), pending_outflow: '0' });
    expect(balances.BONUS).toMatchObject({ allocated_active: (5n * RWD).toString(), released: '0' });
    expect(Object.values(balances).every(conserved)).toBe(true);
    const ledger = await sql`select sum(e.amount_minor)::text as total from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId}`;
    expect(ledger[0]!.total).toBe('0');
    expect(dev.transfers.every((t) => t.recipient.toLowerCase() === maker.wallet)).toBe(true);
  });

  it('CRY-09: refunds only unallocated confirmed balance and never touches allocated funds', async () => {
    const buyer = await createUser('cry09-buyer');
    const maker = await creator('cry09-creator');
    const { requestId, poolId } = await pooledRequest(buyer, [cash('100')], 3);
    await fund(buyer, poolId, assets.usdc, '300', NATIVE_TOKEN as Hex);
    await accept(maker, await offerTo(buyer, requestId, maker, '100'));
    expect((await command(buyer, { command: 'refund_pool_unused', idempotency_key: key('r'), pool_id: poolId, asset_id: assets.usdc })).status).toBe(422);
    const buyerWallet = await linkWallet(buyer);
    const tooMuch = await command(buyer, { command: 'refund_pool_unused', idempotency_key: key('r'), pool_id: poolId, asset_id: assets.usdc, amount: '250' });
    expect(tooMuch.status).toBe(422);
    expect(String(tooMuch.body.error)).toMatch(/200\.00 USDC/);
    expect((await command(maker, { command: 'refund_pool_unused', idempotency_key: key('r'), pool_id: poolId, asset_id: assets.usdc })).status).toBe(404);
    const refunded = await command(buyer, { command: 'refund_pool_unused', idempotency_key: key('r'), pool_id: poolId, asset_id: assets.usdc });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(200);
    const balances = await poolAssets(poolId);
    expect(balances.USDC).toMatchObject({ confirmed_deposit: (300n * USDC).toString(), unallocated: '0', allocated_active: (100n * USDC).toString(), refunded: (200n * USDC).toString() });
    expect(conserved(balances.USDC!)).toBe(true);
    expect(dev.transfers).toEqual([expect.objectContaining({ recipient: buyerWallet, amount: 200n * USDC })]);
    expect((await command(buyer, { command: 'close_campaign_pool', idempotency_key: key('c'), pool_id: poolId })).status).toBe(409);
  });

  it('CRY-10: release authorizations bind chain, contract, payout, recipient and amount, and cannot be replayed', async () => {
    const domain = authorization.releaseDomain(CHAIN, SETTLEMENT);
    const message = { payoutRef: authorization.bytes32Of(`ALLOCATION:${randomUUID()}`), orderRef: authorization.bytes32Of('order'), recipient: '0x00000000000000000000000000000000000000c1' as Hex,
      token: NATIVE_TOKEN as Hex, amount: 7n * USDC, nonce: authorization.newNonce(), expiry: BigInt(Math.floor(Date.now() / 1000) + 600) };
    const signed = await authorization.signRelease(domain, message);
    const rejection = (promise: Promise<unknown>) => promise.then(() => 'OK', (error: { code?: string }) => error.code);
    expect(await rejection(dev.executeRelease({ ...signed, message: { ...message, amount: 8n * USDC } }))).toBe('BAD_SIGNATURE');
    expect(await rejection(dev.executeRelease({ ...signed, message: { ...message, recipient: '0x00000000000000000000000000000000000000c2' } }))).toBe('BAD_SIGNATURE');
    expect(await rejection(dev.executeRelease({ ...signed, domain: { ...domain, chainId: CHAIN + 1 } }))).toBe('WRONG_CHAIN');
    expect(await rejection(dev.executeRelease({ ...signed, domain: { ...domain, verifyingContract: '0x00000000000000000000000000000000000000dd' } }))).toBe('WRONG_CONTRACT');
    const expired = await authorization.signRelease(domain, { ...message, nonce: authorization.newNonce(), expiry: BigInt(Math.floor(Date.now() / 1000) - 1) });
    expect(await rejection(dev.executeRelease(expired))).toBe('EXPIRED');
    expect(await rejection(dev.executeRelease(signed))).toBe('OK');
    expect(await rejection(dev.executeRelease(signed))).toBe('NONCE_USED');
    const fresh = await authorization.signRelease(domain, { ...message, nonce: authorization.newNonce() });
    expect(String(await rejection(dev.executeRelease(fresh)))).toMatch(/^ALREADY_RELEASED:0x/);
    const forger = privateKeyToAccount(generatePrivateKey());
    const forged = await forger.signTypedData({ domain, types: authorization.RELEASE_TYPES, primaryType: 'Release', message: { ...message, nonce: authorization.newNonce(), payoutRef: authorization.bytes32Of('forged') } });
    expect(await rejection(dev.executeRelease({ domain, message: { ...message, nonce: authorization.newNonce(), payoutRef: authorization.bytes32Of('forged') }, signature: forged }))).toBe('BAD_SIGNATURE');
    expect(dev.transfers.length).toBe(1);
  });
});

describe.skipIf(!RUN_DB)('CRY-12 and lifecycle — entitlements, cancellation and template versions', () => {
  it('CRY-12: perks and NFTs become unique entitlements fulfilled with proof and claimed once, with no USD value', async () => {
    const buyer = await createUser('cry12-buyer');
    const [a, b] = await Promise.all([creator('cry12-a'), creator('cry12-b')]);
    const perk = { key: 'wl', kind: 'PERK', required: true, perk_type: 'WHITELIST', description: 'Allowlist spot for the beta launch', fulfillment_method: 'Add wallet to allowlist', deadline_days: 14 };
    const nft = { key: 'badge', kind: 'PERK', required: false, perk_type: 'NFT', description: 'Launch contributor badge NFT', fulfillment_method: 'Transfer badge to creator wallet', deadline_days: 30 };
    await setFlag('NFT_REWARDS_ENABLED', false);
    const blocked = await command(buyer, { command: 'create_request', idempotency_key: key('req'), title: 'NFT blocked', brief: 'This request tries an NFT reward while NFTs are disabled.', taxonomy: 'CREATE', budget: '500', target_hires: '1', deadline: commandInstant(new Date(Date.now() + 7 * 86_400_000)) });
    expect((await command(buyer, { command: 'create_campaign_pool', idempotency_key: key('p'), request_id: String(blocked.body.id), chain_id: String(CHAIN), items: JSON.stringify([cash('100'), nft]) })).status).toBe(422);
    await setFlag('NFT_REWARDS_ENABLED', true);

    const { requestId, poolId } = await pooledRequest(buyer, [cash('100'), perk, nft], 2);
    await fund(buyer, poolId, assets.usdc, '200', NATIVE_TOKEN as Hex);
    const orderA = String((await accept(a, await offerTo(buyer, requestId, a, '100'))).body.id);
    const orderB = String((await accept(b, await offerTo(buyer, requestId, b, '100'))).body.id);
    const entitlementsA = Object.fromEntries((await sql`select * from app.reward_entitlements where order_id=${orderA}`).map((row) => [String(row.item_key), row]));
    expect(Object.keys(entitlementsA).sort()).toEqual(['badge', 'wl']);
    expect(entitlementsA.wl).toMatchObject({ kind: 'PERK', required: true, status: 'PENDING' });
    expect(entitlementsA.badge).toMatchObject({ kind: 'NFT', required: false });
    expect(Object.keys(entitlementsA.wl!).some((column) => /usd|price|value/i.test(column))).toBe(false);

    const wlId = String(entitlementsA.wl!.id);
    expect((await command(a, { command: 'claim_entitlement', idempotency_key: key('c'), entitlement_id: wlId })).status).toBe(409);
    expect((await command(a, { command: 'fulfill_entitlement', idempotency_key: key('f'), entitlement_id: wlId, proof: 'Added to the allowlist sheet.' })).status).toBe(404);
    expect((await command(buyer, { command: 'fulfill_entitlement', idempotency_key: key('f'), entitlement_id: wlId, proof: 'Added the creator wallet to the allowlist.' })).status).toBe(200);
    expect((await command(a, { command: 'claim_entitlement', idempotency_key: key('c'), entitlement_id: wlId })).status).toBe(200);
    expect((await command(a, { command: 'claim_entitlement', idempotency_key: key('c'), entitlement_id: wlId })).status).toBe(409);

    const badgeA = String(entitlementsA.badge!.id);
    const [badgeB] = await sql`select id from app.reward_entitlements where order_id=${orderB} and item_key='badge'`;
    dev.setNftOwner(NFT_CONTRACT, 42n, '0x0000000000000000000000000000000000000bad');
    const notOwned = await command(buyer, { command: 'fulfill_entitlement', idempotency_key: key('f'), entitlement_id: badgeA, proof: 'Badge transferred to the creator.', nft_contract: NFT_CONTRACT, nft_token_id: '42' });
    expect(notOwned.status).toBe(422);
    dev.setNftOwner(NFT_CONTRACT, 42n, a.wallet);
    expect((await command(buyer, { command: 'fulfill_entitlement', idempotency_key: key('f'), entitlement_id: badgeA, proof: 'Badge transferred to the creator.', nft_contract: NFT_CONTRACT, nft_token_id: '42' })).status).toBe(200);
    dev.setNftOwner(NFT_CONTRACT, 42n, b.wallet);
    const reused = await command(buyer, { command: 'fulfill_entitlement', idempotency_key: key('f'), entitlement_id: String(badgeB!.id), proof: 'Same badge moved to the second creator.', nft_contract: NFT_CONTRACT, nft_token_id: '42' });
    expect(reused.status).toBe(409);
  });

  it('a pool-funded hire cancelled before work returns its allocations, cancels perks and releases the request budget', async () => {
    const buyer = await createUser('pool-cancel-buyer');
    const maker = await creator('pool-cancel-creator');
    const perk = { key: 'role', kind: 'PERK', required: true, perk_type: 'COMMUNITY_ROLE', description: 'Contributor role in the community', fulfillment_method: 'Grant role in the forum', deadline_days: 7 };
    const { requestId, poolId } = await pooledRequest(buyer, [cash('100'), token('20'), perk], 1);
    await fund(buyer, poolId, assets.usdc, '100', NATIVE_TOKEN as Hex);
    await fund(buyer, poolId, assets.rwd, '20', RWD_TOKEN);
    const orderId = String((await accept(maker, await offerTo(buyer, requestId, maker, '100'))).body.id);
    expect((await sql`select committed_hires from app.requests where id=${requestId}`)[0]!.committed_hires).toBe(1);
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: orderId })).status).toBe(200);
    expect((await sql`select status,payment_status from app.orders where id=${orderId}`)[0]).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED' });
    expect((await sql`select state from app.pool_allocations where order_id=${orderId}`).map((r) => r.state)).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await sql`select status from app.reward_entitlements where order_id=${orderId}`)[0]!.status).toBe('CANCELLED');
    const balances = await poolAssets(poolId);
    expect(balances.USDC).toMatchObject({ unallocated: (100n * USDC).toString(), allocated_active: '0' });
    expect(balances.RWD).toMatchObject({ unallocated: (20n * RWD).toString(), allocated_active: '0' });
    expect((await sql`select committed_hires,reserved_hires from app.requests where id=${requestId}`)[0]).toMatchObject({ committed_hires: 0, reserved_hires: 0 });
    const ledger = await sql`select sum(e.amount_minor)::text as total from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId}`;
    expect(ledger[0]!.total).toBe('0');
  });

  it('a new template version applies only to future hires; stale quotes are refused', async () => {
    const buyer = await createUser('pool-version-buyer');
    const [first, second, late] = await Promise.all([creator('pv-first'), creator('pv-second'), creator('pv-late')]);
    const { requestId, poolId } = await pooledRequest(buyer, [cash('100')], 3);
    await fund(buyer, poolId, assets.usdc, '400', NATIVE_TOKEN as Hex);
    const firstOrder = String((await accept(first, await offerTo(buyer, requestId, first, '100'))).body.id);
    expect((await command(late, { command: 'apply', idempotency_key: key('apply'), request_id: requestId, quote: '90', turnaround_hours: '48', note: 'Quote that does not match the pool reward.' })).status).toBe(422);
    const staleApplication = await command(second, { command: 'apply', idempotency_key: key('apply'), request_id: requestId, quote: '100', turnaround_hours: '48', note: 'Applied at the first pool reward version.' });
    expect(staleApplication.status).toBe(200);

    const updated = await command(buyer, { command: 'update_pool_template', idempotency_key: key('t'), pool_id: poolId, items: JSON.stringify([cash('150')]) });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect((await sql`select template_version,amount_atomic from app.pool_allocations where order_id=${firstOrder}`)[0]).toMatchObject({ template_version: 1, amount_atomic: (100n * USDC).toString() });
    await expect(sql`update app.pool_templates set items='[]'::jsonb where pool_id=${poolId} and version=1`).rejects.toThrow(/immutable/);
    const [application] = await sql`select id,version from app.applications where request_id=${requestId} and creator_id=${second.id}`;
    const stale = await command(buyer, { command: 'select_application', idempotency_key: key('sel'), application_id: String(application!.id), application_version: String(application!.version) });
    expect(stale.status).toBe(409);
    const secondOrder = String((await accept(late, await offerTo(buyer, requestId, late, '150'))).body.id);
    expect((await sql`select template_version,amount_atomic from app.pool_allocations where order_id=${secondOrder}`)[0]).toMatchObject({ template_version: 2, amount_atomic: (150n * USDC).toString() });
    expect((await sql`select amount_minor from app.orders where id=${secondOrder}`)[0]!.amount_minor).toBe('15000');
    const noWallet = await creator('pv-nowallet', false);
    const refused = await accept(noWallet, await offerTo(buyer, requestId, noWallet, '150'));
    expect(refused.status).toBe(422);
    expect(String(refused.body.error)).toMatch(/verified wallet/);
  });
});
