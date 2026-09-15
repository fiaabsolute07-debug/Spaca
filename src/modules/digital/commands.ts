/** DIGITAL commands (P6-05/06, XPL-06): product releases and the refund-before-first-download rule. */
import { CommandError, orderEvent, text, uuid, type CommandHandler, type Row } from '@/lib/commands';
import { orderFor } from '@/modules/orders/commands';
import { expirePendingCancellation, resolveReviewHold } from '@/modules/orders/lifecycle';
import { PaymentFlowError, openCase, refundReasonFor, requestProviderRefund } from '@/modules/payments/funding';
import { digitalTermsOf } from '.';

/** Adds the next version of a product file. Earlier versions stay available under each buyer's update policy. */
const addDigitalRelease: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot add product files', 'ACCOUNT_SUSPENDED');
  const serviceId = uuid(form, 'service_id');
  const [service] = await tx<Row[]>`select id,taxonomy,status from app.services where id=${serviceId} and creator_id=${actor.id} for update`;
  if (!service) throw new CommandError('Service not found or not owned by this account', 'FORBIDDEN');
  if (service.taxonomy !== 'DIGITAL') throw new CommandError('Only DIGITAL services have product files');
  if (service.status === 'ARCHIVED') throw new CommandError('Archived products cannot get new files', 'DOMAIN_RULE');
  const assetIds = text(form, 'asset_ids', false, 200).split(',').map((id) => id.trim()).filter(Boolean);
  const assetId = assetIds[0] ?? text(form, 'asset_id', false, 60);
  if (!assetId || assetIds.length > 1) throw new CommandError('Upload exactly one file for this version');
  const [asset] = await tx<Row[]>`select id,lifecycle_state from app.storage_assets where id=${assetId} and owner_id=${actor.id} and purpose='DIGITAL' for update`;
  if (!asset) throw new CommandError('Upload the file as a product file first', 'NOT_FOUND');
  if (asset.lifecycle_state !== 'READY') throw new CommandError('This file did not pass the upload checks', 'DOMAIN_RULE');
  const [used] = await tx<Row[]>`select 1 from app.digital_releases where asset_id=${assetId}`;
  if (used) throw new CommandError('This file is already a release', 'ORDER_STATE_CONFLICT');
  const notes = text(form, 'notes', false, 2000);
  const [latest] = await tx<Row[]>`select coalesce(max(version),0)::int as version from app.digital_releases where service_id=${serviceId}`;
  const version = Number(latest!.version) + 1;
  await tx`insert into app.digital_releases (service_id,creator_id,version,asset_id,notes) values (${serviceId},${actor.id},${version},${assetId},${notes})`;
  return { path: '/creator/services', message: `Version ${version} added. Buyers get it according to each purchase's update policy.` };
};

/**
 * XPL-06: until the files are first downloaded, and within the review window, the buyer can cancel a DIGITAL purchase
 * for a full refund. The license is revoked by the order trigger. After the first download, the dispute path applies.
 */
const refundDigitalPurchase: CommandHandler = async ({ tx, actor, form }) => {
  const order = await orderFor(tx, actor, uuid(form, 'order_id'));
  const orderId = String(order.id);
  if (actor.id !== String(order.buyer_id)) throw new CommandError('Only the buyer can cancel this purchase', 'FORBIDDEN');
  if (!digitalTermsOf(order.terms)) throw new CommandError('This is not a digital product purchase');
  const [entitlement] = await tx<Row[]>`select * from app.digital_entitlements where order_id=${orderId} for update`;
  if (order.status !== 'DELIVERED' || entitlement?.state !== 'ACTIVE') throw new CommandError('This purchase cannot be cancelled now', 'ORDER_STATE_CONFLICT');
  if (Number(entitlement.download_count) > 0) {
    throw new CommandError('The files were already downloaded, so the purchase cannot be cancelled for a refund. Open a dispute if the files are not as described.', 'DOMAIN_RULE');
  }
  if (order.review_due_at && new Date() > new Date(order.review_due_at)) throw new CommandError('The review window has closed', 'DOMAIN_RULE');
  const reason = text(form, 'reason', false, 2000);
  await resolveReviewHold(tx, orderId, 'BUYER_ACTED');
  await expirePendingCancellation(tx, orderId);
  await tx`update app.orders set status='CANCELLED',cancelled_at=now(),payment_status=case when payment_status='SUCCEEDED' then 'REFUND_PENDING' else payment_status end,
    version=version+1,updated_at=now() where id=${orderId}`;
  await orderEvent(tx, orderId, actor.id, 'DIGITAL_PURCHASE_CANCELLED', { before_download: true, ...(reason ? { reason } : {}) });
  try {
    const refund = await requestProviderRefund(tx, order, refundReasonFor('CANCELLED'));
    await orderEvent(tx, orderId, actor.id, 'REFUND_REQUESTED', { operation_id: refund.operationId, provider_state: refund.state });
    if (refund.state === 'REJECTED') await openCase(tx, orderId, null, 'REFUND_REJECTED', 'HIGH', `Provider rejected refund (${refund.code})`);
  } catch (error) {
    if (!(error instanceof PaymentFlowError)) throw error;
    await openCase(tx, orderId, null, 'REFUND_NOT_REQUESTED', 'HIGH', error.message);
  }
  return { path: `/orders/${orderId}`, message: 'Purchase cancelled before download. A full refund was requested and the files are no longer available.' };
};

export const digitalCommands: Record<string, CommandHandler> = {
  add_digital_release: addDigitalRelease,
  refund_digital_purchase: refundDigitalPurchase,
};
