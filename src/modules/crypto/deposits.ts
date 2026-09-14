/**
 * On-chain deposit verification (master §11.4; CRY-02/03/04/05). The client may point at a transaction, but only
 * the chain reader's receipt, the network's settlement address, the registry asset, the intent reference, the exact
 * amount and finality decide. Each chain event identity (chain, tx, log index) is recorded once.
 */
import { decodeEventLog, type Hex } from 'viem';
import { CommandError, UUID_PATTERN, type Row, type Tx } from '@/lib/commands';
import { sql } from '@/lib/db';
import { applyChainFunding, openCase } from '@/modules/payments/funding';
import { SETTLEMENT_EVENTS } from './abi';
import { ChainUnavailableError, getChainReader, type ChainLog, type ChainReader, type ChainReceipt } from './chain';
import { TX_HASH_PATTERN, assetForToken, atomicToUsdMinor, escrowReference, formatAtomic } from './registry';

export type DepositResult = {
  status: 'NOT_FOUND' | 'REJECTED' | 'PENDING_FINALITY' | 'CREDITED' | 'DUPLICATE' | 'REORGED';
  reason?: string;
  log_index?: number;
  order_id?: string;
  funding?: string;
};

type SettlementEvent = { log: ChainLog; escrowRef: Hex; reference: Hex; payer: Hex; token: Hex; amount: bigint };

function decodeFunded(log: ChainLog): { escrowRef: Hex; reference: Hex; payer: Hex; token: Hex; amount: bigint } | null {
  try {
    const decoded = decodeEventLog({ abi: SETTLEMENT_EVENTS, eventName: 'Funded', data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    const args = decoded.args as { escrowRef: Hex; paymentRef: Hex; payer: Hex; token: Hex; amount: bigint } | undefined;
    return args ? { escrowRef: args.escrowRef, reference: args.paymentRef, payer: args.payer, token: args.token, amount: args.amount } : null;
  } catch {
    return null;
  }
}

function decodeSettlementLogs(receipt: ChainReceipt, settlement: string): { events: SettlementEvent[]; untrusted: number } {
  const events: SettlementEvent[] = [];
  let untrusted = 0;
  for (const log of receipt.logs) {
    const args = decodeFunded(log);
    if (!args) continue;
    if (log.address.toLowerCase() !== settlement) {
      untrusted += 1;
      continue;
    }
    events.push({ log, escrowRef: args.escrowRef.toLowerCase() as Hex, reference: args.reference.toLowerCase() as Hex, payer: args.payer.toLowerCase() as Hex, token: args.token.toLowerCase() as Hex, amount: args.amount });
  }
  return { events, untrusted };
}

async function recordRejection(tx: Tx, network: Row, event: SettlementEvent, intent: Row | undefined, asset: Row | undefined, reason: string): Promise<DepositResult> {
  const chainId = Number(network.chain_id);
  const recorded = await tx`insert into app.chain_deposits (chain_id,tx_hash,log_index,block_number,block_hash,emitter,token_address,asset_id,payer,amount_atomic,escrow_ref,reference,intent_id,status,reason)
    values (${chainId},${event.log.transactionHash.toLowerCase()},${event.log.logIndex},${event.log.blockNumber.toString()},${event.log.blockHash.toLowerCase()},${event.log.address.toLowerCase()},
      ${event.token},${asset?.id ?? null},${event.payer},${event.amount.toString()},${event.escrowRef},${event.reference},${intent?.id ?? null},'REJECTED',${reason})
    on conflict (chain_id,tx_hash,log_index) do nothing returning id`;
  const orderId = intent ? String(intent.order_id) : null;
  if (intent && ['AWAITING_DEPOSIT', 'PENDING_FINALITY'].includes(String(intent.status))) {
    await tx`update app.crypto_payment_intents set status='EXCEPTION',status_reason=${reason},updated_at=now() where id=${String(intent.id)}`;
  }
  // Funds that reached the settlement address but cannot be credited always get an operator case (refund path).
  const nextAction = `${reason}: tx ${event.log.transactionHash} log ${event.log.logIndex}; verify on chain and refund to the payer if owed`;
  if (intent) await openCase(tx, orderId, null, 'CRYPTO_DEPOSIT_EXCEPTION', 'HIGH', nextAction);
  // Unmatched deposits have no order to group by, so each newly recorded deposit gets its own case.
  else if (recorded.length) await tx`insert into app.reconciliation_cases (order_id,provider_operation_id,kind,severity,next_action) values (null,null,'UNMATCHED_CHAIN_DEPOSIT','HIGH',${nextAction})`;
  return { status: 'REJECTED', reason, log_index: event.log.logIndex, ...(orderId ? { order_id: orderId } : {}) };
}

async function processEvent(network: Row, event: SettlementEvent, head: bigint, reader: ChainReader): Promise<DepositResult> {
  const chainId = Number(network.chain_id);
  const txHash = event.log.transactionHash.toLowerCase();
  return sql.begin(async (tx) => {
    const [intentRef] = await tx<Row[]>`select id from app.crypto_payment_intents where reference=${event.reference}`;
    const [intent] = intentRef ? await tx<Row[]>`select * from app.crypto_payment_intents where id=${String(intentRef.id)} for update` : [];
    const [existing] = await tx<Row[]>`select * from app.chain_deposits where chain_id=${chainId} and tx_hash=${txHash} and log_index=${event.log.logIndex} for update`;
    if (existing && ['CREDITED', 'REJECTED', 'REORGED'].includes(String(existing.status))) {
      return { status: existing.status === 'CREDITED' ? 'DUPLICATE' : existing.status, reason: existing.reason ?? undefined, log_index: event.log.logIndex } as DepositResult;
    }
    const asset = await assetForToken(tx, chainId, event.token);
    if (!asset || !asset.allowlisted) return recordRejection(tx, network, event, intent, asset, 'UNSUPPORTED_ASSET');
    if (!intent) {
      const [poolRef] = await tx<Row[]>`select id from app.pool_funding_intents where reference=${event.reference}`;
      if (poolRef) return processPoolDeposit(tx, network, event, head, reader, String(poolRef.id), asset, existing);
      return recordRejection(tx, network, event, undefined, asset, 'UNKNOWN_REFERENCE');
    }
    const [expected] = await tx<Row[]>`select * from app.chain_assets where id=${String(intent.asset_id)}`;
    if (Number(intent.chain_id) !== chainId) return recordRejection(tx, network, event, intent, asset, 'WRONG_CHAIN');
    // The deposit must sit in this order's escrow bucket, or releases for the order could never draw on it.
    if (event.escrowRef !== escrowReference('order', String(intent.order_id))) return recordRejection(tx, network, event, intent, asset, 'WRONG_ESCROW');
    // Interfaces of one balance share balance_key and decimals; anything else is the wrong asset. One credit per intent.
    if (expected!.balance_key !== asset.balance_key || Number(expected!.decimals) !== Number(asset.decimals)) return recordRejection(tx, network, event, intent, asset, 'WRONG_ASSET');
    const wanted = BigInt(String(intent.amount_atomic));
    if (event.amount < wanted) return recordRejection(tx, network, event, intent, asset, 'UNDERPAID');
    if (event.amount > wanted) return recordRejection(tx, network, event, intent, asset, 'OVERPAID');
    if (intent.payer_wallet_id) {
      const [wallet] = await tx<Row[]>`select address from app.wallets where id=${String(intent.payer_wallet_id)}`;
      if (wallet && String(wallet.address) !== event.payer) return recordRejection(tx, network, event, intent, asset, 'WRONG_SENDER');
    }
    const [credited] = await tx<Row[]>`select id from app.chain_deposits where intent_id=${String(intent.id)} and status='CREDITED'`;
    if (credited) return recordRejection(tx, network, event, intent, asset, 'DUPLICATE_PAYMENT');

    const confirmations = head - event.log.blockNumber + 1n;
    const canonical = (await reader.getBlockHash(event.log.blockNumber))?.toLowerCase() === event.log.blockHash.toLowerCase();
    if (!canonical || confirmations < BigInt(network.finality_confirmations)) {
      if (existing) {
        await tx`update app.chain_deposits set block_number=${event.log.blockNumber.toString()},block_hash=${event.log.blockHash.toLowerCase()},updated_at=now() where id=${String(existing.id)}`;
      } else {
        await tx`insert into app.chain_deposits (chain_id,tx_hash,log_index,block_number,block_hash,emitter,token_address,asset_id,payer,amount_atomic,escrow_ref,reference,intent_id,status)
          values (${chainId},${txHash},${event.log.logIndex},${event.log.blockNumber.toString()},${event.log.blockHash.toLowerCase()},${event.log.address.toLowerCase()},
            ${event.token},${String(asset.id)},${event.payer},${event.amount.toString()},${event.escrowRef},${event.reference},${String(intent.id)},'PENDING_FINALITY')`;
      }
      if (intent.status === 'AWAITING_DEPOSIT') await tx`update app.crypto_payment_intents set status='PENDING_FINALITY',updated_at=now() where id=${String(intent.id)}`;
      return { status: 'PENDING_FINALITY', reason: `${confirmations < 0n ? 0n : confirmations}/${network.finality_confirmations} confirmations`, log_index: event.log.logIndex, order_id: String(intent.order_id) };
    }

    const amountMinor = atomicToUsdMinor(event.amount, Number(asset.decimals));
    if (amountMinor === null) return recordRejection(tx, network, event, intent, asset, 'NOT_CENT_EXACT');
    const funding = await applyChainFunding(tx, {
      orderId: String(intent.order_id), amountMinor, chainId, networkMode: String(network.mode), txHash, logIndex: event.log.logIndex,
      assetSymbol: String(asset.symbol), amountAtomic: event.amount.toString(),
    });
    if (existing) {
      await tx`update app.chain_deposits set status='CREDITED',credited_at=now(),asset_id=${String(asset.id)},intent_id=${String(intent.id)},
        block_number=${event.log.blockNumber.toString()},block_hash=${event.log.blockHash.toLowerCase()},updated_at=now() where id=${String(existing.id)}`;
    } else {
      await tx`insert into app.chain_deposits (chain_id,tx_hash,log_index,block_number,block_hash,emitter,token_address,asset_id,payer,amount_atomic,escrow_ref,reference,intent_id,status,credited_at)
        values (${chainId},${txHash},${event.log.logIndex},${event.log.blockNumber.toString()},${event.log.blockHash.toLowerCase()},${event.log.address.toLowerCase()},
          ${event.token},${String(asset.id)},${event.payer},${event.amount.toString()},${event.escrowRef},${event.reference},${String(intent.id)},'CREDITED',now())`;
    }
    await tx`update app.crypto_payment_intents set status=${funding === 'FUNDED' ? 'CONFIRMED' : 'EXCEPTION'},status_reason=${funding === 'FUNDED' ? null : funding},updated_at=now() where id=${String(intent.id)}`;
    return { status: 'CREDITED', log_index: event.log.logIndex, order_id: String(intent.order_id), funding, reason: `${formatAtomic(event.amount, Number(asset.decimals))} ${asset.symbol}` };
  });
}

/** Campaign pool funding (W5-C2): exact asset and amount, finality, then one DEPOSIT movement into the pool buckets. */
async function processPoolDeposit(tx: Tx, network: Row, event: SettlementEvent, head: bigint, reader: ChainReader, poolIntentId: string, asset: Row, existing: Row | undefined): Promise<DepositResult> {
  const chainId = Number(network.chain_id);
  const txHash = event.log.transactionHash.toLowerCase();
  const [intent] = await tx<Row[]>`select i.*,pa.asset_id,pa.pool_id from app.pool_funding_intents i join app.pool_assets pa on pa.id=i.pool_asset_id where i.id=${poolIntentId} for update of i`;
  const reject = async (reason: string): Promise<DepositResult> => {
    await tx`insert into app.chain_deposits (chain_id,tx_hash,log_index,block_number,block_hash,emitter,token_address,asset_id,payer,amount_atomic,escrow_ref,reference,pool_intent_id,status,reason)
      values (${chainId},${txHash},${event.log.logIndex},${event.log.blockNumber.toString()},${event.log.blockHash.toLowerCase()},${event.log.address.toLowerCase()},
        ${event.token},${String(asset.id)},${event.payer},${event.amount.toString()},${event.escrowRef},${event.reference},${poolIntentId},'REJECTED',${reason})
      on conflict (chain_id,tx_hash,log_index) do nothing`;
    if (['AWAITING_DEPOSIT', 'PENDING_FINALITY'].includes(String(intent!.status))) {
      await tx`update app.pool_funding_intents set status='EXCEPTION',status_reason=${reason},updated_at=now() where id=${poolIntentId}`;
    }
    await openCase(tx, null, null, 'POOL_DEPOSIT_EXCEPTION', 'HIGH', `${reason}: pool ${intent!.pool_id} tx ${event.log.transactionHash} log ${event.log.logIndex}; refund the payer if owed`);
    return { status: 'REJECTED', reason, log_index: event.log.logIndex };
  };
  if (Number(intent!.chain_id) !== chainId) return reject('WRONG_CHAIN');
  if (event.escrowRef !== escrowReference('pool', `${String(intent!.pool_id)}:${String(intent!.pool_asset_id)}`)) return reject('WRONG_ESCROW');
  if (String(intent!.asset_id) !== String(asset.id)) return reject('WRONG_ASSET');
  const wanted = BigInt(String(intent!.amount_atomic));
  if (event.amount < wanted) return reject('UNDERPAID');
  if (event.amount > wanted) return reject('OVERPAID');
  const [credited] = await tx<Row[]>`select id from app.chain_deposits where pool_intent_id=${poolIntentId} and status='CREDITED'`;
  if (credited) return reject('DUPLICATE_PAYMENT');
  const confirmations = head - event.log.blockNumber + 1n;
  const canonical = (await reader.getBlockHash(event.log.blockNumber))?.toLowerCase() === event.log.blockHash.toLowerCase();
  if (!canonical || confirmations < BigInt(network.finality_confirmations)) {
    if (!existing) {
      await tx`insert into app.chain_deposits (chain_id,tx_hash,log_index,block_number,block_hash,emitter,token_address,asset_id,payer,amount_atomic,escrow_ref,reference,pool_intent_id,status)
        values (${chainId},${txHash},${event.log.logIndex},${event.log.blockNumber.toString()},${event.log.blockHash.toLowerCase()},${event.log.address.toLowerCase()},
          ${event.token},${String(asset.id)},${event.payer},${event.amount.toString()},${event.escrowRef},${event.reference},${poolIntentId},'PENDING_FINALITY')`;
    }
    if (intent!.status === 'AWAITING_DEPOSIT') await tx`update app.pool_funding_intents set status='PENDING_FINALITY',updated_at=now() where id=${poolIntentId}`;
    return { status: 'PENDING_FINALITY', reason: `${confirmations < 0n ? 0n : confirmations}/${network.finality_confirmations} confirmations`, log_index: event.log.logIndex };
  }
  const { moveBalance, refreshPoolStatus } = await import('@/modules/pools/balances');
  await moveBalance(tx, String(intent!.pool_asset_id), 'DEPOSIT', event.amount, `deposit:${chainId}:${txHash}:${event.log.logIndex}`);
  if (existing) {
    await tx`update app.chain_deposits set status='CREDITED',credited_at=now(),pool_intent_id=${poolIntentId},asset_id=${String(asset.id)},updated_at=now() where id=${String(existing.id)}`;
  } else {
    await tx`insert into app.chain_deposits (chain_id,tx_hash,log_index,block_number,block_hash,emitter,token_address,asset_id,payer,amount_atomic,escrow_ref,reference,pool_intent_id,status,credited_at)
      values (${chainId},${txHash},${event.log.logIndex},${event.log.blockNumber.toString()},${event.log.blockHash.toLowerCase()},${event.log.address.toLowerCase()},
        ${event.token},${String(asset.id)},${event.payer},${event.amount.toString()},${event.escrowRef},${event.reference},${poolIntentId},'CREDITED',now())`;
  }
  await tx`update app.pool_funding_intents set status='CONFIRMED',status_reason=null,updated_at=now() where id=${poolIntentId}`;
  const poolStatus = await refreshPoolStatus(tx, String(intent!.pool_id));
  return { status: 'CREDITED', log_index: event.log.logIndex, funding: `POOL_${poolStatus}`, reason: `${formatAtomic(event.amount, Number(asset.decimals))} ${asset.symbol}` };
}

async function networkRow(chainId: number): Promise<Row> {
  const [network] = await sql<Row[]>`select * from app.chain_networks where chain_id=${chainId} and enabled`;
  if (!network) throw new CommandError('This network is not enabled for payments', 'FEATURE_DISABLED');
  return network;
}

/** Verifies every settlement event in one transaction. A hash that is not on this chain changes nothing. */
export async function verifyChainTransaction(chainId: number, txHash: string): Promise<DepositResult[]> {
  if (!TX_HASH_PATTERN.test(txHash)) throw new CommandError('Enter a valid transaction hash');
  const network = await networkRow(chainId);
  const reader = getChainReader(network);
  try {
    const receipt = await reader.getTransactionReceipt(txHash as Hex);
    if (!receipt) return [{ status: 'NOT_FOUND', reason: `Transaction not found on ${network.name} (chain ${chainId})` }];
    if (receipt.status !== 'success') return [{ status: 'REJECTED', reason: 'TX_REVERTED' }];
    const { events, untrusted } = decodeSettlementLogs(receipt, String(network.settlement_address));
    if (!events.length) return [{ status: 'REJECTED', reason: untrusted ? 'EVENT_FROM_UNTRUSTED_CONTRACT' : 'NO_SETTLEMENT_EVENT' }];
    const head = await reader.getBlockNumber();
    const results: DepositResult[] = [];
    for (const event of events) results.push(await processEvent(network, event, head, reader));
    return results;
  } catch (error) {
    if (error instanceof ChainUnavailableError) throw new CommandError('The chain node is unavailable; the deposit will be checked again automatically', 'TEMPORARILY_UNAVAILABLE');
    throw error;
  }
}

/** Buyer-facing check: the hint must belong to the buyer's own intent; the chain still decides. */
export async function verifyDepositForBuyer(buyerId: string, intentId: string, txHash: string): Promise<DepositResult[]> {
  if (!UUID_PATTERN.test(intentId)) throw new CommandError('Payment not found', 'NOT_FOUND');
  const [intent] = await sql<Row[]>`select chain_id from app.crypto_payment_intents where id=${intentId} and buyer_id=${buyerId}`;
  if (!intent) throw new CommandError('Payment not found', 'NOT_FOUND');
  return verifyChainTransaction(Number(intent.chain_id), txHash);
}

export type IndexerReport = { chain_id: number; scanned_to: string | null; transactions: number; outcomes: Record<string, number>; error?: string };

/**
 * Indexer (CRY-05): scans settlement logs after the checkpoint and advances it only when every transaction in the
 * range was processed. An RPC outage leaves the checkpoint where it was; replays are idempotent.
 */
export async function scanChainDeposits(chainId: number, options: { maxBlocks?: bigint } = {}): Promise<IndexerReport> {
  const report: IndexerReport = { chain_id: chainId, scanned_to: null, transactions: 0, outcomes: {} };
  const network = await networkRow(chainId);
  const reader = getChainReader(network);
  try {
    const head = await reader.getBlockNumber();
    const [checkpoint] = await sql<Row[]>`select last_scanned_block from app.chain_checkpoints where chain_id=${chainId}`;
    const from = checkpoint ? BigInt(checkpoint.last_scanned_block) + 1n : 0n;
    if (from > head) return { ...report, scanned_to: String(head) };
    const to = options.maxBlocks ? (from + options.maxBlocks - 1n < head ? from + options.maxBlocks - 1n : head) : head;
    const logs = await reader.getLogs({ address: String(network.settlement_address) as Hex, fromBlock: from, toBlock: to });
    const hashes = [...new Set(logs.map((log) => log.transactionHash.toLowerCase()))];
    for (const hash of hashes) {
      for (const result of await verifyChainTransaction(chainId, hash)) report.outcomes[result.status] = (report.outcomes[result.status] ?? 0) + 1;
      report.transactions += 1;
    }
    await sql`insert into app.chain_checkpoints (chain_id,last_scanned_block) values (${chainId},${to.toString()})
      on conflict (chain_id) do update set last_scanned_block=greatest(app.chain_checkpoints.last_scanned_block, excluded.last_scanned_block),updated_at=now()`;
    return { ...report, scanned_to: to.toString() };
  } catch (error) {
    if (error instanceof ChainUnavailableError || (error instanceof CommandError && error.code === 'TEMPORARILY_UNAVAILABLE')) return { ...report, error: 'RPC_UNAVAILABLE' };
    throw error;
  }
}

/** Pending deposits: credit once final, or mark REORGED when the block or transaction is no longer canonical. */
export async function recheckPendingDeposits(chainId: number): Promise<IndexerReport> {
  const report: IndexerReport = { chain_id: chainId, scanned_to: null, transactions: 0, outcomes: {} };
  const network = await networkRow(chainId);
  const reader = getChainReader(network);
  const pending = await sql<Row[]>`select * from app.chain_deposits where chain_id=${chainId} and status='PENDING_FINALITY' order by block_number limit 200`;
  try {
    for (const deposit of pending) {
      report.transactions += 1;
      const receipt = await reader.getTransactionReceipt(deposit.tx_hash as Hex);
      if (!receipt) {
        await sql.begin(async (tx) => {
          const [row] = await tx<Row[]>`update app.chain_deposits set status='REORGED',reason='Transaction no longer on the canonical chain',updated_at=now()
            where id=${String(deposit.id)} and status='PENDING_FINALITY' returning intent_id,pool_intent_id`;
          if (row?.intent_id) {
            await tx`update app.crypto_payment_intents set status='AWAITING_DEPOSIT',status_reason='Previous deposit was reorganized away',updated_at=now()
              where id=${String(row.intent_id)} and status='PENDING_FINALITY'`;
          }
          if (row?.pool_intent_id) {
            await tx`update app.pool_funding_intents set status='AWAITING_DEPOSIT',status_reason='Previous deposit was reorganized away',updated_at=now()
              where id=${String(row.pool_intent_id)} and status='PENDING_FINALITY'`;
          }
        });
        report.outcomes.REORGED = (report.outcomes.REORGED ?? 0) + 1;
        continue;
      }
      for (const result of await verifyChainTransaction(chainId, String(deposit.tx_hash))) report.outcomes[result.status] = (report.outcomes[result.status] ?? 0) + 1;
    }
    return report;
  } catch (error) {
    if (error instanceof ChainUnavailableError || (error instanceof CommandError && error.code === 'TEMPORARILY_UNAVAILABLE')) return { ...report, error: 'RPC_UNAVAILABLE' };
    throw error;
  }
}
