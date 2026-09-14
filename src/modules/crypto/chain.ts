/**
 * ChainReader contract plus a local devnet simulator. The simulator produces receipts, logs, block hashes, reorgs,
 * replacements and RPC outages so deposit verification can be tested without any network. Real networks use an RPC
 * reader; no testnet or mainnet reader is exercised in this repository (BLOCKED on verified access).
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

/** Settlement payouts (releases and pool refunds) executed with a server release authorization. */
export interface ChainPayoutAdapter {
  executeRelease(signed: import('./authorization').SignedRelease): Promise<{ txHash: Hex }>;
  getNftOwner?(contract: Hex, tokenId: bigint): Promise<Hex | null>;
}

/** In-memory devnet. Every deposit is mined in its own block; `mine` adds empty blocks for confirmations. */
export class LocalDevChain implements ChainReader, ChainPayoutAdapter {
  private blocks: Block[] = [];
  private offline = false;
  private salt = 0;
  private readonly usedNonces = new Set<string>();
  private readonly releasedPayouts = new Map<string, Hex>();
  private readonly failingTokens = new Set<string>();
  private readonly nftOwners = new Map<string, Hex>();
  readonly transfers: { payoutRef: Hex; recipient: Hex; token: Hex; amount: bigint; txHash: Hex }[] = [];

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

  /** Emits `OrderFunded` from `emitter` (normally the settlement address) in a new block; returns the tx hash. */
  submitDeposit(input: { emitter: Hex; reference: Hex; payer: Hex; token: Hex; amount: bigint; reverted?: boolean; txHash?: Hex; duplicateLogs?: number }): Hex {
    const number = this.head + 1n;
    const blockHash = this.nextHash('block');
    const transactionHash = input.txHash ?? this.nextHash('tx');
    const topics = encodeEventTopics({ abi: SETTLEMENT_EVENTS, eventName: 'OrderFunded', args: { paymentRef: input.reference, payer: input.payer, token: input.token } }) as Hex[];
    const data = encodeAbiParameters([{ type: 'uint256' }], [input.amount]);
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

  /**
   * Simulated settlement contract `release`: signer, chain, contract and expiry checks, single-use nonce, and one
   * successful payout per payout reference (a second one reports ALREADY_RELEASED with the original transaction).
   */
  async executeRelease(signed: import('./authorization').SignedRelease): Promise<{ txHash: Hex }> {
    this.guard();
    const { getReleaseSigner, verifyReleaseSignature } = await import('./authorization');
    if (!this.settlement) throw new PayoutRejectedError('CONTRACT_NOT_DEPLOYED');
    try {
      await verifyReleaseSignature(signed, { chainId: this.chainId, contract: this.settlement, signer: getReleaseSigner().address, now: BigInt(Math.floor(Date.now() / 1000)) });
    } catch (error) {
      throw new PayoutRejectedError(error instanceof Error ? error.message : 'BAD_SIGNATURE');
    }
    if (this.usedNonces.has(signed.message.nonce)) throw new PayoutRejectedError('NONCE_USED');
    const previous = this.releasedPayouts.get(signed.message.payoutRef);
    if (previous) throw new PayoutRejectedError(`ALREADY_RELEASED:${previous}`);
    this.usedNonces.add(signed.message.nonce);
    if (this.failingTokens.has(signed.message.token.toLowerCase())) throw new PayoutRejectedError('TOKEN_TRANSFER_FAILED');
    const txHash = this.nextHash('release');
    this.releasedPayouts.set(signed.message.payoutRef, txHash);
    this.transfers.push({ payoutRef: signed.message.payoutRef, recipient: signed.message.recipient, token: signed.message.token, amount: signed.message.amount, txHash });
    this.mine(1);
    return { txHash };
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

/** JSON-RPC reader for a verified TESTNET network. Not exercised here: no network access was authorized. */
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
  if (String(network.mode) === 'LOCAL') {
    if (!localChainsEnabled()) throw new ChainUnavailableError('Local devnet is disabled in this environment');
    const settlement = network.settlement_address ? (String(network.settlement_address).toLowerCase() as Hex) : null;
    if (!localChains.has(chainId)) localChains.set(chainId, new LocalDevChain(chainId, settlement));
    const local = localChains.get(chainId)!;
    // A chain first created without the network row (dev wallet simulator) learns its contract address later.
    if (!local.settlement && settlement) local.settlement = settlement;
    return local;
  }
  const rpcUrl = process.env[`CHAIN_RPC_URL_${chainId}`];
  if (String(network.mode) === 'TESTNET' && rpcUrl) return createRpcChainReader(chainId, rpcUrl);
  throw new ChainUnavailableError('No verified RPC is configured for this network');
}

/** Payout execution needs custody; only the local devnet simulator can execute releases in this repository. */
export function getPayoutAdapter(network: Record<string, unknown>): ChainPayoutAdapter {
  const reader = getChainReader(network);
  if ('executeRelease' in reader) return reader as unknown as ChainPayoutAdapter;
  throw new ChainUnavailableError('No custody/payout adapter is configured for this network');
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
