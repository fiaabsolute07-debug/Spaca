/** Campaign pool commands (W5-C2). All crypto movement is local-devnet only until a verified network and custody exist. */
import { CommandError, integer, text, uuid, type CommandHandler } from '@/lib/commands';
import { assertFlags } from '@/modules/admin/policy';
import {
  claimEntitlement,
  closeCampaignPool,
  createCampaignPool,
  createPoolFundingIntent,
  fulfillEntitlement,
  refundUnusedPoolBalance,
  updatePoolTemplate,
} from './service';

const requestPath = async (tx: Parameters<CommandHandler>[0]['tx'], poolId: string) => {
  const [pool] = await tx`select request_id from app.campaign_pools where id=${poolId}`;
  return pool ? `/requests/${pool.request_id}` : '/dashboard';
};

const createPool: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot create campaign pools', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['REQUESTS_ENABLED', 'CRYPTO_CHECKOUT_ENABLED']);
  const requestId = uuid(form, 'request_id');
  const pool = await createCampaignPool(tx, actor, { requestId, chainId: integer(text(form, 'chain_id'), 'chain_id', 1, Number.MAX_SAFE_INTEGER), items: text(form, 'items', true, 20000) });
  return { path: `/requests/${requestId}`, message: 'Campaign pool created. Fund each asset before hiring.', id: pool.id };
};

const updateTemplate: CommandHandler = async ({ tx, actor, form }) => {
  const poolId = uuid(form, 'pool_id');
  const version = await updatePoolTemplate(tx, actor, poolId, text(form, 'items', true, 20000));
  return { path: await requestPath(tx, poolId), message: `Reward template version ${version} applies to hires accepted from now on` };
};

const fundPool: CommandHandler = async ({ tx, actor, form }) => {
  await assertFlags(tx, ['CRYPTO_CHECKOUT_ENABLED']);
  const poolId = uuid(form, 'pool_id');
  const intent = await createPoolFundingIntent(tx, actor, { poolId, assetId: uuid(form, 'asset_id'), amount: text(form, 'amount') });
  return { path: await requestPath(tx, poolId), message: `Send exactly ${intent.display} with the pool payment reference`, id: intent.id };
};

const refundUnused: CommandHandler = async ({ tx, actor, form }) => {
  const poolId = uuid(form, 'pool_id');
  const refund = await refundUnusedPoolBalance(tx, actor, { poolId, assetId: uuid(form, 'asset_id'), amount: text(form, 'amount', false) || undefined });
  return { path: await requestPath(tx, poolId), message: refund.state === 'REFUNDED' ? `Refunded ${refund.display} of unallocated balance` : `Refund of ${refund.display} failed and was returned to the pool`, id: refund.refundId };
};

const closePool: CommandHandler = async ({ tx, actor, form }) => {
  const poolId = uuid(form, 'pool_id');
  await closeCampaignPool(tx, actor, poolId);
  return { path: await requestPath(tx, poolId), message: 'Campaign pool closed' };
};

const fulfill: CommandHandler = async ({ tx, actor, form }) => {
  const entitlementId = uuid(form, 'entitlement_id');
  await fulfillEntitlement(tx, actor, { entitlementId, proof: text(form, 'proof', true, 2000), nftContract: text(form, 'nft_contract', false) || undefined, nftTokenId: text(form, 'nft_token_id', false) || undefined });
  return { path: '/dashboard', message: 'Reward marked as fulfilled' };
};

const claim: CommandHandler = async ({ tx, actor, form }) => {
  await claimEntitlement(tx, actor, uuid(form, 'entitlement_id'));
  return { path: '/dashboard', message: 'Reward confirmed as received' };
};

export const poolCommands: Record<string, CommandHandler> = {
  create_campaign_pool: createPool,
  update_pool_template: updateTemplate,
  create_pool_funding: fundPool,
  refund_pool_unused: refundUnused,
  close_campaign_pool: closePool,
  fulfill_entitlement: fulfill,
  claim_entitlement: claim,
};
