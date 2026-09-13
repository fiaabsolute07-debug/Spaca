import { CommandError, integer, orderEvent, text, type CommandHandler, type CommandContext, type Row, type Tx } from '@/lib/commands';
import type { Actor } from '@/lib/auth';
import { consumeOrderReservation, releaseOrderReservation } from '@/modules/capacity';
import { PaymentFlowError, cancelOpenFunding, openCase, refundReasonFor, requestProviderRefund } from '@/modules/payments/funding';

export async function orderFor(tx: Tx, actor: Actor, id: string): Promise<Row> {
  const [order] = await tx<Row[]>`select * from app.orders where id=${id} and (buyer_id=${actor.id} or creator_id=${actor.id}) for update`;
  if (!order) throw new CommandError('Order not found or not visible to this account', 'FORBIDDEN');
  return order;
}

type OrderHandler = (ctx: CommandContext & { order: Row; orderId: string; status: string }) => Promise<{ path: string; message: string; id?: string }>;

const withOrder = (handler: OrderHandler): CommandHandler => async (ctx) => {
  const orderId = text(ctx.form, 'order_id');
  const order = await orderFor(ctx.tx, ctx.actor, orderId);
  return handler({ ...ctx, order, orderId, status: String(order.status) });
};

const sandboxPay: CommandHandler = async () => {
  // Funding is a provider fact delivered by a verified webhook (src/modules/payments/funding.ts); clients cannot mark orders paid.
  throw new CommandError('Direct funding is not available. Pay through the provider checkout.', 'FORBIDDEN');
};

const start = withOrder(async ({ tx, actor, order, orderId, status }) => {
  if (actor.id !== String(order.creator_id) || status !== 'FUNDED') throw new CommandError('Only the creator can start a funded order');
  await tx`update app.orders set status='IN_PROGRESS',version=version+1,updated_at=now() where id=${orderId}`;
  await orderEvent(tx, orderId, actor.id, 'WORK_STARTED');
  return { path: `/orders/${orderId}`, message: 'Work started' };
});

const deliver = withOrder(async ({ tx, actor, form, order, orderId, status }) => {
  if (actor.id !== String(order.creator_id) || !['FUNDED', 'IN_PROGRESS', 'REVISION_REQUESTED'].includes(status)) {
    throw new CommandError('Only the creator can deliver active work');
  }
  const body = text(form, 'body');
  const url = text(form, 'url', false) || null;
  const [last] = await tx<Row[]>`select coalesce(max(version),0)::int as version from app.deliveries where order_id=${orderId}`;
  const version = Number(last!.version) + 1;
  await tx`insert into app.deliveries (order_id,body,url,version) values (${orderId},${body},${url},${version})`;
  await tx`update app.orders set status='DELIVERED',review_due_at=now()+interval '72 hours',version=version+1,updated_at=now() where id=${orderId}`;
  await orderEvent(tx, orderId, actor.id, 'DELIVERED', { version });
  return { path: `/orders/${orderId}`, message: 'Delivery submitted for buyer review' };
});

const revision = withOrder(async ({ tx, actor, form, order, orderId, status }) => {
  if (actor.id !== String(order.buyer_id) || status !== 'DELIVERED') throw new CommandError('Only the buyer can request a revision after delivery');
  if (Number(order.revision_count) >= 1) throw new CommandError('The included revision has already been used');
  const body = text(form, 'body');
  await tx`update app.orders set status='REVISION_REQUESTED',revision_count=revision_count+1,version=version+1,updated_at=now() where id=${orderId}`;
  await orderEvent(tx, orderId, actor.id, 'REVISION_REQUESTED', { body });
  return { path: `/orders/${orderId}`, message: 'Revision requested' };
});

const approve = withOrder(async ({ tx, actor, order, orderId, status }) => {
  if (actor.id !== String(order.buyer_id) || status !== 'DELIVERED') throw new CommandError('Only the buyer can approve a delivered version');
  // Approval only marks settlement READY; the release job transfers funds and RELEASED follows the provider's webhook.
  await tx`update app.orders set status='COMPLETED',settlement_status='READY',version=version+1,updated_at=now() where id=${orderId}`;
  await consumeOrderReservation(tx, orderId);
  await orderEvent(tx, orderId, actor.id, 'ORDER_APPROVED', { platform_fee_minor: '0', settlement_status: 'READY' });
  return { path: `/orders/${orderId}`, message: 'Delivery approved. The creator payout is queued and shows as released once the provider confirms; platform fee is $0.00.' };
});

const dispute = withOrder(async ({ tx, actor, form, orderId, status }) => {
  if (!['DELIVERED', 'REVISION_REQUESTED', 'IN_PROGRESS'].includes(status)) throw new CommandError('This order cannot be disputed in its current state');
  const reason = text(form, 'body');
  await tx`insert into app.disputes (order_id,opened_by,reason) values (${orderId},${actor.id},${reason})`;
  await tx`update app.orders set status='DISPUTED',version=version+1,updated_at=now() where id=${orderId}`;
  await orderEvent(tx, orderId, actor.id, 'DISPUTE_OPENED');
  return { path: `/orders/${orderId}`, message: 'Dispute opened for review' };
});

const cancel = withOrder(async ({ tx, actor, order, orderId, status }) => {
  if (!['AWAITING_PAYMENT', 'FUNDED'].includes(status)) throw new CommandError('Cancellation requires an order before work starts');
  if (status === 'AWAITING_PAYMENT') await cancelOpenFunding(tx, orderId);
  await releaseOrderReservation(tx, orderId);
  await tx`update app.orders set status='CANCELLED',payment_status=case when payment_status='SUCCEEDED' then 'REFUND_PENDING' else payment_status end,
    version=version+1,updated_at=now() where id=${orderId}`;
  await orderEvent(tx, orderId, actor.id, 'ORDER_CANCELLED');
  if (status === 'FUNDED') {
    // Full principal refund before work starts (master §8.6); REFUNDED only after the provider confirms.
    try {
      const refund = await requestProviderRefund(tx, order, refundReasonFor('CANCELLED'));
      await orderEvent(tx, orderId, actor.id, 'REFUND_REQUESTED', { operation_id: refund.operationId, provider_state: refund.state });
      if (refund.state === 'REJECTED') await openCase(tx, orderId, null, 'REFUND_REJECTED', 'HIGH', `Provider rejected refund (${refund.code})`);
    } catch (error) {
      if (!(error instanceof PaymentFlowError)) throw error;
      await openCase(tx, orderId, null, 'REFUND_NOT_REQUESTED', 'HIGH', error.message);
    }
  }
  return {
    path: `/orders/${orderId}`,
    message: status === 'FUNDED' ? 'Order cancelled. A full refund was requested from the provider and shows as refunded once confirmed.' : 'Order cancelled and capacity released',
  };
});

const refund = withOrder(async ({ tx, actor, order, orderId, status }) => {
  if (!actor.roles.includes('finance') && !(actor.id === String(order.buyer_id) && status === 'CANCELLED')) {
    throw new CommandError('Refunds require a finance role or a cancelled buyer order', 'FORBIDDEN');
  }
  if (!['CANCELLED', 'DISPUTED'].includes(status) || order.payment_status !== 'REFUND_PENDING') throw new CommandError('This order is not eligible for a refund');
  // The order becomes REFUNDED only when the provider's refund webhook is verified and processed.
  const result = await requestProviderRefund(tx, order, refundReasonFor(status));
  if (result.state === 'REJECTED') throw new CommandError(`The provider rejected the refund (${result.code})`);
  await orderEvent(tx, orderId, actor.id, 'REFUND_REQUESTED', { operation_id: result.operationId, provider_state: result.state });
  return {
    path: `/orders/${orderId}`,
    message: result.state === 'READY' ? 'Refund requested from the provider. The order shows refunded once the provider confirms.' : 'The provider has not confirmed the refund request yet; retry to check the same refund operation.',
  };
});

const review = withOrder(async ({ tx, actor, form, order, orderId, status }) => {
  if (actor.id !== String(order.buyer_id) || !['COMPLETED', 'APPROVED'].includes(status)) throw new CommandError('Only the buyer can review a completed order');
  const rating = integer(text(form, 'rating'), 'rating', 1, 5);
  const body = text(form, 'body');
  await tx`insert into app.reviews (order_id,buyer_id,creator_id,rating,body) values (${orderId},${actor.id},${order.creator_id},${rating},${body}) on conflict (order_id) do nothing`;
  return { path: `/orders/${orderId}`, message: 'Review saved' };
});

const message = withOrder(async ({ tx, actor, form, orderId }) => {
  const body = text(form, 'body');
  await tx`insert into app.messages (order_id,sender_id,body) values (${orderId},${actor.id},${body})`;
  return { path: `/orders/${orderId}`, message: 'Message sent' };
});

export const orderCommands: Record<string, CommandHandler> = {
  sandbox_pay: sandboxPay,
  start,
  deliver,
  revision,
  approve,
  dispute,
  cancel,
  refund,
  review,
  message,
};
