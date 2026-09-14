/**
 * ChainReader contract plus a local devnet simulator. The simulator produces receipts, logs, block hashes, reorgs,
 * replacements and RPC outages so deposit verification can be tested without any network, and it applies the
 * SpacaEscrow payout rules. RPC networks (anvil locally, Arc testnet) use the JSON-RPC reader and the EVM adapter.
 */
import { createPublicClient, encodeAbiParameters, encodeEventTopics, http, keccak256, toHex, type Hex } from 'viem';
import { SETTLEMENT_EVENTS } from './abi';

export type ChainLog = { address: Hex; topics: Hex[]; data: Hex; logIndex: number; blockNumber: bigint; blockHash: Hex; transactionHash: Hex };
export type ChainReceipt = { transactionHash: Hex; blockNumber: bigint; blockHash: Hex; status: 'success' | 'reverted'; logs: ChainLog[] };

export interface ChainReader {
  readonly chainId: number;
  getBlockNumber(): Promise<bigint>;
  getBlockHash(blockNumber: bigint): Promise<Hex | null>;
  getTransactionReceipt(hash: Hex): Promise<ChainReceipt | null>;
  getLogs(filter: { address: Hex; fromBlock: bigint; toBlock: bigint }): Promise<ChainLog[]>;
}

export class ChainUnavailableError extends Error {
  constructor(message = 'RPC unavailable') {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}

type Block = { number: bigint; hash: Hex; receipts: ChainReceipt[] };

export class PayoutRejectedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PayoutRejectedError';
  }
}

/**
 * Escrow operations executed with a server authorization (contracts/src/SpacaEscrow.sol). Rejections use the contract's
 * error names as codes; `ALREADY_RELEASED:<txHash>` means the payout reference was already paid in that transaction.
 */
export interface ChainPayoutAdapter {
  executeRelease(signed: import('./authorization').SignedRelease): Promise<{ txHash: Hex }>;
  executeRefund(signed: import('./authorization').SignedRefund): Promise<{ txHash: Hex }>;
  executeFreeze(signed: import('./authorization').SignedFreeze): Promise<{ txHash: Hex }>;
  /** The transaction that paid `payoutRef`, or null when the contract has not paid it. */
  findPayout(payoutRef: Hex): Promise<Hex | null>;
  getNftOwner?(contract: Hex, tokenId: bigint): Promise<Hex | null>;
}

type SimBucket = { payer: Hex; token: Hex; deposited: bigint; released: bigint; refunded: bigint; frozen: boolean };

/** In-memory devnet. Every deposit is mined in its own block; `mine` adds empty blocks for confirmations. */
export class LocalDevChain implements ChainReader, ChainPayoutAdapter {
  private blocks: Block[] = [];
  private offline = false;
  private salt = 0;
  private readonly usedNonces = new Set<string>();
  private readonly releasedPayouts = new Map<string, Hex>();
  private readonly buckets = new Map<string, SimBucket>();
  private paused = false;
  private readonly failingTokens = new Set<string>();
  private readonly nftOwners = new Map<string, Hex>();
  readonly transfers: { kind: 'RELEASE' | 'REFUND'; payoutRef: Hex; recipient: Hex; token: Hex; amount: bigint; txHash: Hex }[] = [];

  /** `settlement` is the simulated contract's own address; releases signed for any other contract are refused. */
  constructor(readonly chainId: number, public settlement: Hex | null = null) {
    this.blocks.push({ number: 0n, hash: this.nextHash('genesis'), receipts: [] });
  }

  private nextHash(label: string): Hex {
    this.salt += 1;
    return keccak256(toHex(`${this.chainId}:${label}:${this.salt}:${Date.now()}:${Math.random()}`));
  }

  private guard() {
    if (this.offline) throw new ChainUnavailableError();
  }

  setOffline(offline: boolean) {
    this.offline = offline;
  }

  get head(): bigint {
    return this.blocks[this.blocks.length - 1]!.number;
  }

  mine(count = 1) {
    for (let i = 0; i < count; i++) this.blocks.push({ number: this.head + 1n, hash: this.nextHash('block'), receipts: [] });
  }

  /**
   * Emits `Funded` from `emitter` (normally the escrow address) in a new block and credits the simulated bucket the way
   * the contract does (first deposit fixes payer and token); returns the tx hash.
   */
  submitDeposit(input: { emitter: Hex; escrowRef: Hex; reference: Hex; payer: Hex; token: Hex; amount: bigint; reverted?: boolean; txHash?: Hex; duplicateLogs?: number }): Hex {
    const number = this.head + 1n;
    const blockHash = this.nextHash('block');
    const transactionHash = input.txHash ?? this.nextHash('tx');
    const topics = encodeEventTopics({ abi: SETTLEMENT_EVENTS, eventName: 'Funded', args: { escrowRef: input.escrowRef, paymentRef: input.reference, payer: input.payer } }) as Hex[];
    const data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [input.token, input.amount]);
    if (!input.reverted && this.settlement && input.emitter.toLowerCase() === this.settlement) {
      const key = input.escrowRef.toLowerCase();
      const bucket = this.buckets.get(key) ?? { payer: input.payer.toLowerCase() as Hex, token: input.token.toLowerCase() as Hex, deposited: 0n, released: 0n, refunded: 0n, frozen: false };
      bucket.deposited += input.amount * BigInt(1 + (input.duplicateLogs ?? 0));
      this.buckets.set(key, bucket);
    }
    const logs: ChainLog[] = input.reverted ? [] : Array.from({ length: 1 + (input.duplicateLogs ?? 0) }, (_, logIndex) => ({
      address: input.emitter.toLowerCase() as Hex, topics, data, logIndex, blockNumber: number, blockHash, transactionHash,
    }));
    this.blocks.push({ number, hash: blockHash, receipts: [{ transactionHash, blockNumber: number, blockHash, status: input.reverted ? 'reverted' : 'success', logs }] });
    return transactionHash;
  }

  /** Drops the last `depth` blocks (their transactions disappear) and mines `depth + 1` fresh blocks. */
  reorg(depth: number) {
    this.blocks = this.blocks.slice(0, Math.max(1, this.blocks.length - depth));
    this.mine(depth + 1);
  }

  /** Re-includes an existing transaction in a new block, as after a reorg or fee replacement with the same hash. */
  reinclude(receipt: ChainReceipt) {
    const number = this.head + 1n;
    const blockHash = this.nextHash('block');
    this.blocks.push({ number, hash: blockHash, receipts: [{ ...receipt, blockNumber: number, blockHash, logs: receipt.logs.map((log) => ({ ...log, blockNumber: number, blockHash })) }] });
  }

  /** Simulated token failure (paused/blocked token contract) for CRY-08 retries. */
  failTransfersOf(token: Hex, failing = true) {
    if (failing) this.failingTokens.add(token.toLowerCase());
    else this.failingTokens.delete(token.toLowerCase());
  }

  setNftOwner(contract: Hex, tokenId: bigint, owner: Hex) {
    this.nftOwners.set(`${contract.toLowerCase()}:${tokenId}`, owner.toLowerCase() as Hex);
  }

  async getNftOwner(contract: Hex, tokenId: bigint) {
    this.guard();
    return this.nftOwners.get(`${contract.toLowerCase()}:${tokenId}`) ?? null;
  }

  /** Guardian pause as on the contract: funding and signed payouts stop; payer reclaim is not simulated. */
  setPaused(paused: boolean) {
    this.paused = paused;
  }

  bucket(escrowRef: Hex): SimBucket | null {
    return this.buckets.get(escrowRef.toLowerCase()) ?? null;
  }

  private async verify(kind: 'release' | 'refund' | 'freeze', signed: unknown) {
    const auth = await import('./authorization');
    if (!this.settlement) throw new PayoutRejectedError('CONTRACT_NOT_DEPLOYED');
    const expected = { chainId: this.chainId, contract: this.settlement, signer: auth.getReleaseSigner().address, now: BigInt(Math.floor(Date.now() / 1000)) };
    try {
      if (kind === 'release') await auth.verifyReleaseSignature(signed as import('./authorization').SignedRelease, expected);
      else if (kind === 'refund') await auth.verifyRefundSignature(signed as import('./authorization').SignedRefund, expected);
      else await auth.verifyFreezeSignature(signed as import('./authorization').SignedFreeze, expected);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'BAD_SIGNATURE';
      throw new PayoutRejectedError(code === 'EXPIRED' ? 'AuthorizationExpired' : code === 'BAD_SIGNATURE' ? 'BadSignature' : code);
    }
  }

  /** Contract checks in the same order as SpacaEscrow._release/refund: bucket, token, nonce, payout, signature, balance. */
  private async payout(kind: 'RELEASE' | 'REFUND', signed: import('./authorization').SignedRelease | import('./authorization').SignedRefund): Promise<{ txHash: Hex }> {
    this.guard();
    if (this.paused) throw new PayoutRejectedError('EnforcedPause');
    const message = signed.message;
    const bucket = this.buckets.get(message.escrowRef.toLowerCase());
    if (!bucket) throw new PayoutRejectedError('UnknownBucket');
    const token = kind === 'RELEASE' ? (message as import('./authorization').ReleaseMessage).token.toLowerCase() : bucket.token;
    if (token !== bucket.token) throw new PayoutRejectedError('TokenMismatch');
    if (this.usedNonces.has(message.nonce)) throw new PayoutRejectedError('NonceUsed');
    const previous = this.releasedPayouts.get(message.payoutRef);
    if (previous) throw new PayoutRejectedError(`ALREADY_RELEASED:${previous}`);
    await this.verify(kind === 'RELEASE' ? 'release' : 'refund', signed);
    if (bucket.frozen) throw new PayoutRejectedError('BucketFrozen');
    if (message.amount <= 0n || message.amount > bucket.deposited - bucket.released - bucket.refunded) throw new PayoutRejectedError('InsufficientBucketBalance');
    if (this.failingTokens.has(token)) throw new PayoutRejectedError('TOKEN_TRANSFER_FAILED');
    this.usedNonces.add(message.nonce);
    const txHash = this.nextHash(kind.toLowerCase());
    this.releasedPayouts.set(message.payoutRef, txHash);
    if (kind === 'RELEASE') bucket.released += message.amount;
    else bucket.refunded += message.amount;
    const recipient = kind === 'RELEASE' ? (message as import('./authorization').ReleaseMessage).recipient : bucket.payer;
    this.transfers.push({ kind, payoutRef: message.payoutRef, recipient, token: bucket.token, amount: message.amount, txHash });
    this.mine(1);
    return { txHash };
  }

  executeRelease(signed: import('./authorization').SignedRelease) {
    return this.payout('RELEASE', signed);
  }

  executeRefund(signed: import('./authorization').SignedRefund) {
    return this.payout('REFUND', signed);
  }

  async executeFreeze(signed: import('./authorization').SignedFreeze): Promise<{ txHash: Hex }> {
    this.guard();
    const bucket = this.buckets.get(signed.message.escrowRef.toLowerCase());
    if (!bucket) throw new PayoutRejectedError('UnknownBucket');
    if (this.usedNonces.has(signed.message.nonce)) throw new PayoutRejectedError('NonceUsed');
    await this.verify('freeze', signed);
    this.usedNonces.add(signed.message.nonce);
    bucket.frozen = signed.message.frozen;
    const txHash = this.nextHash('freeze');
    this.mine(1);
    return { txHash };
  }

  async findPayout(payoutRef: Hex): Promise<Hex | null> {
    this.guard();
    return this.releasedPayouts.get(payoutRef) ?? null;
  }

  async getBlockNumber() {
    this.guard();
    return this.head;
  }

  async getBlockHash(blockNumber: bigint) {
    this.guard();
    return this.blocks.find((block) => block.number === blockNumber)?.hash ?? null;
  }

  async getTransactionReceipt(hash: Hex) {
    this.guard();
    for (const block of this.blocks) {
      const receipt = block.receipts.find((r) => r.transactionHash.toLowerCase() === hash.toLowerCase());
      if (receipt) return receipt;
    }
    return null;
  }

  async getLogs(filter: { address: Hex; fromBlock: bigint; toBlock: bigint }) {
    this.guard();
    return this.blocks.filter((b) => b.number >= filter.fromBlock && b.number <= filter.toBlock)
      .flatMap((b) => b.receipts.flatMap((r) => r.logs)).filter((log) => log.address.toLowerCase() === filter.address.toLowerCase());
  }
}

/** JSON-RPC reader for an RPC network (anvil or a verified TESTNET). */
export function createRpcChainReader(chainId: number, rpcUrl: string): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  const wrap = async <T>(call: () => Promise<T>) => {
    try {
      return await call();
    } catch (error) {
      throw new ChainUnavailableError(error instanceof Error ? error.name : 'RPC error');
    }
  };
  return {
    chainId,
    getBlockNumber: () => wrap(() => client.getBlockNumber()),
    getBlockHash: (blockNumber) => wrap(async () => (await client.getBlock({ blockNumber })).hash ?? null),
    getTransactionReceipt: (hash) => wrap(async () => {
      const receipt = await client.getTransactionReceipt({ hash }).catch((error: Error) => (error.name === 'TransactionReceiptNotFoundError' ? null : Promise.reject(error)));
      return receipt ? {
        transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status,
        logs: receipt.logs.map((log) => ({ address: log.address, topics: [...log.topics] as Hex[], data: log.data, logIndex: log.logIndex, blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash })),
      } : null;
    }),
    getLogs: (filter) => wrap(async () => (await client.getLogs({ address: filter.address, fromBlock: filter.fromBlock, toBlock: filter.toBlock }))
      .map((log) => ({ address: log.address, topics: [...log.topics] as Hex[], data: log.data, logIndex: log.logIndex!, blockNumber: log.blockNumber!, blockHash: log.blockHash!, transactionHash: log.transactionHash! }))),
  };
}

// Next dev bundles route handlers separately; like the mock provider, the simulated chains live on globalThis so
// every route in the process sees the same devnet state.
const chainStore = globalThis as typeof globalThis & { __ccmChainOverrides?: Map<number, ChainReader>; __ccmLocalChains?: Map<number, LocalDevChain> };
const overrides = (chainStore.__ccmChainOverrides ??= new Map<number, ChainReader>());
const localChains = (chainStore.__ccmLocalChains ??= new Map<number, LocalDevChain>());

export function localChainsEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.LOCAL_CHAIN !== 'off';
}

/** LOCAL networks use the in-process simulator (like the mock payment provider); TESTNET needs CHAIN_RPC_URL_<id>. */
export function getChainReader(network: Record<string, unknown>): ChainReader {
  const chainId = Number(network.chain_id);
  const override = overrides.get(chainId);
  if (override) return override;
  // An explicit RPC wins over the simulator, so a LOCAL network can point at a real EVM node such as anvil.
  const rpcUrl = process.env[`CHAIN_RPC_URL_${chainId}`];
  if (rpcUrl && ['TESTNET', 'LOCAL'].includes(String(network.mode))) {
    if (String(network.mode) === 'LOCAL' && !localChainsEnabled()) throw new ChainUnavailableError('Local networks are disabled in this environment');
    return createRpcChainReader(chainId, rpcUrl);
  }
  if (String(network.mode) === 'LOCAL') {
    if (!localChainsEnabled()) throw new ChainUnavailableError('Local devnet is disabled in this environment');
    const settlement = network.settlement_address ? (String(network.settlement_address).toLowerCase() as Hex) : null;
    if (!localChains.has(chainId)) localChains.set(chainId, new LocalDevChain(chainId, settlement));
    const local = localChains.get(chainId)!;
    // A chain first created without the network row (dev wallet simulator) learns its contract address later.
    if (!local.settlement && settlement) local.settlement = settlement;
    return local;
  }
  throw new ChainUnavailableError('No verified RPC is configured for this network');
}

/**
 * The simulator executes payouts itself. An RPC network needs an executor account that submits signed authorizations
 * and pays gas (CHAIN_EXECUTOR_KEY_<chainId>); it holds no escrowed funds and cannot authorize anything on its own.
 */
const payoutAdapters = ((globalThis as typeof globalThis & { __ccmPayoutAdapters?: Map<string, ChainPayoutAdapter> }).__ccmPayoutAdapters ??= new Map());

export async function getPayoutAdapter(network: Record<string, unknown>): Promise<ChainPayoutAdapter> {
  const reader = getChainReader(network);
  if ('executeRelease' in reader) return reader as unknown as ChainPayoutAdapter;
  const chainId = Number(network.chain_id);
  const rpcUrl = process.env[`CHAIN_RPC_URL_${chainId}`];
  const executorKey = process.env[`CHAIN_EXECUTOR_KEY_${chainId}`];
  if (!rpcUrl || !executorKey || !/^0x[0-9a-fA-F]{64}$/.test(executorKey)) throw new ChainUnavailableError('No executor account is configured for this network');
  const key = `${chainId}:${String(network.settlement_address).toLowerCase()}`;
  if (!payoutAdapters.has(key)) {
    const { createEvmPayoutAdapter } = await import('./evm');
    payoutAdapters.set(key, createEvmPayoutAdapter({ chainId, rpcUrl, executorKey: executorKey as Hex, escrow: String(network.settlement_address).toLowerCase() as Hex }));
  }
  return payoutAdapters.get(key)!;
}

export function getLocalDevChain(chainId: number, settlementAddress?: string): LocalDevChain | null {
  const reader = overrides.get(chainId) ?? (localChainsEnabled() ? getChainReader({ chain_id: chainId, mode: 'LOCAL', settlement_address: settlementAddress }) : null);
  // Structural check: a class copy from another bundle is still the simulator.
  return reader && 'submitDeposit' in reader && 'mine' in reader ? (reader as LocalDevChain) : null;
}

export function setChainReaderForTests(chainId: number, reader: ChainReader | undefined) {
  if (reader) overrides.set(chainId, reader);
  else overrides.delete(chainId);
}
