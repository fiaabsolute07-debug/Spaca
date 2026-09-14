import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Actor } from '@/lib/auth';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { RUN_DB, callRoute, createPublishedService, createUser, key, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const depositsRoute = await import('@/app/api/crypto/deposits/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const chain = await import('@/modules/crypto/chain');
const deposits = await import('@/modules/crypto/deposits');
const wallets = await import('@/modules/crypto/wallets');
const { NATIVE_TOKEN } = await import('@/modules/crypto/abi');
const { sql } = await import('@/lib/db');
const { createSession } = await import('@/lib/auth');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const asActor = (user: TestUser): Actor => ({ id: user.id, email: user.email, display_name: 'x', roles: ['buyer', 'creator'], is_test: true, status: 'ACTIVE', timezone: 'UTC' });
const reason = 'Crypto integration suite toggles the checkout flag.';

const CHAIN_A = 9_100_000 + Math.floor(Math.random() * 800_000);
const CHAIN_B = CHAIN_A + 1;
const SETTLEMENT = '0x5e7713e0000000000000000000000000000000aa' as Hex;
const TOKEN6 = '0x05dc0000000000000000000000000000000000b6' as Hex;
const JUNK = '0x0bad000000000000000000000000000000000bad' as Hex;
let devA: InstanceType<typeof chain.LocalDevChain>;
let devB: InstanceType<typeof chain.LocalDevChain>;
let admin: TestUser;
const assets: Record<string, string> = {};

async function operator(): Promise<TestUser> {
  const email = `it-crypto-admin-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'IT admin',${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},'admin','Crypto suite operator grant')`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}
const setFlag = (enabled: boolean) => command(admin, { command: 'admin_set_flag', idempotency_key: key('flag'), key: 'CRYPTO_CHECKOUT_ENABLED', enabled: String(enabled), reason });

async function awaitingOrder(label: string) {
  const creator = await createUser(`${label}-creator`);
  const buyer = await createUser(`${label}-buyer`);
  const { serviceId, creatorId } = await createPublishedService(command, creator, { capacity: 2, price: '650' });
  const booked = await command(buyer, { command: 'book', idempotency_key: key('book'), service_id: serviceId, brief: 'Crypto checkout brief with enough detail to start.', accept_terms: 'on' });
  expect(booked.status).toBe(200);
  return { creator, buyer, creatorId, orderId: String(booked.body.id) };
}
async function intentFor(buyer: TestUser, orderId: string, fields: Record<string, string> = {}) {
  const created = await command(buyer, { command: 'create_crypto_payment', idempotency_key: key('cp'), order_id: orderId, chain_id: String(CHAIN_A), asset_id: assets.native!, ...fields });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return (await sql`select * from app.crypto_payment_intents where id=${String(created.body.id)}`)[0]!;
}
const PAYER = '0x00000000000000000000000000000000000000f1' as Hex;
const pay = (dev: InstanceType<typeof chain.LocalDevChain>, intent: Record<string, unknown>, overrides: Partial<{ amount: bigint; token: Hex; emitter: Hex; payer: Hex; reference: Hex; escrowRef: Hex; reverted: boolean }> = {}) => dev.submitDeposit({
  emitter: SETTLEMENT, escrowRef: intent.escrow_ref as Hex, reference: intent.reference as Hex, payer: PAYER, token: NATIVE_TOKEN as Hex, amount: BigInt(String(intent.amount_atomic)), ...overrides,
});
async function linkWallet(user: TestUser, chainId: number): Promise<Hex> {
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await wallets.createWalletChallenge(asActor(user), { chainId, address: account.address, domain: 'localhost:3000', uri: 'http://localhost:3000' });
  await wallets.verifyWalletChallenge(asActor(user), { challengeId: challenge.challenge_id, signature: await account.signMessage({ message: challenge.message }), domain: 'localhost:3000' });
  return account.address.toLowerCase() as Hex;
}
async function financeUser(): Promise<TestUser> {
  const email = `it-crypto-finance-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'IT finance',${[]},true,'ACTIVE') returning id`;
  await sql`insert into app.user_roles (user_id,role,granted_reason) values (${user!.id},'finance','Crypto suite finance grant')`;
  return { id: user!.id, email, token: await createSession(user!.id) };
}
const orderRow = async (id: string) => (await sql`select * from app.orders where id=${id}`)[0]!;
const verify = async (buyer: TestUser, intentId: string, txHash: string) => callRoute(depositsRoute.POST, '/api/crypto/deposits', buyer, { intent_id: intentId, tx_hash: txHash });

beforeAll(async () => {
  if (!RUN_DB) return;
  for (const chainId of [CHAIN_A, CHAIN_B]) {
    await sql`insert into app.chain_networks (chain_id,name,mode,settlement_address,finality_confirmations,enabled) values (${chainId},${`IT devnet ${chainId}`},'LOCAL',${SETTLEMENT},3,true)`;
  }
  const [native] = await sql`insert into app.chain_assets (chain_id,symbol,kind,decimals,balance_key,usd_pegged,transfer_behavior,allowlisted) values (${CHAIN_A},'USDC','NATIVE',18,'USDC',true,'STANDARD',true) returning id`;
  const [erc] = await sql`insert into app.chain_assets (chain_id,symbol,kind,contract_address,decimals,balance_key,usd_pegged,transfer_behavior,allowlisted) values (${CHAIN_A},'USDC','ERC20',${TOKEN6},6,'USDC6',true,'STANDARD',true) returning id`;
  await sql`insert into app.chain_assets (chain_id,symbol,kind,contract_address,decimals,balance_key,transfer_behavior,allowlisted) values (${CHAIN_A},'JUNK','ERC20',${JUNK},18,'JUNK','FEE_ON_TRANSFER',false)`;
  await sql`insert into app.chain_assets (chain_id,symbol,kind,decimals,balance_key,usd_pegged,transfer_behavior,allowlisted) values (${CHAIN_B},'USDC','NATIVE',18,'USDC',true,'STANDARD',true)`;
  assets.native = String(native!.id);
  assets.erc6 = String(erc!.id);
  admin = await operator();
});
beforeEach(async () => {
  if (!RUN_DB) return;
  funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_crypto_suite_secret_01'] }));
  devA = new chain.LocalDevChain(CHAIN_A, SETTLEMENT);
  devB = new chain.LocalDevChain(CHAIN_B, SETTLEMENT);
  chain.setChainReaderForTests(CHAIN_A, devA);
  chain.setChainReaderForTests(CHAIN_B, devB);
  await sql`update app.chain_networks set enabled=true where chain_id in (${CHAIN_A},${CHAIN_B})`;
  expect((await setFlag(true)).status).toBe(200);
});
afterAll(async () => {
  if (!RUN_DB) return;
  await setFlag(false);
  await sql`update app.chain_networks set enabled=false where chain_id in (${CHAIN_A},${CHAIN_B})`;
  chain.setChainReaderForTests(CHAIN_A, undefined);
  chain.setChainReaderForTests(CHAIN_B, undefined);
  funding.setMockPaymentProviderForTests(undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('CRY-01/14 — registry gates and wallet proof of control', () => {
  it('mainnet cannot be enabled, testnet needs verification, and checkout stays behind its flag', async () => {
    await expect(sql`insert into app.chain_networks (chain_id,name,mode,settlement_address,finality_confirmations,enabled) values (${CHAIN_A + 7},'Main','MAINNET',${SETTLEMENT},12,true)`).rejects.toThrow(/mainnet_blocked/);
    await expect(sql`insert into app.chain_networks (chain_id,name,mode,settlement_address,finality_confirmations,enabled) values (${CHAIN_A + 8},'Test','TESTNET',${SETTLEMENT},12,true)`).rejects.toThrow(/testnet_verified/);
    await expect(sql`insert into app.chain_assets (chain_id,symbol,kind,contract_address,decimals,balance_key,transfer_behavior,allowlisted) values (${CHAIN_A},'REB','ERC20','0x00000000000000000000000000000000000000cb',18,'REB','REBASING',true)`).rejects.toThrow(/standard_only/);
    const { buyer, orderId } = await awaitingOrder('cry14');
    expect((await setFlag(false)).status).toBe(200);
    expect((await command(buyer, { command: 'create_crypto_payment', idempotency_key: key('cp'), order_id: orderId, chain_id: String(CHAIN_A) })).status).toBe(422);
    expect((await setFlag(true)).status).toBe(200);
    const intent = await intentFor(buyer, orderId);
    expect(intent).toMatchObject({ network_mode: 'LOCAL', recipient: SETTLEMENT, amount_atomic: (65000n * 10n ** 16n).toString(), status: 'AWAITING_DEPOSIT' });
    expect(String(intent.reference)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(String(intent.reference)).not.toContain(orderId.replaceAll('-', ''));
  });

  it('links a wallet only with a fresh signature for this site, chain and nonce', async () => {
    const user = await createUser('wallet-owner');
    const other = await createUser('wallet-other');
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await wallets.createWalletChallenge(asActor(user), { chainId: CHAIN_A, address: account.address, domain: 'localhost:3000', uri: 'http://localhost:3000' });
    expect(challenge.message).toContain(`Chain ID: ${CHAIN_A}`);
    const signature = await account.signMessage({ message: challenge.message });
    const intruder = privateKeyToAccount(generatePrivateKey());
    const forged = await intruder.signMessage({ message: challenge.message });
    await expect(wallets.verifyWalletChallenge(asActor(user), { challengeId: challenge.challenge_id, signature: forged, domain: 'localhost:3000' })).rejects.toThrow(/does not match/);
    await expect(wallets.verifyWalletChallenge(asActor(user), { challengeId: challenge.challenge_id, signature, domain: 'evil.example' })).rejects.toThrow(/different site/);
    await expect(wallets.verifyWalletChallenge(asActor(other), { challengeId: challenge.challenge_id, signature, domain: 'localhost:3000' })).rejects.toThrow(/not found/);
    const linked = await wallets.verifyWalletChallenge(asActor(user), { challengeId: challenge.challenge_id, signature, domain: 'localhost:3000' });
    expect(linked.address).toBe(account.address);
    await expect(wallets.verifyWalletChallenge(asActor(user), { challengeId: challenge.challenge_id, signature, domain: 'localhost:3000' })).rejects.toThrow(/already used/);

    const stolen = await wallets.createWalletChallenge(asActor(other), { chainId: CHAIN_A, address: account.address, domain: 'localhost:3000', uri: 'http://localhost:3000' });
    await expect(wallets.verifyWalletChallenge(asActor(other), { challengeId: stolen.challenge_id, signature: await account.signMessage({ message: stolen.message }), domain: 'localhost:3000' })).rejects.toThrow(/another account/);
    const late = await wallets.createWalletChallenge(asActor(user), { chainId: CHAIN_A, address: intruder.address, domain: 'localhost:3000', uri: 'http://localhost:3000' });
    await sql`update app.wallet_challenges set issued_at=now() - interval '20 minutes', expires_at=now() - interval '10 minutes' where id=${late.challenge_id}`;
    const lateRow = (await sql`select * from app.wallet_challenges where id=${late.challenge_id}`)[0]!;
    await expect(wallets.verifyWalletChallenge(asActor(user), { challengeId: late.challenge_id, signature: await intruder.signMessage({ message: wallets.walletMessage(lateRow) }), domain: 'localhost:3000' })).rejects.toThrow(/expired/);
  });
});

describe.skipIf(!RUN_DB)('CRY-02 — the chain decides, not the client', () => {
  it('fake hashes, untrusted emitters, reverted transactions, unsupported tokens and unknown references never fund', async () => {
    const { buyer, orderId } = await awaitingOrder('cry02a');
    const intent = await intentFor(buyer, orderId);
    const fake = await verify(buyer, String(intent.id), `0x${'ab'.repeat(32)}`);
    expect(fake.body.results).toEqual([expect.objectContaining({ status: 'NOT_FOUND' })]);
    const spoofed = pay(devA, intent, { emitter: '0x00000000000000000000000000000000000beef1' });
    const reverted = pay(devA, intent, { reverted: true });
    const junk = pay(devA, intent, { token: JUNK });
    const stranger = pay(devA, intent, { reference: `0x${'12'.repeat(32)}` });
    devA.mine(5);
    expect((await verify(buyer, String(intent.id), spoofed)).body.results).toEqual([expect.objectContaining({ status: 'REJECTED', reason: 'EVENT_FROM_UNTRUSTED_CONTRACT' })]);
    expect((await verify(buyer, String(intent.id), reverted)).body.results).toEqual([expect.objectContaining({ status: 'REJECTED', reason: 'TX_REVERTED' })]);
    expect((await verify(buyer, String(intent.id), junk)).body.results).toEqual([expect.objectContaining({ status: 'REJECTED', reason: 'UNSUPPORTED_ASSET' })]);
    expect((await deposits.verifyChainTransaction(CHAIN_A, stranger))[0]).toMatchObject({ status: 'REJECTED', reason: 'UNKNOWN_REFERENCE' });
    expect((await sql`select count(*)::int as n from app.reconciliation_cases where kind='UNMATCHED_CHAIN_DEPOSIT' and next_action like ${`%${stranger}%`}`)[0]!.n).toBe(1);
    expect(await orderRow(orderId)).toMatchObject({ status: 'AWAITING_PAYMENT', payment_status: 'PENDING' });
    expect((await verify(await createUser('cry02-outsider'), String(intent.id), junk)).status).toBe(404);
  });

  it('underpayment, the wrong chain and the wrong sender become explained exceptions, not funding', async () => {
    const under = await awaitingOrder('cry02b');
    const underIntent = await intentFor(under.buyer, under.orderId);
    const short = pay(devA, underIntent, { amount: BigInt(String(underIntent.amount_atomic)) - 1n });
    devA.mine(3);
    expect((await deposits.verifyChainTransaction(CHAIN_A, short))[0]).toMatchObject({ status: 'REJECTED', reason: 'UNDERPAID', order_id: under.orderId });
    expect((await sql`select status,status_reason from app.crypto_payment_intents where id=${String(underIntent.id)}`)[0]).toMatchObject({ status: 'EXCEPTION', status_reason: 'UNDERPAID' });
    expect((await sql`select count(*)::int as n from app.reconciliation_cases where order_id=${under.orderId} and kind='CRYPTO_DEPOSIT_EXCEPTION'`)[0]!.n).toBe(1);
    expect((await orderRow(under.orderId)).status).toBe('AWAITING_PAYMENT');

    const wrongChain = await awaitingOrder('cry02c');
    const chainIntent = await intentFor(wrongChain.buyer, wrongChain.orderId);
    const onB = pay(devB, chainIntent);
    devB.mine(3);
    expect((await verify(wrongChain.buyer, String(chainIntent.id), onB)).body.results).toEqual([expect.objectContaining({ status: 'NOT_FOUND' })]);
    expect((await deposits.verifyChainTransaction(CHAIN_B, onB))[0]).toMatchObject({ status: 'REJECTED', reason: 'WRONG_CHAIN' });

    const bound = await awaitingOrder('cry02d');
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await wallets.createWalletChallenge(asActor(bound.buyer), { chainId: CHAIN_A, address: account.address, domain: 'localhost:3000', uri: 'http://localhost:3000' });
    const wallet = await wallets.verifyWalletChallenge(asActor(bound.buyer), { challengeId: challenge.challenge_id, signature: await account.signMessage({ message: challenge.message }), domain: 'localhost:3000' });
    const boundIntent = await intentFor(bound.buyer, bound.orderId, { wallet_id: wallet.wallet_id });
    const fromElsewhere = pay(devA, boundIntent, { payer: '0x0000000000000000000000000000000000000999' });
    devA.mine(3);
    expect((await deposits.verifyChainTransaction(CHAIN_A, fromElsewhere))[0]).toMatchObject({ status: 'REJECTED', reason: 'WRONG_SENDER' });
  });
});

describe.skipIf(!RUN_DB)('CRY-03/04/05 — exact credit once, finality, outages and reorgs', () => {
  it('CRY-03/04: a final deposit funds once in exact units; replays and the indexer never double count', async () => {
    const { buyer, orderId, creatorId } = await awaitingOrder('cry03');
    const intent = await intentFor(buyer, orderId, { asset_id: assets.erc6! });
    expect(intent.amount_atomic).toBe('650000000');
    const txHash = pay(devA, intent, { token: TOKEN6 });
    devA.mine(2);
    const first = await verify(buyer, String(intent.id), txHash);
    expect(first.body.results).toEqual([expect.objectContaining({ status: 'CREDITED', funding: 'FUNDED', reason: '650.00 USDC' })]);
    expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', payment_status: 'SUCCEEDED', payment_rail: 'CRYPTO', provider_fee_minor: '0' });
    expect((await sql`select state from app.workload_claims where order_id=${orderId}`)[0]!.state).toBe('ACTIVE');
    expect((await verify(buyer, String(intent.id), txHash)).body.results).toEqual([expect.objectContaining({ status: 'DUPLICATE' })]);
    const scan = await deposits.scanChainDeposits(CHAIN_A);
    expect(scan.outcomes.CREDITED ?? 0).toBe(0);
    const entries = await sql`select e.account,e.amount_minor from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${orderId}`;
    expect(entries.map((e) => [String(e.account).replace(orderId, '<order>'), e.amount_minor]).sort()).toEqual([[`chain_clearing:${CHAIN_A}`, '65000'], ['order_principal:<order>', '-65000']]);
    const event = (await sql`select payload from app.order_events where order_id=${orderId} and kind='PAYMENT_CONFIRMED'`)[0]!.payload as Record<string, unknown>;
    expect(event).toMatchObject({ rail: 'CRYPTO', network_mode: 'LOCAL', tx_hash: txHash.toLowerCase(), amount_atomic: '650000000' });

    const again = pay(devA, intent, { token: TOKEN6 });
    devA.mine(3);
    expect((await deposits.verifyChainTransaction(CHAIN_A, again))[0]).toMatchObject({ status: 'REJECTED', reason: 'DUPLICATE_PAYMENT' });
    expect((await sql`select count(*)::int as n from app.chain_deposits where intent_id=${String(intent.id)} and status='CREDITED'`)[0]!.n).toBe(1);
    expect(creatorId).toBeTruthy();
  });

  it('CRY-05: pending finality holds the slot through an outage, then credits exactly once', async () => {
    const { buyer, orderId } = await awaitingOrder('cry05');
    const intent = await intentFor(buyer, orderId);
    const txHash = pay(devA, intent);
    expect((await deposits.verifyChainTransaction(CHAIN_A, txHash))[0]).toMatchObject({ status: 'PENDING_FINALITY', reason: '1/3 confirmations' });
    expect((await sql`select status from app.crypto_payment_intents where id=${String(intent.id)}`)[0]!.status).toBe('PENDING_FINALITY');
    // The checkout hold expires while the deposit is still confirming: capacity reconciles instead of being released.
    await sql`update app.workload_claims set expires_at=now() - interval '1 minute' where order_id=${orderId}`;
    expect((await jobs.expireCheckoutHolds({ orderId })).outcomes).toEqual({ RECONCILING: 1 });
    expect((await command(buyer, { command: 'cancel', idempotency_key: key('c'), order_id: orderId })).status).toBe(400);

    devA.setOffline(true);
    const before = (await sql`select last_scanned_block from app.chain_checkpoints where chain_id=${CHAIN_A}`)[0]?.last_scanned_block ?? null;
    expect(await deposits.scanChainDeposits(CHAIN_A)).toMatchObject({ error: 'RPC_UNAVAILABLE' });
    expect(await deposits.recheckPendingDeposits(CHAIN_A)).toMatchObject({ error: 'RPC_UNAVAILABLE' });
    expect((await sql`select last_scanned_block from app.chain_checkpoints where chain_id=${CHAIN_A}`)[0]?.last_scanned_block ?? null).toEqual(before);
    devA.setOffline(false);
    devA.mine(2);
    const indexed = await jobs.indexChainDeposits();
    expect(indexed.outcomes.CREDITED ?? 0).toBeGreaterThanOrEqual(1);
    expect(await orderRow(orderId)).toMatchObject({ status: 'FUNDED', payment_rail: 'CRYPTO' });
    expect((await sql`select state from app.workload_claims where order_id=${orderId}`)[0]!.state).toBe('ACTIVE');
    await jobs.indexChainDeposits();
    expect((await sql`select count(*)::int as n from app.ledger_transactions where order_id=${orderId}`)[0]!.n).toBe(1);
  });

  it('CRY-05: a reorganized deposit is dropped and the re-included transaction credits once', async () => {
    const { buyer, orderId } = await awaitingOrder('cry05r');
    const intent = await intentFor(buyer, orderId);
    const txHash = pay(devA, intent);
    const receipt = (await devA.getTransactionReceipt(txHash))!;
    expect((await deposits.verifyChainTransaction(CHAIN_A, txHash))[0]!.status).toBe('PENDING_FINALITY');
    devA.reorg(1);
    expect((await deposits.recheckPendingDeposits(CHAIN_A)).outcomes).toMatchObject({ REORGED: 1 });
    expect((await sql`select status from app.crypto_payment_intents where id=${String(intent.id)}`)[0]!.status).toBe('AWAITING_DEPOSIT');
    expect((await orderRow(orderId)).status).toBe('AWAITING_PAYMENT');

    devA.reinclude(receipt);
    devA.mine(3);
    // Same tx hash and log index: the REORGED row is final, so a replacement with a new hash is how funds arrive.
    const replacement = pay(devA, intent);
    devA.mine(3);
    expect((await deposits.verifyChainTransaction(CHAIN_A, replacement))[0]).toMatchObject({ status: 'CREDITED', funding: 'FUNDED' });
    expect((await deposits.verifyChainTransaction(CHAIN_A, txHash))[0]).toMatchObject({ status: 'REORGED' });
    expect((await sql`select count(*)::int as n from app.chain_deposits where intent_id=${String(intent.id)} and status='CREDITED'`)[0]!.n).toBe(1);
  });

  it('late deposits after cancellation open a case; a cancelled crypto order is refunded to the paying wallet through the escrow', async () => {
    const late = await awaitingOrder('crylate');
    const lateIntent = await intentFor(late.buyer, late.orderId);
    expect((await command(late.buyer, { command: 'cancel', idempotency_key: key('c'), order_id: late.orderId })).status).toBe(200);
    expect((await sql`select status from app.crypto_payment_intents where id=${String(lateIntent.id)}`)[0]!.status).toBe('CANCELLED');
    const txHash = pay(devA, lateIntent);
    devA.mine(3);
    expect((await deposits.verifyChainTransaction(CHAIN_A, txHash))[0]).toMatchObject({ status: 'CREDITED', funding: 'LATE_FUNDING' });
    expect(await orderRow(late.orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'PENDING' });
    expect((await sql`select count(*)::int as n from app.reconciliation_cases where order_id=${late.orderId} and kind='LATE_FUNDING'`)[0]!.n).toBe(1);

    const paid = await awaitingOrder('cryrefund');
    const paidIntent = await intentFor(paid.buyer, paid.orderId);
    const paidTx = pay(devA, paidIntent);
    devA.mine(3);
    await deposits.verifyChainTransaction(CHAIN_A, paidTx);
    expect((await command(paid.buyer, { command: 'cancel', idempotency_key: key('c'), order_id: paid.orderId })).status).toBe(200);
    expect(await orderRow(paid.orderId)).toMatchObject({ status: 'CANCELLED', payment_status: 'REFUND_PENDING' });
    expect((await sql`select kind,state,recipient from app.chain_payouts where order_id=${paid.orderId}`)).toEqual([{ kind: 'ORDER_REFUND', state: 'QUEUED', recipient: PAYER }]);
    expect(devA.transfers).toEqual([]);
    expect((await jobs.dispatchChainPayouts({ orderId: paid.orderId })).outcomes).toEqual({ CONFIRMED: 1 });
    expect(await orderRow(paid.orderId)).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED' });
    expect(devA.transfers).toEqual([expect.objectContaining({ kind: 'REFUND', recipient: PAYER, amount: BigInt(String(paidIntent.amount_atomic)) })]);
    const ledger = await sql`select sum(e.amount_minor)::text as total from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${paid.orderId}`;
    expect(ledger[0]!.total).toBe('0');
    expect(devA.bucket(paidIntent.escrow_ref as Hex)).toMatchObject({ refunded: BigInt(String(paidIntent.amount_atomic)), released: 0n });
  });

  it('an approved crypto order releases to the creator wallet once; without a wallet it waits with a case', async () => {
    const funded = await awaitingOrder('cryrelease');
    const intent = await intentFor(funded.buyer, funded.orderId);
    const fundedTx = pay(devA, intent);
    devA.mine(3);
    await deposits.verifyChainTransaction(CHAIN_A, fundedTx);
    expect((await orderRow(funded.orderId)).status).toBe('FUNDED');
    for (const [actor, fields] of [[funded.creator, { command: 'start' }], [funded.creator, { command: 'deliver', body: 'Delivered launch copy, all agreed items included here.' }], [funded.buyer, { command: 'approve', delivery_version: '1' }]] as const) {
      expect((await command(actor, { idempotency_key: key('step'), order_id: funded.orderId, ...fields })).status).toBe(200);
    }
    expect((await jobs.releaseReadySettlements({ orderId: funded.orderId })).outcomes).toEqual({ RELEASE_RETRY_NO_PAYOUT_WALLET: 1 });
    expect((await sql`select count(*)::int as n from app.reconciliation_cases where order_id=${funded.orderId} and kind='NO_PAYOUT_WALLET'`)[0]!.n).toBe(1);

    const wallet = await linkWallet(funded.creator, CHAIN_A);
    expect((await jobs.releaseReadySettlements({ orderId: funded.orderId })).outcomes).toEqual({ RELEASE_REQUESTED: 1 });
    expect((await orderRow(funded.orderId)).settlement_status).toBe('PENDING');
    expect((await jobs.releaseReadySettlements({ orderId: funded.orderId })).examined).toBe(0);
    expect((await jobs.dispatchChainPayouts({ orderId: funded.orderId })).outcomes).toEqual({ CONFIRMED: 1 });
    expect(await orderRow(funded.orderId)).toMatchObject({ status: 'COMPLETED', settlement_status: 'RELEASED' });
    expect(devA.transfers).toEqual([expect.objectContaining({ kind: 'RELEASE', recipient: wallet, amount: BigInt(String(intent.amount_atomic)) })]);
    const [event] = await sql`select payload from app.order_events where order_id=${funded.orderId} and kind='SETTLEMENT_RELEASED'`;
    expect(event!.payload).toMatchObject({ rail: 'CRYPTO', platform_fee_minor: '0', creator_net_minor: '65000' });
    const ledger = await sql`select sum(e.amount_minor)::text as total from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where t.order_id=${funded.orderId}`;
    expect(ledger[0]!.total).toBe('0');
  });

  it('a dispute freezes the escrow; resolution unfreezes it before the refund, which the worker applies in order', async () => {
    const disputed = await awaitingOrder('crydispute');
    const intent = await intentFor(disputed.buyer, disputed.orderId);
    const disputedTx = pay(devA, intent);
    devA.mine(3);
    await deposits.verifyChainTransaction(CHAIN_A, disputedTx);
    expect((await command(disputed.creator, { command: 'start', idempotency_key: key('s'), order_id: disputed.orderId })).status).toBe(200);
    expect((await command(disputed.buyer, { command: 'dispute', idempotency_key: key('d'), order_id: disputed.orderId, body: 'The creator stopped responding after starting.' })).status).toBe(200);
    expect((await jobs.dispatchChainPayouts({ orderId: disputed.orderId })).outcomes).toEqual({ CONFIRMED: 1 });
    expect(devA.bucket(intent.escrow_ref as Hex)).toMatchObject({ frozen: true });

    const finance = await financeUser();
    const [dispute] = await sql`select id from app.disputes where order_id=${disputed.orderId}`;
    const resolved = await command(finance, { command: 'admin_resolve_dispute', idempotency_key: key('r'), dispute_id: String(dispute!.id), outcome: 'REFUND_FULL', reason: 'Creator abandoned the work; full refund.' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect((await sql`select kind from app.chain_payouts where order_id=${disputed.orderId} order by created_at`).map((r) => r.kind)).toEqual(['FREEZE', 'UNFREEZE', 'ORDER_REFUND']);
    expect((await jobs.dispatchChainPayouts({ orderId: disputed.orderId })).outcomes).toEqual({ CONFIRMED: 2 });
    expect(devA.bucket(intent.escrow_ref as Hex)).toMatchObject({ frozen: false, refunded: BigInt(String(intent.amount_atomic)) });
    expect(await orderRow(disputed.orderId)).toMatchObject({ status: 'REFUNDED', payment_status: 'REFUNDED' });
  });
});
