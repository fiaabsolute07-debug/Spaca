/**
 * Crypto checkout commands (master §11.2/§11.4). Paying with crypto is optional per order; fiat checkout never
 * needs a wallet. The intent fixes chain, asset, exact atomic amount, settlement recipient and an opaque reference.
 */
import { randomUUID } from 'node:crypto';
import { CommandError, integer, text, uuid, type CommandHandler, type Row } from '@/lib/commands';
import { assertFlags } from '@/modules/admin/policy';
import { enabledNetwork, formatAtomic, settlementReference, usdMinorToAtomic } from './registry';

const createCryptoPayment: CommandHandler = async ({ tx, actor, form }) => {
  await assertFlags(tx, ['CRYPTO_CHECKOUT_ENABLED', 'CHECKOUT_CREATION_ENABLED']);
  const orderId = uuid(form, 'order_id');
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} and buyer_id=${actor.id} for update`;
  if (!order) throw new CommandError('Order not found or not visible to this account', 'NOT_FOUND');
  if (order.status !== 'AWAITING_PAYMENT' || order.payment_status === 'SUCCEEDED') throw new CommandError('This order is not awaiting payment', 'ORDER_STATE_CONFLICT');
  if (order.currency !== 'USD') throw new CommandError('Crypto checkout supports USD-priced orders only', 'UNSUPPORTED_ASSET');
  const [hold] = await tx<Row[]>`select expires_at from app.reservations where order_id=${orderId} and state='HELD' and (expires_at is null or expires_at > now())`;
  if (!hold) throw new CommandError('The checkout hold expired; book again to pay', 'SLOT_EXPIRED');
  const [cardAttempt] = await tx<Row[]>`select 1 from app.provider_operations where order_id=${orderId} and kind='funding.create'
    and (status in ('PENDING','UNKNOWN') or coalesce(outcome->>'fundingStatus','') in ('PROCESSING','SUCCEEDED')) limit 1`;
  if (cardAttempt) throw new CommandError('A card payment for this order is already in progress', 'ORDER_STATE_CONFLICT');

  const chainId = integer(text(form, 'chain_id'), 'chain_id', 1, Number.MAX_SAFE_INTEGER);
  const network = await enabledNetwork(tx, chainId);
  const assetId = text(form, 'asset_id', false);
  const [asset] = assetId
    ? await tx<Row[]>`select * from app.chain_assets where id=${uuid(form, 'asset_id')} and chain_id=${chainId}`
    : await tx<Row[]>`select * from app.chain_assets where chain_id=${chainId} and usd_pegged and allowlisted order by (kind='NATIVE') desc, symbol limit 1`;
  if (!asset || !asset.usd_pegged || !asset.allowlisted) throw new CommandError('This asset is not accepted for checkout', 'UNSUPPORTED_ASSET');
  const walletId = text(form, 'wallet_id', false) || null;
  if (walletId) {
    const [wallet] = await tx<Row[]>`select id from app.wallets where id=${uuid(form, 'wallet_id')} and user_id=${actor.id} and chain_id=${chainId} and revoked_at is null`;
    if (!wallet) throw new CommandError('Link and verify this wallet first', 'FORBIDDEN');
  }

  const [open] = await tx<Row[]>`select * from app.crypto_payment_intents where order_id=${orderId} and status in ('AWAITING_DEPOSIT','PENDING_FINALITY') for update`;
  if (open?.status === 'PENDING_FINALITY') throw new CommandError('A deposit for this order is already confirming on chain', 'ORDER_STATE_CONFLICT');
  if (open && Number(open.chain_id) === chainId && String(open.asset_id) === String(asset.id) && (open.payer_wallet_id ?? null) === walletId) {
    return { path: `/orders/${orderId}`, message: 'Your crypto payment instructions are unchanged', id: String(open.id) };
  }
  if (open) await tx`update app.crypto_payment_intents set status='CANCELLED',status_reason='Replaced by a new payment choice',updated_at=now() where id=${String(open.id)}`;

  const id = randomUUID();
  const amount = usdMinorToAtomic(BigInt(String(order.amount_minor)), Number(asset.decimals));
  await tx`insert into app.crypto_payment_intents (id,order_id,buyer_id,chain_id,asset_id,network_mode,amount_atomic,recipient,reference,payer_wallet_id,expires_at)
    values (${id},${orderId},${actor.id},${chainId},${String(asset.id)},${String(network.mode)},${amount.toString()},${String(network.settlement_address)},
      ${settlementReference(orderId, id)},${walletId},${hold.expires_at ?? new Date(Date.now() + 15 * 60_000)})`;
  return { path: `/orders/${orderId}`, message: `Send exactly ${formatAtomic(amount, Number(asset.decimals))} ${asset.symbol} on ${network.name} with the payment reference`, id };
};

export const cryptoCommands: Record<string, CommandHandler> = { create_crypto_payment: createCryptoPayment };
