/**
 * Order commands implementing the master §7.2 transition matrix. Every command locks the order row,
 * re-checks actor, state and versions, and writes the event + outbox in the same transaction.
 */
import {
  CommandError,
  expectedVersion,
  integer,
  money,
  orderEvent,
  text,
  uuid,
  type CommandContext,
  type CommandHandler,
  type CommandResult,
  type Row,
  type Tx,
} from '@/lib/commands';
import type { Actor } from '@/lib/auth';
import { enqueueNotification } from '@/modules/notifications/enqueue';
import { PaymentFlowError, cancelOpenFunding, openCase, refundReasonFor, requestProviderRefund, setCryptoEscrowFrozen } from '@/modules/payments/funding';
import { attachDeliveryAssets, lockDeliveryAssets, parseAssetIds } from '@/modules/storage/service';
import { checkPublicationProof, publishTermsOf } from '@/modules/publish';
import { digitalTermsOf } from '@/modules/digital';
import {
  MIN_DELIVERY_NOTE_CHARS,
  REVISION_TURNAROUND_HOURS,
  assertCurrentDelivery,
  expirePendingCancellation,
  latestDelivery,
  recomputeWorkClock,
  recordBuyerView,
  resolveReviewHold,
  termsOf,
} from './lifecycle';

export async function orderFor(tx: Tx, actor: Actor, id: string): Promise<Row> {
  const [order] = await tx<Row[]>`select * from app.orders where id=${id} and (buyer_id=${actor.id} or creator_id=${actor.id}) for update`;
  if (!order) throw new CommandError('Order not found or not visible to this account', 'FORBIDDEN');
  return order;
}

type OrderContext = CommandContext & { order: Row; orderId: string; status: string; isBuyer: boolean; isCreator: boolean };
type OrderHandler = (ctx: OrderContext) => Promise<CommandResult>;

const withOrder = (handler: OrderHandler): CommandHandler => async (ctx) => {
  const orderId = uuid(ctx.form, 'order_id');
  const order = await orderFor(ctx.tx, ctx.actor, orderId);
  const expected = expectedVersion(ctx.form);
  if (expected !== null && Number(order.version) !== expected) {
    throw new CommandError('This order changed since you opened it. Reload to see the latest state.', 'VERSION_CONFLICT');
  }
  return handler({ ...ctx, order, orderId, status: String(order.status), isBuyer: ctx.actor.id === String(order.buyer_id), isCreator: ctx.actor.id === String(order.creator_id) });
};

const deliveryVersionOf = (form: FormData) => {
  const value = String(form.get('delivery_version') ?? '').trim();
  return value ? integer(value, 'delivery_version', 1, 1000) : null;
};

const counterpartyOf = (order: Row, actor: Actor) => (actor.id === String(order.buyer_id) ? String(order.creator_id) : String(order.buyer_id));
const done = (orderId: string, message: string): CommandResult => ({ path: `/orders/${orderId}`, message });

const sandboxPay: CommandHandler = async () => {
  // Funding is a provider fact delivered by a verified webhook (src/modules/payments/funding.ts); clients cannot mark orders paid.
  throw new CommandError('Direct funding is not available. Pay through the provider checkout.', 'FORBIDDEN');
};

/** Brief completion for orders that start without one (auction purchases). The brief is fixed once work starts. */
const submitBrief = withOrder(async ({ tx, actor, form, order, orderId, status, isBuyer }) => {
  if (!isBuyer) throw new CommandError('Only the buyer can submit the brief', 'FORBIDDEN');
  if (!['AWAITING_PAYMENT', 'FUNDED'].includes(status)) throw new CommandError('The brief can only change before work starts', 'ORDER_STATE_CONFLICT');
  if (order.brief_ready_at) throw new CommandError('The brief is already complete; send changes as a message for the creator to accept', 'DOMAIN_RULE');
  const brief = text(form, 'brief', true, 12000);
  if (brief.length < MIN_DELIVERY_NOTE_CHARS) throw new CommandError('Share a brief of at least 20 characters', 'BRIEF_INCOMPLETE');
  await tx`update app.orders set brief=${brief},brief_ready_at=now(),updated_at=now() where id=${orderId}`;
  await recomputeWorkClock(tx, orderId);
  await orderEvent(tx, orderId, actor.id, 'BRIEF_SUBMITTED');
  return done(orderId, 'Brief saved. The work clock starts once funding is confirmed.');
});

const start = withOrder(async ({ tx, actor, order, orderId, status, isCreator }) => {
  if (!isCreator) throw new CommandError('Only the creator can start work', 'FORBIDDEN');
  if (status !== 'FUNDED') throw new CommandError(status === 'AWAITING_PAYMENT' ? 'Payment is not confirmed yet' : 'Only a funded order can start', 'ORDER_STATE_CONFLICT');
  if (!order.brief_ready_at) throw new CommandError('The buyer has not completed the brief yet', 'BRIEF_INCOMPLETE');
  if (digitalTermsOf(order.terms)) throw new CommandError('Digital products are delivered automatically when payment is confirmed', 'DOMAIN_RULE');
  // The due date was fixed at max(funded_at, brief_ready_at); starting late never moves it (ORD-04).
  const [updated] = await tx<Row[]>`update app.orders set status='IN_PROGRESS',version=version+1,updated_at=now() where id=${orderId} returning work_start_at,delivery_due_at`;
  await orderEvent(tx, orderId, actor.id, 'WORK_STARTED', { work_start_at: updated!.work_start_at, delivery_due_at: updated!.delivery_due_at });
  return done(orderId, 'Work started');
});

const deliver = withOrder(async ({ tx, actor, form, order, orderId, status, isCreator }) => {
  if (!isCreator) throw new CommandError('Only the creator can deliver', 'FORBIDDEN');
  if (status === 'FUNDED') throw new CommandError('Start work before delivering', 'ORDER_STATE_CONFLICT');
  if (!['IN_PROGRESS', 'REVISION_REQUESTED'].includes(status)) throw new CommandError('This order is not accepting deliveries', 'ORDER_STATE_CONFLICT');
  if (digitalTermsOf(order.terms)) throw new CommandError('Digital products are delivered as released files; add a new version to the product instead', 'DOMAIN_RULE');
  const body = text(form, 'body', false, 12000);
  const urlValue = text(form, 'url', false, 1000);
  let url: string | null = null;
  if (urlValue) {
    try {
      const parsed = new URL(urlValue);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
      url = parsed.toString();
    } catch {
      throw new CommandError('Delivery link must be an http(s) URL');
    }
  }
  const assetIds = parseAssetIds(text(form, 'asset_ids', false, 1000));
  // XPL-02: a PUBLISH order is delivered by the post itself on the sold channel, not by a draft file.
  const publish = publishTermsOf(order.terms);
  const proof = publish
    ? checkPublicationProof(publish, form, order.work_start_at ? new Date(order.work_start_at) : null, order.delivery_due_at ? new Date(order.delivery_due_at) : null)
    : null;
  if (proof) url = proof.postUrl;
  // ORD-07: an empty or token delivery never starts the review clock; files must be finalized and not quarantined.
  if (!url && !assetIds.length && body.length < MIN_DELIVERY_NOTE_CHARS) {
    throw new CommandError(`A delivery needs a file, a link or at least ${MIN_DELIVERY_NOTE_CHARS} characters of delivered content`);
  }
  await lockDeliveryAssets(tx, orderId, actor.id, assetIds);
  const version = Number((await latestDelivery(tx, orderId))?.version ?? 0) + 1;
  const [delivery] = await tx<Row[]>`insert into app.deliveries (order_id,body,url,version,validation_status,submitted_by)
    values (${orderId},${body || (proof ? '(published post)' : assetIds.length ? '(see attached files)' : '(see link)')},${url},${version},'VALID',${actor.id}) returning id`;
  await attachDeliveryAssets(tx, orderId, String(delivery!.id), assetIds);
  if (publish && proof) {
    await tx`insert into app.publish_proofs (order_id,delivery_id,platform,channel_url,post_url,post_id,published_at,disclosure_text,disclosure_attested,link_check,late)
      values (${orderId},${String(delivery!.id)},${publish.platform},${publish.channel_url},${proof.postUrl},${proof.postId},${proof.publishedAt.toISOString()},
        ${publish.disclosure_text},true,${proof.linkCheck},${proof.late})`;
  }
  await resolveReviewHold(tx, orderId, 'SUPERSEDED');
  await expirePendingCancellation(tx, orderId);
  const window = termsOf(order).reviewWindowHours;
  const [updated] = await tx<Row[]>`update app.orders set status='DELIVERED',review_due_at=now() + (${window} * interval '1 hour'),revision_due_at=null,
    version=version+1,updated_at=now() where id=${orderId} returning review_due_at,delivery_due_at`;
  const late = updated!.delivery_due_at ? new Date() > new Date(updated!.delivery_due_at) : false;
  await orderEvent(tx, orderId, actor.id, 'DELIVERED', { version, late, review_due_at: updated!.review_due_at,
    ...(proof ? { post_url: proof.postUrl, published_at: proof.publishedAt.toISOString(), link_check: proof.linkCheck } : {}) });
  await enqueueNotification(tx, orderId, `notify:order.delivered:${orderId}:v${version}`, {
    templateId: 'order.delivered', recipientId: String(order.buyer_id), params: { orderRef: orderId, reviewDeadlineAt: new Date(updated!.review_due_at).toISOString() },
  });
  return done(orderId, 'Delivery submitted for buyer review');
});

const revision = withOrder(async ({ tx, actor, form, order, orderId, status, isBuyer }) => {
  if (!isBuyer) throw new CommandError('Only the buyer can request a revision', 'FORBIDDEN');
  if (status !== 'DELIVERED') throw new CommandError('A revision can only be requested on a delivered version', 'ORDER_STATE_CONFLICT');
  if (digitalTermsOf(order.terms)) throw new CommandError('Digital products are sold as released. Cancel before downloading, or open a dispute if the files are not as described.', 'DOMAIN_RULE');
  const delivery = await assertCurrentDelivery(tx, orderId, deliveryVersionOf(form));
  if (order.review_due_at && new Date() > new Date(order.review_due_at)) throw new CommandError('The review window has closed; open a dispute or contact support', 'DOMAIN_RULE');
  const { revisionLimit } = termsOf(order);
  if (Number(order.revision_count) >= revisionLimit) {
    throw new CommandError('The included revision has already been used. You can approve, message the creator or open a dispute.', 'REVISION_LIMIT_REACHED');
  }
  const body = text(form, 'body', true, 5000);
  await tx`update app.orders set status='REVISION_REQUESTED',revision_count=revision_count+1,revision_due_at=now() + (${REVISION_TURNAROUND_HOURS} * interval '1 hour'),
    version=version+1,updated_at=now() where id=${orderId}`;
  await resolveReviewHold(tx, orderId, 'BUYER_ACTED');
  await expirePendingCancellation(tx, orderId);
  await orderEvent(tx, orderId, actor.id, 'REVISION_REQUESTED', { body, delivery_version: Number(delivery.version), revisions_used: Number(order.revision_count) + 1, revision_limit: revisionLimit });
  await enqueueNotification(tx, orderId, `notify:order.revision_requested:${orderId}:v${delivery.version}`, {
    templateId: 'order.revision_requested', recipientId: String(order.creator_id), params: { orderRef: orderId },
  });
  return done(orderId, 'Revision requested');
});

/** Shared by buyer approval and the auto-accept job; caller holds the order lock and has validated state. */
export async function approveOrder(tx: Tx, order: Row, actorId: string | null, deliveryVersion: number, kind: 'ORDER_APPROVED' | 'ORDER_AUTO_APPROVED') {
  const orderId = String(order.id);
  // The order status trigger marks the workload claim DONE and frees the creator's unit (CAP-06).
  await tx`update app.orders set status='APPROVED',approved_at=now(),settlement_status='READY',version=version+1,updated_at=now() where id=${orderId}`;
  await resolveReviewHold(tx, orderId, 'BUYER_ACTED');
  await expirePendingCancellation(tx, orderId);
  await orderEvent(tx, orderId, actorId, kind, { delivery_version: deliveryVersion, platform_fee_minor: '0', settlement_status: 'READY' });
  await enqueueNotification(tx, orderId, `notify:order.approved:${orderId}`, { templateId: 'order.approved', recipientId: String(order.creator_id), params: { orderRef: orderId } });
}

const approve = withOrder(async ({ tx, actor, form, order, orderId, status, isBuyer }) => {
  if (!isBuyer) throw new CommandError('Only the buyer can approve', 'FORBIDDEN');
  if (status !== 'DELIVERED') throw new CommandError('Only a delivered version can be approved', 'ORDER_STATE_CONFLICT');
  const delivery = await assertCurrentDelivery(tx, orderId, deliveryVersionOf(form));
  await approveOrder(tx, order, actor.id, Number(delivery.version), 'ORDER_APPROVED');
  return done(orderId, 'Delivery approved. The creator payout is queued; the order completes once the provider confirms. Platform fee is $0.00.');
});

const dispute = withOrder(async ({ tx, actor, form, order, orderId, status, isBuyer, isCreator }) => {
  if (!isBuyer && !isCreator) throw new CommandError('Only order participants can open a dispute', 'FORBIDDEN');
  if (!['IN_PROGRESS', 'DELIVERED', 'REVISION_REQUESTED'].includes(status)) throw new CommandError('This order cannot be disputed in its current state', 'ORDER_STATE_CONFLICT');
  const reason = text(form, 'body', true, 5000);
  if (reason.length < 10) throw new CommandError('Describe the issue in at least 10 characters');
  const [opened] = await tx<Row[]>`insert into app.disputes (order_id,opened_by,reason) values (${orderId},${actor.id},${reason}) returning id`;
  // Crypto-funded escrow is frozen so the payer cannot reclaim it while the dispute is open (W9-ARC).
  await setCryptoEscrowFrozen(tx, order, String(opened!.id), true);
  await tx`update app.orders set status='DISPUTED',status_before_dispute=${status},version=version+1,updated_at=now() where id=${orderId}`;
  await resolveReviewHold(tx, orderId, 'BUYER_ACTED');
  await expirePendingCancellation(tx, orderId);
  await orderEvent(tx, orderId, actor.id, 'DISPUTE_OPENED', { status_before_dispute: status });
  await enqueueNotification(tx, orderId, `notify:dispute.opened:${orderId}`, { templateId: 'dispute.opened', recipientId: counterpartyOf(order, actor), params: { orderRef: orderId } });
  return done(orderId, 'Dispute opened. Releases are frozen while it is reviewed.');
});

/** Unilateral cancellation before work starts (§7.2 unfunded / funded-before-work rows). */
const cancel = withOrder(async ({ tx, actor, order, orderId, status, isBuyer, isCreator }) => {
  if (!isBuyer && !isCreator) throw new CommandError('Only order participants can cancel', 'FORBIDDEN');
  if (!['AWAITING_PAYMENT', 'FUNDED'].includes(status)) {
    throw new CommandError('Work has started; request a cancellation with an agreed refund instead', 'ORDER_STATE_CONFLICT');
  }
  if (status === 'AWAITING_PAYMENT') await cancelOpenFunding(tx, orderId);
  // CANCELLED releases the hold or active claim through the order status trigger (drizzle/0012).
  await tx`update app.orders set status='CANCELLED',cancelled_at=now(),payment_status=case when payment_status='SUCCEEDED' then 'REFUND_PENDING' else payment_status end,
    version=version+1,updated_at=now() where id=${orderId}`;
  await orderEvent(tx, orderId, actor.id, 'ORDER_CANCELLED', { before_work: true });
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
  return done(orderId, status === 'FUNDED' ? 'Order cancelled. A full refund was requested from the provider and shows as refunded once confirmed.' : 'Order cancelled and capacity released');
});

/** ORD-13/15: after work starts, cancellation needs the counterparty to accept a fixed refund amount. */
const requestCancellation = withOrder(async ({ tx, actor, form, order, orderId, status, isBuyer, isCreator }) => {
  if (!isBuyer && !isCreator) throw new CommandError('Only order participants can request a cancellation', 'FORBIDDEN');
  if (!['IN_PROGRESS', 'DELIVERED', 'REVISION_REQUESTED'].includes(status)) {
    throw new CommandError(status === 'FUNDED' || status === 'AWAITING_PAYMENT' ? 'Work has not started; cancel directly instead' : 'This order cannot be cancelled now', 'ORDER_STATE_CONFLICT');
  }
  const refundValue = text(form, 'refund_amount');
  const refund = refundValue === '0' ? 0n : money(refundValue, 'refund_amount');
  if (refund > BigInt(order.amount_minor)) throw new CommandError('The refund cannot exceed the amount paid');
  const reason = text(form, 'reason', true, 5000);
  if (reason.length < 10) throw new CommandError('Explain the cancellation in at least 10 characters');
  const [existing] = await tx<Row[]>`select id from app.cancellation_requests where order_id=${orderId} and status='REQUESTED'`;
  if (existing) throw new CommandError('A cancellation request is already waiting for a response', 'ORDER_STATE_CONFLICT');
  const counterparty = counterpartyOf(order, actor);
  const [request] = await tx<Row[]>`insert into app.cancellation_requests (order_id,requested_by,counterparty_id,reason,refund_amount_minor,order_version)
    values (${orderId},${actor.id},${counterparty},${reason},${refund.toString()},${Number(order.version)}) returning id`;
  await orderEvent(tx, orderId, actor.id, 'CANCELLATION_REQUESTED', { request_id: String(request!.id), refund_amount_minor: refund.toString() });
  await enqueueNotification(tx, orderId, `notify:order.cancellation_requested:${String(request!.id)}`, {
    templateId: 'order.cancellation_requested', recipientId: counterparty, params: { orderRef: orderId },
  });
  return { ...done(orderId, 'Cancellation request sent. The order continues unless the other party accepts.'), id: String(request!.id) };
});

const respondCancellation: CommandHandler = async ({ tx, actor, form }) => {
  const requestId = uuid(form, 'request_id');
  const decision = text(form, 'decision');
  if (!['accept', 'reject', 'withdraw'].includes(decision)) throw new CommandError('decision must be accept, reject or withdraw');
  // Lock order before request (same order as deliver/approve/dispute, which expire requests under the order lock).
  const [ref] = await tx<Row[]>`select order_id,counterparty_id,requested_by from app.cancellation_requests where id=${requestId}`;
  if (!ref || (actor.id !== String(ref.counterparty_id) && actor.id !== String(ref.requested_by))) {
    throw new CommandError('Cancellation request not found', 'FORBIDDEN');
  }
  const order = await orderFor(tx, actor, String(ref.order_id));
  const orderId = String(order.id);
  const [request] = await tx<Row[]>`select * from app.cancellation_requests where id=${requestId} for update`;
  if (!request) throw new CommandError('Cancellation request not found', 'FORBIDDEN');
  if (request.status !== 'REQUESTED') throw new CommandError(`This request is already ${String(request.status).toLowerCase()}`, 'ORDER_STATE_CONFLICT');

  if (decision === 'withdraw') {
    if (actor.id !== String(request.requested_by)) throw new CommandError('Only the requester can withdraw', 'FORBIDDEN');
    await tx`update app.cancellation_requests set status='WITHDRAWN',responded_at=now() where id=${requestId}`;
    await orderEvent(tx, orderId, actor.id, 'CANCELLATION_WITHDRAWN', { request_id: requestId });
    return done(orderId, 'Cancellation request withdrawn');
  }
  if (actor.id !== String(request.counterparty_id)) throw new CommandError('Only the other party can respond', 'FORBIDDEN');
  // Consent covers the order as it was; any later delivery/revision/dispute invalidates the request (ORD-15).
  if (Number(order.version) !== Number(request.order_version) || !['IN_PROGRESS', 'DELIVERED', 'REVISION_REQUESTED'].includes(String(order.status))) {
    throw new CommandError('The order changed after this request was made. Ask for a new cancellation request.', 'VERSION_CONFLICT');
  }
  if (decision === 'reject') {
    await tx`update app.cancellation_requests set status='REJECTED',responded_at=now() where id=${requestId}`;
    await orderEvent(tx, orderId, actor.id, 'CANCELLATION_REJECTED', { request_id: requestId });
    await enqueueNotification(tx, orderId, `notify:order.cancellation_resolved:${requestId}`, {
      templateId: 'order.cancellation_resolved', recipientId: String(request.requested_by), params: { orderRef: orderId, outcome: 'REJECTED' },
    });
    return done(orderId, 'Cancellation declined; the order continues');
  }

  const refund = BigInt(request.refund_amount_minor);
  const amount = BigInt(order.amount_minor);
  await tx`update app.cancellation_requests set status='ACCEPTED',responded_at=now() where id=${requestId}`;
  // No work remains, so CANCELLED frees the creator's unit through the order status trigger (§6.1 rule 8, CAP-12).
  await resolveReviewHold(tx, orderId, 'BUYER_ACTED');
  await tx`update app.orders set status='CANCELLED',cancelled_at=now(),cancellation_refund_minor=${refund.toString()},
    payment_status=${refund > 0n ? 'REFUND_PENDING' : String(order.payment_status)},
    settlement_status=${refund < amount ? 'READY' : 'NOT_READY'},version=version+1,updated_at=now() where id=${orderId}`;
  await orderEvent(tx, orderId, actor.id, 'CANCELLATION_ACCEPTED', { request_id: requestId, refund_amount_minor: refund.toString(), creator_remainder_minor: (amount - refund).toString() });
  if (refund > 0n) {
    const [fresh] = await tx<Row[]>`select * from app.orders where id=${orderId}`;
    try {
      const result = await requestProviderRefund(tx, fresh!, 'MUTUAL_CANCELLATION');
      await orderEvent(tx, orderId, actor.id, 'REFUND_REQUESTED', { operation_id: result.operationId, provider_state: result.state, amount_minor: refund.toString() });
      if (result.state === 'REJECTED') await openCase(tx, orderId, null, 'REFUND_REJECTED', 'HIGH', `Provider rejected refund (${result.code})`);
    } catch (error) {
      if (!(error instanceof PaymentFlowError)) throw error;
      await openCase(tx, orderId, null, 'REFUND_NOT_REQUESTED', 'HIGH', error.message);
    }
  }
  for (const recipient of [String(request.requested_by), actor.id]) {
    await enqueueNotification(tx, orderId, `notify:order.cancellation_resolved:${requestId}:${recipient}`, {
      templateId: 'order.cancellation_resolved', recipientId: recipient, params: { orderRef: orderId, outcome: 'ACCEPTED' },
    });
  }
  return done(orderId, 'Cancellation accepted. The agreed refund is requested from the provider; any remainder is released to the creator.');
};

const refund = withOrder(async ({ tx, actor, order, orderId, status }) => {
  if (!actor.roles.includes('finance') && !(actor.id === String(order.buyer_id) && status === 'CANCELLED')) {
    throw new CommandError('Refunds require a finance role or a cancelled buyer order', 'FORBIDDEN');
  }
  if (!['CANCELLED', 'DISPUTED'].includes(status) || order.payment_status !== 'REFUND_PENDING') throw new CommandError('This order is not eligible for a refund', 'ORDER_STATE_CONFLICT');
  // Retries the same refund operation; the order changes only when the provider's refund webhook is processed.
  const result = await requestProviderRefund(tx, order, order.cancellation_refund_minor !== null ? 'MUTUAL_CANCELLATION' : refundReasonFor(status));
  if (result.state === 'REJECTED') throw new CommandError(`The provider rejected the refund (${result.code})`);
  await orderEvent(tx, orderId, actor.id, 'REFUND_REQUESTED', { operation_id: result.operationId, provider_state: result.state });
  return done(orderId, result.state === 'READY' ? 'Refund requested from the provider. The order shows refunded once the provider confirms.' : 'The provider has not confirmed the refund request yet; retry to check the same refund operation.');
});

const review = withOrder(async ({ tx, actor, form, order, orderId, status, isBuyer }) => {
  if (!isBuyer) throw new CommandError('Only the buyer can review this order', 'FORBIDDEN');
  if (status !== 'COMPLETED') throw new CommandError('Reviews open once the order is completed', 'ORDER_STATE_CONFLICT');
  const rating = integer(text(form, 'rating'), 'rating', 1, 5);
  const body = text(form, 'body', true, 3000);
  const inserted = await tx`insert into app.reviews (order_id,buyer_id,creator_id,reviewer_id,rating,body) values (${orderId},${actor.id},${String(order.creator_id)},${actor.id},${rating},${body})
    on conflict (order_id,reviewer_id) do nothing returning id`;
  if (inserted.length === 0) return done(orderId, 'You already reviewed this order');
  await orderEvent(tx, orderId, actor.id, 'REVIEW_SUBMITTED', { rating });
  return done(orderId, 'Review saved');
});

const message = withOrder(async ({ tx, actor, form, orderId }) => {
  const body = text(form, 'body', true, 5000);
  await tx`insert into app.messages (order_id,sender_id,body) values (${orderId},${actor.id},${body})`;
  return done(orderId, 'Message sent');
});

const markDeliveryViewed = withOrder(async ({ tx, order, orderId, isBuyer }) => {
  if (!isBuyer) return done(orderId, 'Only the buyer view is recorded');
  const { resumed } = await recordBuyerView(tx, order);
  return done(orderId, resumed ? 'Review window restarted from now' : 'Delivery viewed');
});

export const orderCommands: Record<string, CommandHandler> = {
  sandbox_pay: sandboxPay,
  submit_brief: submitBrief,
  start,
  deliver,
  revision,
  approve,
  dispute,
  cancel,
  request_cancellation: requestCancellation,
  respond_cancellation: respondCancellation,
  refund,
  review,
  message,
  mark_delivery_viewed: markDeliveryViewed,
};
