/**
 * Campaign pools (master §11.5; P4-07/08). Buyer funds once per asset; each accepted hire allocates the reward
 * template atomically and its order is funded from the allocation; approval releases each allocation exactly once
 * with a server authorization; unused balance is refundable; perks become unique entitlements.
 *
 * Payout execution runs through the chain payout adapter inside the transaction. That is acceptable only for the
 * in-process devnet simulator; a real network needs an outbox worker (NOT IMPLEMENTED) before any testnet use.
 */
import { randomUUID } from 'node:crypto';
import type { Hex } from 'viem';
import type { Actor } from '@/lib/auth';
import { CommandError, UUID_PATTERN, type Row, type Tx } from '@/lib/commands';
import { sql } from '@/lib/db';
import { NATIVE_TOKEN } from '@/modules/crypto/abi';
import { bytes32Of, newNonce, releaseDomain, signRelease, type SignedRelease } from '@/modules/crypto/authorization';
import { ChainUnavailableError, PayoutRejectedError, getChainReader, getPayoutAdapter } from '@/modules/crypto/chain';
import { enabledNetwork, formatAtomic, parseDecimalToAtomic, settlementReference } from '@/modules/crypto/registry';
import { PaymentFlowError, openCase } from '@/modules/payments/funding';
import { moveBalance, refreshPoolStatus } from './balances';
import { cashMinorOf, moneyItems, validateTemplate, type TemplateItem } from './template';

const AUTHORIZATION_TTL_SECONDS = 15 * 60;

async function lockPool(tx: Tx, poolId: string): Promise<Row> {
  const [pool] = await tx<Row[]>`select * from app.campaign_pools where id=${poolId} for update`;
  if (!pool) throw new CommandError('Campaign pool not found', 'NOT_FOUND');
  return pool;
}

async function latestTemplate(tx: Tx, poolId: string): Promise<{ version: number; items: TemplateItem[] }> {
  const [template] = await tx<Row[]>`select version,items from app.pool_templates where pool_id=${poolId} order by version desc limit 1`;
  return { version: Number(template!.version), items: template!.items as TemplateItem[] };
}

/** Targets = required per-hire amounts × hires; optional assets are tracked with target 0. */
async function syncPoolAssets(tx: Tx, poolId: string, items: TemplateItem[], targetHires: number) {
  const totals = new Map<string, { required: boolean; target: bigint }>();
  for (const item of moneyItems(items)) {
    const current = totals.get(item.asset_id) ?? { required: false, target: 0n };
    if (item.required) {
      current.required = true;
      current.target += BigInt(item.amount_atomic) * BigInt(targetHires);
    }
    totals.set(item.asset_id, current);
  }
  for (const [assetId, { required, target }] of totals) {
    await tx`insert into app.pool_assets (pool_id,asset_id,required,target_atomic) values (${poolId},${assetId},${required},${target.toString()})
      on conflict (pool_id,asset_id) do update set required=excluded.required,target_atomic=excluded.target_atomic,updated_at=now()`;
  }
  await tx`update app.pool_assets set required=false,target_atomic=0,updated_at=now() where pool_id=${poolId} and not (asset_id = any(${[...totals.keys()]}::uuid[]))`;
}

export async function createCampaignPool(tx: Tx, actor: Actor, input: { requestId: string; chainId: number; items: unknown }) {
  const [request] = await tx<Row[]>`select * from app.requests where id=${input.requestId} for update`;
  if (!request || String(request.buyer_id) !== actor.id) throw new CommandError('Request not found or not owned by this account', 'NOT_FOUND');
  if (request.status !== 'OPEN') throw new CommandError('Only an open request can get a campaign pool', 'REQUEST_CLOSED');
  const [activity] = await tx<Row[]>`select 1 from app.applications where request_id=${input.requestId} union all select 1 from app.hire_offers where request_id=${input.requestId} limit 1`;
  if (activity) throw new CommandError('Add the pool before creators apply; quotes must match the pool reward', 'ORDER_STATE_CONFLICT');
  const [existing] = await tx<Row[]>`select id from app.campaign_pools where request_id=${input.requestId}`;
  if (existing) throw new CommandError('This request already has a campaign pool', 'ORDER_STATE_CONFLICT');
  await enabledNetwork(tx, input.chainId);
  const template = await validateTemplate(tx, input.chainId, input.items);
  if (request.per_creator_cap_minor != null && template.cashMinor > BigInt(request.per_creator_cap_minor)) throw new CommandError('The CASH reward exceeds the per-creator cap', 'BUDGET_EXCEEDED');
  if (template.cashMinor * BigInt(request.target_hires) > BigInt(request.budget_minor)) throw new CommandError('CASH rewards for every hire exceed the request budget', 'BUDGET_EXCEEDED');
  const id = randomUUID();
  await tx`insert into app.campaign_pools (id,request_id,owner_id,chain_id) values (${id},${input.requestId},${actor.id},${input.chainId})`;
  await tx`insert into app.pool_templates (pool_id,version,items,created_by) values (${id},1,${JSON.stringify(template.items)}::jsonb,${actor.id})`;
  await syncPoolAssets(tx, id, template.items, Number(request.target_hires));
  return { id, cashMinor: template.cashMinor };
}

/** A new template version applies to hires accepted after it; accepted allocations keep their version (§11.6). */
export async function updatePoolTemplate(tx: Tx, actor: Actor, poolId: string, rawItems: unknown) {
  const pool = await lockPool(tx, poolId);
  if (String(pool.owner_id) !== actor.id) throw new CommandError('Campaign pool not found', 'NOT_FOUND');
  if (pool.status === 'CLOSED') throw new CommandError('This pool is closed', 'REQUEST_CLOSED');
  const template = await validateTemplate(tx, Number(pool.chain_id), rawItems);
  const [request] = await tx<Row[]>`select target_hires from app.requests where id=${String(pool.request_id)}`;
  const version = Number(pool.template_version) + 1;
  await tx`insert into app.pool_templates (pool_id,version,items,created_by) values (${poolId},${version},${JSON.stringify(template.items)}::jsonb,${actor.id})`;
  await tx`update app.campaign_pools set template_version=${version} where id=${poolId}`;
  await syncPoolAssets(tx, poolId, template.items, Number(request!.target_hires));
  await refreshPoolStatus(tx, poolId);
  return version;
}

export async function createPoolFundingIntent(tx: Tx, actor: Actor, input: { poolId: string; assetId: string; amount: string }) {
  const pool = await lockPool(tx, input.poolId);
  if (String(pool.owner_id) !== actor.id) throw new CommandError('Campaign pool not found', 'NOT_FOUND');
  if (pool.status === 'CLOSED') throw new CommandError('This pool is closed', 'REQUEST_CLOSED');
  const network = await enabledNetwork(tx, Number(pool.chain_id));
  // Validate ids before querying: a failed cast would abort the surrounding PostgreSQL transaction.
  const [poolAsset] = UUID_PATTERN.test(input.assetId)
    ? await tx<Row[]>`select pa.id,a.decimals,a.symbol from app.pool_assets pa join app.chain_assets a on a.id=pa.asset_id where pa.pool_id=${input.poolId} and pa.asset_id=${input.assetId}`
    : [];
  if (!poolAsset) throw new CommandError('This asset is not part of the pool template', 'UNSUPPORTED_ASSET');
  let amount: bigint;
  try {
    amount = parseDecimalToAtomic(input.amount, Number(poolAsset.decimals));
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : 'Invalid amount');
  }
  if (amount <= 0n) throw new CommandError('Amount must be positive');
  const id = randomUUID();
  await tx`insert into app.pool_funding_intents (id,pool_id,pool_asset_id,buyer_id,chain_id,network_mode,amount_atomic,recipient,reference)
    values (${id},${input.poolId},${String(poolAsset.id)},${actor.id},${Number(pool.chain_id)},${String(network.mode)},${amount.toString()},${String(network.settlement_address)},
      ${settlementReference(`pool:${input.poolId}`, id)})`;
  return { id, display: `${formatAtomic(amount, Number(poolAsset.decimals))} ${poolAsset.symbol}` };
}

async function activeWallet(tx: Tx, userId: string, chainId: number): Promise<string | null> {
  const [wallet] = await tx<Row[]>`select address from app.wallets where user_id=${userId} and chain_id=${chainId} and revoked_at is null order by verified_at desc limit 1`;
  return wallet ? String(wallet.address) : null;
}

/** The current reward template of a request's pool, for quote checks and order terms; null without a pool. */
export async function poolTermsFor(tx: Tx, requestId: string): Promise<{ poolId: string; templateVersion: number; cashMinor: bigint; items: TemplateItem[]; status: string } | null> {
  const [pool] = await tx<Row[]>`select id,status from app.campaign_pools where request_id=${requestId}`;
  if (!pool) return null;
  const template = await latestTemplate(tx, String(pool.id));
  return { poolId: String(pool.id), templateVersion: template.version, cashMinor: cashMinorOf(template.items), items: template.items, status: String(pool.status) };
}

export type HireAllocation = { poolId: string; templateVersion: number; cashMinor: bigint; allocated: string[]; skippedOptional: string[] };

/**
 * Called by accept_offer after the order row exists. Locks the pool's asset rows in id order and allocates every
 * required item or nothing (CRY-06/07); optional items are allocated only when available.
 */
export async function allocateHire(tx: Tx, input: { requestId: string; orderId: string; offerAmountMinor: bigint; creatorId: string }): Promise<HireAllocation | null> {
  const [poolRef] = await tx<Row[]>`select id from app.campaign_pools where request_id=${input.requestId}`;
  if (!poolRef) return null;
  const pool = await lockPool(tx, String(poolRef.id));
  if (pool.status === 'CLOSED') throw new CommandError('The campaign pool is closed', 'REQUEST_CLOSED');
  const template = await latestTemplate(tx, String(pool.id));
  const cashMinor = cashMinorOf(template.items);
  if (cashMinor !== input.offerAmountMinor) throw new CommandError('The pool reward changed since this offer; the buyer must offer again', 'QUOTE_CHANGED');
  if (!(await activeWallet(tx, input.creatorId, Number(pool.chain_id)))) {
    throw new CommandError('Link a verified wallet on the pool network to accept pool-funded work', 'DOMAIN_RULE');
  }
  const assets = await tx<Row[]>`select * from app.pool_assets where pool_id=${String(pool.id)} order by id for update`;
  const byAsset = new Map(assets.map((row) => [String(row.asset_id), row]));
  const allocated: string[] = [];
  const skippedOptional: string[] = [];
  const available = new Map(assets.map((row) => [String(row.id), BigInt(String(row.unallocated))]));
  for (const item of moneyItems(template.items)) {
    const poolAsset = byAsset.get(item.asset_id)!;
    const amount = BigInt(item.amount_atomic);
    const left = available.get(String(poolAsset.id))!;
    if (left < amount) {
      if (item.required) throw new CommandError(`The pool is missing ${formatAtomic(amount - left, item.decimals)} ${item.symbol} for the required "${item.key}" reward`, 'BUDGET_EXCEEDED');
      skippedOptional.push(item.key);
      continue;
    }
    available.set(String(poolAsset.id), left - amount);
    const [allocation] = await tx<Row[]>`insert into app.pool_allocations (pool_id,pool_asset_id,order_id,template_version,item_key,kind,required,amount_atomic)
      values (${String(pool.id)},${String(poolAsset.id)},${input.orderId},${template.version},${item.key},${item.kind},${item.required},${amount.toString()}) returning id`;
    await moveBalance(tx, String(poolAsset.id), 'ALLOCATE', amount, `allocation:${allocation!.id}`);
    allocated.push(item.key);
  }
  for (const item of template.items) {
    if (item.kind !== 'PERK') continue;
    await tx`insert into app.reward_entitlements (pool_id,order_id,template_version,item_key,kind,perk_type,description,fulfillment_method,required,deadline_at)
      values (${String(pool.id)},${input.orderId},${template.version},${item.key},${item.perk_type === 'NFT' ? 'NFT' : 'PERK'},${item.perk_type},${item.description},
        ${item.fulfillment_method},${item.required},now() + (${item.deadline_days} * interval '1 day'))`;
  }
  return { poolId: String(pool.id), templateVersion: template.version, cashMinor, allocated, skippedOptional };
}

/** Full refund of a pool-funded order before work: allocations return to unallocated; entitlements are cancelled. */
export async function returnPoolAllocations(tx: Tx, orderId: string): Promise<number> {
  const allocations = await tx<Row[]>`select * from app.pool_allocations where order_id=${orderId} and state='ACTIVE' order by pool_asset_id for update`;
  const [inFlight] = await tx<Row[]>`select 1 from app.pool_allocations where order_id=${orderId} and state in ('RELEASE_PENDING','RELEASED') limit 1`;
  if (inFlight) throw new PaymentFlowError('Part of this pool reward was already released; resolve through operators', 'INVALID_STATE');
  for (const allocation of allocations) {
    await moveBalance(tx, String(allocation.pool_asset_id), 'DEALLOCATE', BigInt(String(allocation.amount_atomic)), `allocation:${allocation.id}`);
    await tx`update app.pool_allocations set state='CANCELLED',updated_at=now() where id=${String(allocation.id)}`;
  }
  await tx`update app.reward_entitlements set status='CANCELLED' where order_id=${orderId} and status='PENDING'`;
  if (allocations[0]) await refreshPoolStatus(tx, String(allocations[0].pool_id));
  return allocations.length;
}

async function executePayout(tx: Tx, network: Row, kind: 'ALLOCATION' | 'POOL_REFUND', payout: { id: string; orderRef: string; recipient: string; token: string; amount: bigint }) {
  const nonce = newNonce();
  const expiry = BigInt(Math.floor(Date.now() / 1000) + AUTHORIZATION_TTL_SECONDS);
  const signed: SignedRelease = await signRelease(releaseDomain(Number(network.chain_id), String(network.settlement_address)), {
    payoutRef: bytes32Of(`${kind}:${payout.id}`), orderRef: bytes32Of(payout.orderRef), recipient: payout.recipient as Hex, token: payout.token as Hex, amount: payout.amount, nonce, expiry,
  });
  await tx`insert into app.release_authorizations (nonce,payout_kind,payout_id,chain_id,verifying_contract,recipient,token,amount_atomic,expires_at,signature)
    values (${nonce},${kind},${payout.id},${Number(network.chain_id)},${String(network.settlement_address)},${payout.recipient},${payout.token},${payout.amount.toString()},
      to_timestamp(${Number(expiry)}),${signed.signature})`;
  try {
    const { txHash } = await getPayoutAdapter(network).executeRelease(signed);
    await tx`update app.release_authorizations set consumed_at=now(),outcome='TRANSFERRED' where nonce=${nonce}`;
    return { ok: true as const, nonce, txHash: String(txHash) };
  } catch (error) {
    const code = error instanceof PayoutRejectedError ? error.code : error instanceof ChainUnavailableError ? 'RPC_UNAVAILABLE' : 'PAYOUT_ERROR';
    // The contract remembers released payout references; a lost success is reconciled instead of paid twice.
    if (code.startsWith('ALREADY_RELEASED:')) {
      await tx`update app.release_authorizations set consumed_at=now(),outcome='FAILED' where nonce=${nonce}`;
      return { ok: true as const, nonce, txHash: code.slice('ALREADY_RELEASED:'.length) };
    }
    await tx`update app.release_authorizations set consumed_at=now(),outcome='FAILED' where nonce=${nonce}`;
    return { ok: false as const, nonce, code };
  }
}

export type PoolSettlement = { requiredOutstanding: number; released: string[]; failed: { key: string; code: string }[] };

/** CRY-08: releases each still-active allocation once; a failed asset stays active for retry, released ones never repeat. */
export async function settlePoolAllocations(tx: Tx, order: Row): Promise<PoolSettlement> {
  const orderId = String(order.id);
  const allocations = await tx<Row[]>`select pa.*,a.kind as asset_kind,a.contract_address,pool.chain_id
    from app.pool_allocations pa join app.pool_assets ps on ps.id=pa.pool_asset_id join app.chain_assets a on a.id=ps.asset_id join app.campaign_pools pool on pool.id=pa.pool_id
    where pa.order_id=${orderId} order by pa.required desc, pa.id for update of pa`;
  if (!allocations.length) throw new PaymentFlowError('This pool-funded order has no allocations', 'INVALID_STATE');
  const chainId = Number(allocations[0]!.chain_id);
  const recipient = await activeWallet(tx, String(order.creator_id), chainId);
  if (!recipient) {
    await openCase(tx, orderId, null, 'NO_PAYOUT_WALLET', 'HIGH', 'The creator has no verified wallet on the pool network; ask them to link one, then retry settlement');
    throw new PaymentFlowError('The creator has no verified payout wallet on the pool network', 'UNAVAILABLE');
  }
  const [network] = await tx<Row[]>`select * from app.chain_networks where chain_id=${chainId} and enabled`;
  if (!network) throw new PaymentFlowError('The pool network is not enabled', 'UNAVAILABLE');
  const result: PoolSettlement = { requiredOutstanding: 0, released: [], failed: [] };
  for (const allocation of allocations) {
    if (allocation.state !== 'ACTIVE') continue;
    const amount = BigInt(String(allocation.amount_atomic));
    const id = String(allocation.id);
    const [attempt] = await tx<Row[]>`update app.pool_allocations set state='RELEASE_PENDING',attempts=attempts+1,updated_at=now() where id=${id} returning attempts`;
    // Value moves to pending_outflow before the payout is attempted, and leaves it exactly once afterwards.
    const reference = `release:${id}:${attempt!.attempts}`;
    await moveBalance(tx, String(allocation.pool_asset_id), 'RELEASE_START', amount, reference);
    const payout = await executePayout(tx, network, 'ALLOCATION', {
      id, orderRef: orderId, recipient, token: allocation.asset_kind === 'NATIVE' ? NATIVE_TOKEN : String(allocation.contract_address), amount,
    });
    if (payout.ok) {
      await moveBalance(tx, String(allocation.pool_asset_id), 'RELEASE_DONE', amount, reference);
      await tx`update app.pool_allocations set state='RELEASED',release_tx=${payout.txHash},last_error=null,updated_at=now() where id=${id}`;
      result.released.push(String(allocation.item_key));
    } else {
      await moveBalance(tx, String(allocation.pool_asset_id), 'RELEASE_FAILED', amount, reference);
      await tx`update app.pool_allocations set state='ACTIVE',last_error=${payout.code},updated_at=now() where id=${id}`;
      result.failed.push({ key: String(allocation.item_key), code: payout.code });
    }
  }
  const [{ outstanding }] = await tx<{ outstanding: number }[]>`select count(*)::int as outstanding from app.pool_allocations where order_id=${orderId} and required and state <> 'RELEASED'`;
  result.requiredOutstanding = outstanding;
  if (result.failed.length) {
    await openCase(tx, orderId, null, 'POOL_PAYOUT_PARTIAL', outstanding ? 'HIGH' : 'MEDIUM',
      `Pool payout failed for ${result.failed.map((f) => `${f.key} (${f.code})`).join(', ')}; the settlement job retries only these items`);
  }
  return result;
}

/** CRY-09: refunds only confirmed, unallocated balance; allocations and in-flight payouts are untouched. */
export async function refundUnusedPoolBalance(tx: Tx, actor: Actor, input: { poolId: string; assetId: string; amount?: string }) {
  const pool = await lockPool(tx, input.poolId);
  if (String(pool.owner_id) !== actor.id) throw new CommandError('Campaign pool not found', 'NOT_FOUND');
  const [poolAsset] = UUID_PATTERN.test(input.assetId)
    ? await tx<Row[]>`select pa.*,a.decimals,a.symbol,a.kind as asset_kind,a.contract_address from app.pool_assets pa join app.chain_assets a on a.id=pa.asset_id
        where pa.pool_id=${input.poolId} and pa.asset_id=${input.assetId} for update of pa`
    : [];
  if (!poolAsset) throw new CommandError('This asset is not part of the pool', 'UNSUPPORTED_ASSET');
  const unallocated = BigInt(String(poolAsset.unallocated));
  let amount = unallocated;
  if (input.amount) {
    try {
      amount = parseDecimalToAtomic(input.amount, Number(poolAsset.decimals));
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : 'Invalid amount');
    }
  }
  if (amount <= 0n) throw new CommandError('There is no unallocated balance to refund', 'DOMAIN_RULE');
  if (amount > unallocated) throw new CommandError(`Only ${formatAtomic(unallocated, Number(poolAsset.decimals))} ${poolAsset.symbol} is unallocated and refundable`, 'BUDGET_EXCEEDED');
  const recipient = await activeWallet(tx, actor.id, Number(pool.chain_id));
  if (!recipient) throw new CommandError('Link a verified wallet on the pool network to receive the refund', 'DOMAIN_RULE');
  const [network] = await tx<Row[]>`select * from app.chain_networks where chain_id=${Number(pool.chain_id)} and enabled`;
  if (!network) throw new CommandError('The pool network is not enabled', 'FEATURE_DISABLED');
  const [refund] = await tx<Row[]>`insert into app.pool_refunds (pool_asset_id,requested_by,recipient,amount_atomic) values (${String(poolAsset.id)},${actor.id},${recipient},${amount.toString()}) returning id`;
  const refundId = String(refund!.id);
  await moveBalance(tx, String(poolAsset.id), 'REFUND_START', amount, `refund:${refundId}`);
  const payout = await executePayout(tx, network, 'POOL_REFUND', {
    id: refundId, orderRef: `pool:${input.poolId}`, recipient, token: poolAsset.asset_kind === 'NATIVE' ? NATIVE_TOKEN : String(poolAsset.contract_address), amount,
  });
  if (payout.ok) {
    await moveBalance(tx, String(poolAsset.id), 'REFUND_DONE', amount, `refund:${refundId}`);
    await tx`update app.pool_refunds set state='REFUNDED',refund_tx=${payout.txHash},updated_at=now() where id=${refundId}`;
  } else {
    await moveBalance(tx, String(poolAsset.id), 'REFUND_FAILED', amount, `refund:${refundId}`);
    await tx`update app.pool_refunds set state='FAILED',last_error=${payout.code},updated_at=now() where id=${refundId}`;
    await openCase(tx, null, null, 'POOL_REFUND_FAILED', 'HIGH', `Pool ${input.poolId} refund ${refundId} failed (${payout.code}); balance returned to unallocated`);
  }
  await refreshPoolStatus(tx, input.poolId);
  return { refundId, state: payout.ok ? 'REFUNDED' : 'FAILED', display: `${formatAtomic(amount, Number(poolAsset.decimals))} ${poolAsset.symbol}` };
}

export async function closeCampaignPool(tx: Tx, actor: Actor, poolId: string) {
  const pool = await lockPool(tx, poolId);
  if (String(pool.owner_id) !== actor.id) throw new CommandError('Campaign pool not found', 'NOT_FOUND');
  if (pool.status === 'CLOSED') throw new CommandError('This pool is already closed', 'ORDER_STATE_CONFLICT');
  const [open] = await tx<Row[]>`select 1 from app.pool_allocations where pool_id=${poolId} and state in ('ACTIVE','RELEASE_PENDING') limit 1`;
  if (open) throw new CommandError('Active hires still hold pool allocations', 'ORDER_STATE_CONFLICT');
  const [balance] = await tx<Row[]>`select 1 from app.pool_assets where pool_id=${poolId} and (unallocated > 0 or pending_outflow > 0) limit 1`;
  if (balance) throw new CommandError('Refund the unallocated balance before closing the pool', 'ORDER_STATE_CONFLICT');
  await tx`update app.campaign_pools set status='CLOSED',closed_at=now() where id=${poolId}`;
}

/** CRY-12: the buyer fulfils with proof; an NFT must be owned by the creator's verified wallet and back one entitlement. */
export async function fulfillEntitlement(tx: Tx, actor: Actor, input: { entitlementId: string; proof: string; nftContract?: string; nftTokenId?: string }) {
  const [entitlement] = UUID_PATTERN.test(input.entitlementId)
    ? await tx<Row[]>`select e.*,p.owner_id,p.chain_id,o.creator_id from app.reward_entitlements e join app.campaign_pools p on p.id=e.pool_id join app.orders o on o.id=e.order_id
        where e.id=${input.entitlementId} for update of e`
    : [];
  if (!entitlement || String(entitlement.owner_id) !== actor.id) throw new CommandError('Entitlement not found', 'NOT_FOUND');
  if (entitlement.status !== 'PENDING') throw new CommandError(`This entitlement is already ${String(entitlement.status).toLowerCase()}`, 'ORDER_STATE_CONFLICT');
  if (input.proof.trim().length < 10) throw new CommandError('Describe how the perk was delivered (at least 10 characters)');
  if (entitlement.kind === 'NFT') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.nftContract ?? '') || !/^\d{1,78}$/.test(input.nftTokenId ?? '')) throw new CommandError('NFT rewards need the token contract and token id');
    const wallet = await activeWallet(tx, String(entitlement.creator_id), Number(entitlement.chain_id));
    const [network] = await tx<Row[]>`select * from app.chain_networks where chain_id=${Number(entitlement.chain_id)}`;
    const reader = getChainReader(network!) as { getNftOwner?: (contract: Hex, tokenId: bigint) => Promise<Hex | null> };
    const owner = reader.getNftOwner ? await reader.getNftOwner(input.nftContract as Hex, BigInt(input.nftTokenId!)) : null;
    if (!wallet || !owner || owner.toLowerCase() !== wallet) throw new CommandError('The NFT is not owned by the creator\'s verified wallet on chain', 'DOMAIN_RULE');
    try {
      await tx`update app.reward_entitlements set status='FULFILLED',fulfilled_at=now(),proof=${JSON.stringify({ note: input.proof.trim() })}::jsonb,
        nft_chain_id=${Number(entitlement.chain_id)},nft_contract=${input.nftContract!.toLowerCase()},nft_token_id=${input.nftTokenId!} where id=${input.entitlementId}`;
    } catch (error) {
      if ((error as { constraint_name?: string }).constraint_name === 'reward_entitlements_one_nft') throw new CommandError('This NFT already backs another reward', 'ORDER_STATE_CONFLICT');
      throw error;
    }
  } else {
    await tx`update app.reward_entitlements set status='FULFILLED',fulfilled_at=now(),proof=${JSON.stringify({ note: input.proof.trim() })}::jsonb where id=${input.entitlementId}`;
  }
}

export async function claimEntitlement(tx: Tx, actor: Actor, entitlementId: string) {
  const [entitlement] = UUID_PATTERN.test(entitlementId)
    ? await tx<Row[]>`select e.*,o.creator_id from app.reward_entitlements e join app.orders o on o.id=e.order_id where e.id=${entitlementId} for update of e`
    : [];
  if (!entitlement || String(entitlement.creator_id) !== actor.id) throw new CommandError('Entitlement not found', 'NOT_FOUND');
  if (entitlement.status !== 'FULFILLED') throw new CommandError(entitlement.status === 'CLAIMED' ? 'This reward was already claimed' : 'The buyer has not fulfilled this reward yet', 'ORDER_STATE_CONFLICT');
  await tx`update app.reward_entitlements set status='CLAIMED',claimed_at=now() where id=${entitlementId}`;
}

/** Owner sees every bucket; applicants see rewards per hire and whether required assets are funded (§11.5). */
export async function getPoolData(actor: Actor | null, requestId: string) {
  if (!UUID_PATTERN.test(requestId)) return null;
  const [pool] = await sql<Row[]>`select p.*,n.name as network_name,n.mode as network_mode from app.campaign_pools p join app.chain_networks n on n.chain_id=p.chain_id where p.request_id=${requestId}`;
  if (!pool) return null;
  const owner = actor?.id === String(pool.owner_id);
  const [template] = await sql<Row[]>`select version,items,created_at from app.pool_templates where pool_id=${String(pool.id)} order by version desc limit 1`;
  const assets = await sql<Row[]>`select pa.*,a.symbol,a.decimals,a.kind as asset_kind,a.contract_address from app.pool_assets pa join app.chain_assets a on a.id=pa.asset_id where pa.pool_id=${String(pool.id)} order by a.symbol`;
  const fmt = (row: Row, column: string) => formatAtomic(BigInt(String(row[column])), Number(row.decimals));
  const missing = assets.filter((row) => row.required && BigInt(String(row.confirmed_deposit)) - BigInt(String(row.refunded)) < BigInt(String(row.target_atomic)))
    .map((row) => ({ asset_id: String(row.asset_id), symbol: row.symbol, missing: formatAtomic(BigInt(String(row.target_atomic)) - (BigInt(String(row.confirmed_deposit)) - BigInt(String(row.refunded))), Number(row.decimals)) }));
  const base = {
    id: String(pool.id), status: pool.status, chain_id: Number(pool.chain_id), network_name: pool.network_name, network_mode: pool.network_mode,
    template_version: Number(template!.version), rewards_per_hire: template!.items, fully_funded: missing.length === 0, missing_required: missing,
  };
  if (!owner) return { pool: base };
  const [intents, allocations, refunds, entitlements] = await Promise.all([
    sql<Row[]>`select id,pool_asset_id,amount_atomic,reference,recipient,status,status_reason,created_at from app.pool_funding_intents where pool_id=${String(pool.id)} order by created_at desc`,
    sql<Row[]>`select id,order_id,item_key,kind,required,amount_atomic,state,attempts,last_error,release_tx,template_version from app.pool_allocations where pool_id=${String(pool.id)} order by created_at`,
    sql<Row[]>`select r.id,r.amount_atomic,r.state,r.last_error,r.refund_tx,r.created_at,a.symbol from app.pool_refunds r join app.pool_assets pa on pa.id=r.pool_asset_id join app.chain_assets a on a.id=pa.asset_id where pa.pool_id=${String(pool.id)} order by r.created_at desc`,
    sql<Row[]>`select id,order_id,item_key,kind,perk_type,description,fulfillment_method,required,deadline_at,status,fulfilled_at,claimed_at from app.reward_entitlements where pool_id=${String(pool.id)} order by created_at`,
  ]);
  return {
    pool: base,
    assets: assets.map((row) => ({
      asset_id: String(row.asset_id), symbol: row.symbol, decimals: Number(row.decimals), kind: row.asset_kind, required: row.required,
      target: fmt(row, 'target_atomic'), confirmed_deposit: fmt(row, 'confirmed_deposit'), unallocated: fmt(row, 'unallocated'), allocated_active: fmt(row, 'allocated_active'),
      pending_outflow: fmt(row, 'pending_outflow'), released: fmt(row, 'released'), refunded: fmt(row, 'refunded'),
    })),
    funding_intents: intents,
    allocations,
    refunds,
    entitlements,
  };
}
