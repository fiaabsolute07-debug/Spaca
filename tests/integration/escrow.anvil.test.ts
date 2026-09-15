/**
 * End-to-end escrow settlement on a real EVM (anvil) with the compiled SpacaEscrow contract. Opt-in:
 *   RUN_DB_INTEGRATION=1 RUN_ANVIL=1 vitest run tests/integration/escrow.anvil.test.ts   (after `forge build` in contracts/)
 * Keys are anvil's public development accounts; nothing here touches a public network.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Actor } from '@/lib/auth';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

const RUN = RUN_DB && process.env.RUN_ANVIL === '1';
const CHAIN_ID = 5_042_900 + Math.floor(Math.random() * 90);
const PORT = 18_545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil's well-known development keys (mnemonic "test test … junk"); public, local only.
const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  signer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  executor: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  buyer: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  creator: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const;
process.env.RELEASE_SIGNER_PRIVATE_KEY = KEYS.signer;
process.env[`CHAIN_RPC_URL_${CHAIN_ID}`] = RPC;
process.env[`CHAIN_EXECUTOR_KEY_${CHAIN_ID}`] = KEYS.executor;

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const deposits = await import('@/modules/crypto/deposits');
const wallets = await import('@/modules/crypto/wallets');
const { ERC20_ABI, ESCROW_ABI } = await import('@/modules/crypto/abi');
const { sql } = await import('@/lib/db');
const { createSession } = await import('@/lib/auth');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const asActor = (user: TestUser): Actor => ({ id: user.id, email: user.email, display_name: 'x', roles: ['buyer', 'creator'], is_test: true, status: 'ACTIVE', timezone: 'UTC' });
const artifact = (path: string) => JSON.parse(readFileSync(resolve('contracts/out', path), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };
const chain = { id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletOf = (pk: Hex) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(RPC) });

let anvil: ChildProcess | undefined;
let escrow: Hex;
let usdc: Hex;
let admin: TestUser;

async function deploy(pk: Hex, path: string, args: unknown[] = []): Promise<Hex> {
  const { abi, bytecode } = artifact(path);
  const hash = await walletOf(pk).deployContract({ abi: abi as never, bytecode: bytecode.object, args: args as never });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!.toLowerCase() as Hex;
}

async function write(pk: Hex, address: Hex, abi: unknown, functionName: string, args: unknown[]) {
  const hash = await walletOf(pk).writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  return hash;
}

const balance = (owner: Hex) => publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });

async function linkWallet(user: TestUser, pk: Hex) {
  const account = privateKeyToAccount(pk);
  const challenge = await wallets.createWalletChallenge(asActor(user), { chainId: CHAIN_ID, address: account.address, domain: 'localhost:3000', uri: 'http://localhost:3000' });
  await wallets.verifyWalletChallenge(asActor(user), { challengeId: challenge.challenge_id, signature: await account.signMessage({ message: challenge.message }), domain: 'localhost:3000' });
  return account.address.toLowerCase() as Hex;
}

/** Books a service, creates the crypto intent and funds the escrow from the buyer wallet on anvil; returns the order. */
async function fundedOrder(label: string) {
  const creator = await createUser(`${label}-creator`);
  const buyer = await createUser(`${label}-buyer`);
  const { serviceId } = await createPublishedService(command, creator, { capacity: 3, price: '650' });
  const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief: 'Escrow end-to-end brief with enough detail to start.', accept_terms: 'on' });
  expect(booked.status, JSON.stringify(booked.body)).toBe(200);
  const orderId = String(booked.body.id);
  const [asset] = await sql`select id from app.chain_assets where chain_id=${CHAIN_ID}`;
  const created = await command(buyer, { command: 'create_crypto_payment', idempotency_key: key('cp'), order_id: orderId, chain_id: String(CHAIN_ID), asset_id: String(asset!.id) });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const [intent] = await sql`select * from app.crypto_payment_intents where id=${String(created.body.id)}`;
  await write(KEYS.buyer, usdc, ERC20_ABI, 'approve', [escrow, BigInt(String(intent!.amount_atomic))]);
  const fundTx = await write(KEYS.buyer, escrow, ESCROW_ABI, 'fund', [intent!.escrow_ref, intent!.reference, usdc, BigInt(String(intent!.amount_atomic))]);
  // The server trusts only what it reads back from the chain.
  const [result] = await deposits.verifyChainTransaction(CHAIN_ID, fundTx);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'CREDITED', funding: 'FUNDED' });
  return { creator, buyer, orderId, intent: intent!, amount: BigInt(String(intent!.amount_atomic)) };
}

beforeAll(async () => {
  if (!RUN) return;
  if (!existsSync(resolve('contracts/out/SpacaEscrow.sol/SpacaEscrow.json'))) throw new Error('Run `forge build` in contracts/ first');
  anvil = spawn(resolve(homedir(), '.foundry/bin/anvil'), ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await publicClient.getChainId()) === CHAIN_ID) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const owner = privateKeyToAccount(KEYS.owner).address;
  usdc = await deploy(KEYS.owner, 'Tokens.sol/MockUSDC.json');
  escrow = await deploy(KEYS.owner, 'SpacaEscrow.sol/SpacaEscrow.json', [owner, privateKeyToAccount(KEYS.signer).address, owner, 60n * 86_400n]);
  await write(KEYS.owner, escrow, [{ type: 'function', name: 'setTokenAllowed', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] }], 'setTokenAllowed', [usdc, true]);
  await write(KEYS.owner, usdc, [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }], 'mint', [privateKeyToAccount(KEYS.buyer).address, 10_000n * 10n ** 6n]);

  // The test database outlives a run: re-running the suite updates the anvil network and token instead of duplicating them.
  await sql`insert into app.chain_networks (chain_id,name,mode,settlement_address,finality_confirmations,enabled,verification_note) values (${CHAIN_ID},'IT anvil escrow','LOCAL',${escrow},1,true,'anvil with compiled SpacaEscrow')
    on conflict (chain_id) do update set name=excluded.name,mode=excluded.mode,settlement_address=excluded.settlement_address,finality_confirmations=excluded.finality_confirmations,enabled=true,verification_note=excluded.verification_note`;
  await sql`insert into app.chain_assets (chain_id,symbol,kind,contract_address,decimals,balance_key,usd_pegged,transfer_behavior,allowlisted) values (${CHAIN_ID},'USDC','ERC20',${usdc},6,'USDC',true,'STANDARD',true)
    on conflict (chain_id, kind, (coalesce(contract_address, ''))) do update set symbol=excluded.symbol,decimals=excluded.decimals,balance_key=excluded.balance_key,usd_pegged=true,transfer_behavior=excluded.transfer_behavior,allowlisted=true`;
  const email = `it-anvil-admin-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'IT admin',${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},'admin','Anvil suite operator grant')`;
  admin = { id: user!.id, email, token: await createSession(user!.id) };
  expect((await command(admin, { command: 'admin_set_flag', idempotency_key: key('flag'), key: 'CRYPTO_CHECKOUT_ENABLED', enabled: 'true', reason: 'Anvil escrow suite enables crypto checkout.' })).status).toBe(200);
  funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_anvil_suite_secret_001'] }));
}, 60_000);

afterAll(async () => {
  if (!RUN) return;
  await command(admin, { command: 'admin_set_flag', idempotency_key: key('flag'), key: 'CRYPTO_CHECKOUT_ENABLED', enabled: 'false', reason: 'Anvil escrow suite restores the flag.' });
  await sql`update app.chain_networks set enabled=false where chain_id=${CHAIN_ID}`;
  funding.setMockPaymentProviderForTests(undefined);
  anvil?.kill();
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN)('W9-ARC — SpacaEscrow on a real EVM', () => {
  it('fund → verify → approve → queued release → on-chain payout to the creator, never paid twice', async () => {
    const { creator, buyer, orderId, intent, amount } = await fundedOrder('anvil-release');
    expect(await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: 'available', args: [intent.escrow_ref as Hex] })).toBe(amount);
    for (const [actor, fields] of [[creator, { command: 'start' }], [creator, { command: 'deliver', body: 'Delivered launch copy with every agreed item.' }], [buyer, { command: 'approve', delivery_version: '1' }]] as const) {
      expect((await command(actor, { idempotency_key: key('step'), order_id: orderId, ...fields })).status).toBe(200);
    }
    const creatorWallet = await linkWallet(creator, KEYS.creator);
    const before = await balance(creatorWallet);
    expect((await jobs.releaseReadySettlements({ orderId })).outcomes).toEqual({ RELEASE_REQUESTED: 1 });
    expect(await balance(creatorWallet)).toBe(before);
    expect((await jobs.dispatchChainPayouts({ orderId })).outcomes).toEqual({ CONFIRMED: 1 });
    expect(await balance(creatorWallet)).toBe(before + amount);
    expect(await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: 'available', args: [intent.escrow_ref as Hex] })).toBe(0n);
    const [payout] = await sql`select id,state,tx_hash from app.chain_payouts where order_id=${orderId}`;
    expect(payout).toMatchObject({ state: 'CONFIRMED' });
    const receipt = await publicClient.getTransactionReceipt({ hash: payout!.tx_hash as Hex });
    expect(receipt.status).toBe('success');
    expect((await sql`select status,settlement_status from app.orders where id=${orderId}`)[0]).toMatchObject({ status: 'COMPLETED', settlement_status: 'RELEASED' });

    // Simulate a crash that lost the confirmation: the worker finds the on-chain payout and does not pay again.
    await sql`insert into app.chain_payouts (kind,subject_id,order_id,chain_id,escrow_ref,payout_ref,recipient,token,amount_atomic,state)
      select kind,subject_id,order_id,chain_id,escrow_ref,'0x' || encode(sha256(convert_to(payout_ref || ':copy', 'UTF8')), 'hex'),recipient,token,amount_atomic,'UNKNOWN'
      from app.chain_payouts where id=${String(payout!.id)}`;
    const duplicate = await jobs.dispatchChainPayouts({ orderId });
    expect(duplicate.outcomes).toEqual({ FAILED: 1 });
    expect((await sql`select last_error from app.chain_payouts where order_id=${orderId} and state='FAILED'`)[0]!.last_error).toBe('InsufficientBucketBalance');
    expect(await balance(creatorWallet)).toBe(before + amount);
  }, 60_000);

  it('cancellation refunds the paying wallet on chain; a paused escrow keeps the refund waiting until unpaused', async () => {
    const { buyer, orderId, amount } = await fundedOrder('anvil-refund');
    const buyerAddress = privateKeyToAccount(KEYS.buyer).address;
    const before = await balance(buyerAddress);
    const pause = [{ type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [] }, { type: 'function', name: 'unpause', stateMutability: 'nonpayable', inputs: [], outputs: [] }];
    await write(KEYS.owner, escrow, pause, 'pause', []);
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: orderId })).status).toBe(200);
    expect((await jobs.dispatchChainPayouts({ orderId })).outcomes).toEqual({ RETRY: 1 });
    expect((await sql`select state,last_error from app.chain_payouts where order_id=${orderId}`)[0]).toMatchObject({ state: 'RETRY', last_error: 'EnforcedPause' });
    expect(await balance(buyerAddress)).toBe(before);

    await write(KEYS.owner, escrow, pause, 'unpause', []);
    await sql`update app.chain_payouts set next_attempt_at=now() where order_id=${orderId}`;
    expect((await jobs.dispatchChainPayouts({ orderId })).outcomes).toEqual({ CONFIRMED: 1 });
    expect(await balance(buyerAddress)).toBe(before + amount);
    expect((await sql`select status,payment_status from app.orders where id=${orderId}`)[0]).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED' });
  }, 60_000);

  it('a deposit into the wrong escrow bucket is rejected and never credits the order', async () => {
    const creator = await createUser('anvil-wrong-creator');
    const buyer = await createUser('anvil-wrong-buyer');
    const { serviceId } = await createPublishedService(command, creator, { capacity: 3, price: '10' });
    const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief: 'Escrow wrong bucket brief with enough detail.' });
    const orderId = String(booked.body.id);
    const [asset] = await sql`select id from app.chain_assets where chain_id=${CHAIN_ID}`;
    const created = await command(buyer, { command: 'create_crypto_payment', idempotency_key: key('cp'), order_id: orderId, chain_id: String(CHAIN_ID), asset_id: String(asset!.id) });
    const [intent] = await sql`select * from app.crypto_payment_intents where id=${String(created.body.id)}`;
    await write(KEYS.buyer, usdc, ERC20_ABI, 'approve', [escrow, BigInt(String(intent!.amount_atomic))]);
    const wrongBucket = `0x${'ab'.repeat(32)}` as Hex;
    const fundTx = await write(KEYS.buyer, escrow, ESCROW_ABI, 'fund', [wrongBucket, intent!.reference, usdc, BigInt(String(intent!.amount_atomic))]);
    const [result] = await deposits.verifyChainTransaction(CHAIN_ID, fundTx);
    expect(result).toMatchObject({ status: 'REJECTED', reason: 'WRONG_ESCROW' });
    expect((await sql`select status from app.orders where id=${orderId}`)[0]!.status).toBe('AWAITING_PAYMENT');
  }, 60_000);
});
