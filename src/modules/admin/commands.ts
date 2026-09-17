/**
 * Operator commands (master §13.2 admin rows, §14.3). Each checks privileged roles, requires a reason,
 * re-validates state under locks and writes an append-only audit entry in the same transaction.
 * There is deliberately no "force paid", "set balance" or "edit order state" command.
 */
import { CommandError, expectedVersion, money, orderEvent, text, uuid, type CommandHandler, type Row } from '@/lib/commands';
import { enqueueNotification } from '@/modules/notifications/enqueue';
import { approveOrder } from '@/modules/orders/commands';
import { latestDelivery, termsOf } from '@/modules/orders/lifecycle';
import { PaymentFlowError, coverPostReleaseDeficit, openCase, requestProviderRefund, retryPostReleaseRecovery, setCryptoEscrowFrozen, startPostReleaseRefund } from '@/modules/payments/funding';
import { decideHeldBonus, type BonusDecision } from '@/modules/publish/performance-service';
import { quarantineAsset } from '@/modules/storage/service';
import { recomputeHighestBid } from '@/modules/auctions/commands';
import { audit, reasonOf, requireRole, type FeatureFlagKey, type PrivilegedRole } from './policy';

const orderSnapshot = (o: Row) => ({ status: o.status, payment_status: o.payment_status, settlement_status: o.settlement_status, version: o.version, cancellation_refund_minor: o.cancellation_refund_minor ?? null });

async function notifyParties(tx: Parameters<CommandHandler>[0]['tx'], order: Row, key: string) {
  for (const recipient of [String(order.buyer_id), String(order.creator_id)]) {
    await enqueueNotification(tx, String(order.id), `notify:dispute.resolved:${key}:${recipient}`, { templateId: 'dispute.resolved', recipientId: recipient, params: { orderRef: String(order.id) } });
  }
}

/** §7.2 DISPUTED → Resume / APPROVED / CANCELLED with a reasoned, audited decision. Money outcomes need finance (SEC-12). */
const resolveDispute: CommandHandler = async ({ tx, actor, form }) => {
  const disputeId = uuid(form, 'dispute_id');
  const outcome = text(form, 'outcome');
  if (!['RESUME', 'APPROVE', 'REFUND_FULL', 'REFUND_PARTIAL'].includes(outcome)) throw new CommandError('outcome must be RESUME, APPROVE, REFUND_FULL or REFUND_PARTIAL');
  requireRole(actor, outcome === 'RESUME' ? ['finance', 'support', 'admin'] : ['finance', 'admin'], `Dispute outcome ${outcome}`);
  const reason = reasonOf(form);

  const [ref] = await tx<Row[]>`select order_id from app.disputes where id=${disputeId}`;
  if (!ref) throw new CommandError('Dispute not found', 'NOT_FOUND');
  const [order] = await tx<Row[]>`select * from app.orders where id=${String(ref.order_id)} for update`;
  const [dispute] = await tx<Row[]>`select * from app.disputes where id=${disputeId} for update`;
  if (!order || !dispute) throw new CommandError('Dispute not found', 'NOT_FOUND');
  if (!['OPEN', 'UNDER_REVIEW'].includes(String(dispute.status))) throw new CommandError('This dispute is already resolved', 'ORDER_STATE_CONFLICT');
  if (order.status !== 'DISPUTED') throw new CommandError('The order is not in dispute', 'ORDER_STATE_CONFLICT');
  const expected = expectedVersion(form);
  if (expected !== null && Number(order.version) !== expected) throw new CommandError('The order changed; reload before resolving', 'VERSION_CONFLICT');
  const orderId = String(order.id);
  const before = orderSnapshot(order);
  const amount = BigInt(order.amount_minor);
  let refund: bigint | null = null;
  // Unfreeze is queued before any release or refund of this order, and the payout worker dispatches in queue order.
  await setCryptoEscrowFrozen(tx, order, disputeId, false);

  if (outcome === 'RESUME') {
    const resumeTo = String(order.status_before_dispute ?? 'IN_PROGRESS');
    const window = termsOf(order).reviewWindowHours;
    // A resumed review gets a full new window from the decision, never a window that expired during the dispute.
    await tx`update app.orders set status=${resumeTo},status_before_dispute=null,
      review_due_at=case when ${resumeTo}='DELIVERED' then now() + (${window} * interval '1 hour') else review_due_at end,
      version=version+1,updated_at=now() where id=${orderId}`;
  } else if (outcome === 'APPROVE') {
    const delivery = await latestDelivery(tx, orderId);
    if (!delivery || delivery.validation_status !== 'VALID') throw new CommandError('There is no valid delivery to approve', 'ORDER_STATE_CONFLICT');
    await approveOrder(tx, order, actor.id, Number(delivery.version), 'ORDER_APPROVED');
  } else {
    if (!['SUCCEEDED'].includes(String(order.payment_status))) throw new CommandError('Refunds need provider-confirmed funding', 'ORDER_STATE_CONFLICT');
    refund = outcome === 'REFUND_FULL' ? amount : money(text(form, 'refund_amount'), 'refund_amount');
    if (refund <= 0n || refund > amount) throw new CommandError('Refund must be greater than 0 and at most the amount paid');
    if (outcome === 'REFUND_PARTIAL' && refund === amount) throw new CommandError('Use REFUND_FULL for the full amount');
    // CANCELLED frees the creator's unit through the order status trigger (§6.1 rule 8, CAP-12).
    await tx`update app.orders set status='CANCELLED',cancelled_at=now(),status_before_dispute=null,
      cancellation_refund_minor=${outcome === 'REFUND_PARTIAL' ? refund.toString() : null},payment_status='REFUND_PENDING',
      settlement_status=${outcome === 'REFUND_PARTIAL' ? 'READY' : 'NOT_READY'},version=version+1,updated_at=now() where id=${orderId}`;
    const [fresh] = await tx<Row[]>`select * from app.orders where id=${orderId}`;
    try {
      const result = await requestProviderRefund(tx, fresh!, 'OPERATOR_RESOLUTION');
      await orderEvent(tx, orderId, actor.id, 'REFUND_REQUESTED', { operation_id: result.operationId, provider_state: result.state, amount_minor: refund.toString() });
      if (result.state === 'REJECTED') await openCase(tx, orderId, null, 'REFUND_REJECTED', 'HIGH', `Provider rejected refund (${result.code})`);
    } catch (error) {
      if (!(error instanceof PaymentFlowError)) throw error;
      await openCase(tx, orderId, null, 'REFUND_NOT_REQUESTED', 'HIGH', error.message);
    }
  }

  await tx`update app.disputes set status='RESOLVED',outcome=${outcome},resolution=${reason},refund_amount_minor=${refund?.toString() ?? null},
    resolved_by=${actor.id},resolved_at=now(),updated_at=now() where id=${disputeId}`;
  const [after] = await tx<Row[]>`select * from app.orders where id=${orderId}`;
  await orderEvent(tx, orderId, actor.id, 'DISPUTE_RESOLVED', { dispute_id: disputeId, outcome, refund_amount_minor: refund?.toString() ?? null });
  await audit(tx, actor, `dispute.resolve.${outcome.toLowerCase()}`, 'order', orderId, reason, before, orderSnapshot(after!));
  await notifyParties(tx, order, disputeId);
  return { path: `/admin/disputes`, message: `Dispute resolved: ${outcome}` };
};

/** Retries the refund of a cancelled order with the same operation id; never marks money refunded (§13.2 admin refund). */
const refundOrder: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['finance', 'admin'], 'Refunds');
  const reason = reasonOf(form);
  const orderId = uuid(form, 'order_id');
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  if (!order) throw new CommandError('Order not found', 'NOT_FOUND');
  if (order.status !== 'CANCELLED' || !['REFUND_PENDING', 'SUCCEEDED'].includes(String(order.payment_status))) {
    throw new CommandError('Only cancelled orders with confirmed funding can be refunded here; disputes use dispute resolution', 'ORDER_STATE_CONFLICT');
  }
  const before = orderSnapshot(order);
  if (order.payment_status === 'SUCCEEDED') await tx`update app.orders set payment_status='REFUND_PENDING',updated_at=now() where id=${orderId}`;
  const [fresh] = await tx<Row[]>`select * from app.orders where id=${orderId}`;
  const result = await requestProviderRefund(tx, fresh!, order.cancellation_refund_minor !== null ? 'MUTUAL_CANCELLATION' : 'OPERATOR_RESOLUTION');
  if (result.state === 'REJECTED') throw new CommandError(`The provider rejected the refund (${result.code})`, 'PAYMENT_UNAVAILABLE');
  await orderEvent(tx, orderId, actor.id, 'REFUND_REQUESTED', { operation_id: result.operationId, provider_state: result.state, by: 'finance' });
  await audit(tx, actor, 'order.refund.request', 'order', orderId, reason, before, { ...orderSnapshot(fresh!), operation_id: result.operationId, provider_state: result.state });
  return { path: `/admin/orders/${orderId}`, message: result.state === 'READY' ? 'Refund requested from the provider' : 'Provider did not confirm yet; retry uses the same operation' };
};

/** Payment-flow refusals are state conflicts for operators (the order or refund is not in a state that allows it). */
const asConflict = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PaymentFlowError) throw new CommandError(error.message, error.code === 'UNAVAILABLE' ? 'PAYMENT_UNAVAILABLE' : 'ORDER_STATE_CONFLICT');
    throw error;
  }
};

/** CAP-05: money captured after the order was cancelled (a LATE_FUNDING case) goes back to the buyer in full. */
const refundLateFunding: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['finance', 'admin'], 'Refunding late funds');
  const reason = reasonOf(form);
  const orderId = uuid(form, 'order_id');
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  if (!order) throw new CommandError('Order not found', 'NOT_FOUND');
  const [lateCase] = await tx<Row[]>`select id from app.reconciliation_cases where order_id=${orderId} and kind='LATE_FUNDING' and status in ('OPEN','ASSIGNED') limit 1`;
  if (!lateCase || order.status !== 'CANCELLED' || !['PENDING', 'PROCESSING', 'FAILED'].includes(String(order.payment_status))) {
    throw new CommandError('Only a cancelled order holding late captured funds can be refunded here', 'ORDER_STATE_CONFLICT');
  }
  const before = orderSnapshot(order);
  await tx`update app.orders set payment_status='REFUND_PENDING',updated_at=now() where id=${orderId}`;
  const [fresh] = await tx<Row[]>`select * from app.orders where id=${orderId}`;
  const result = await requestProviderRefund(tx, fresh!, 'OPERATOR_RESOLUTION');
  if (result.state === 'REJECTED') throw new CommandError(`The provider rejected the refund (${result.code})`, 'PAYMENT_UNAVAILABLE');
  await orderEvent(tx, orderId, actor.id, 'LATE_FUNDING_REFUND_REQUESTED', { operation_id: result.operationId, provider_state: result.state });
  await audit(tx, actor, 'order.late_funding.refund', 'order', orderId, reason, before, { ...orderSnapshot(fresh!), operation_id: result.operationId, provider_state: result.state });
  return { path: `/admin/orders/${orderId}`, message: result.state === 'READY' ? 'Refund of the late funds requested from the provider' : 'Provider did not confirm yet; retry uses the same operation' };
};

const RECOVERY_MESSAGE: Record<string, string> = {
  RECOVERING: 'Reversal accepted by the provider; the buyer refund follows once the reversal is confirmed',
  DEFICIT: 'The creator transfer could not be reversed. Nothing was refunded or recovered; the deficit is tracked',
  RETRY: 'The provider did not confirm the reversal; retrying uses the same operation',
};

/** PAY-15: refund a buyer after the creator was paid. Money comes back through a reversal or an approved platform cover. */
const refundAfterRelease: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['finance', 'admin'], 'Refunds after release');
  const reason = reasonOf(form);
  const orderId = uuid(form, 'order_id');
  const amount = money(text(form, 'amount'), 'amount');
  const { refundId, state } = await asConflict(() => startPostReleaseRefund(tx, actor.id, orderId, amount, reason));
  await audit(tx, actor, 'order.refund_after_release.request', 'post_release_refund', refundId, reason, null, { order_id: orderId, amount_minor: amount.toString(), state });
  return { path: `/admin/orders/${orderId}`, message: RECOVERY_MESSAGE[state] ?? state, id: refundId };
};

const retryRefundRecovery: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['finance', 'admin'], 'Refund recovery retries');
  const reason = reasonOf(form);
  const refundId = uuid(form, 'refund_id');
  const state = await asConflict(() => retryPostReleaseRecovery(tx, refundId));
  const [refund] = await tx<Row[]>`select order_id from app.post_release_refunds where id=${refundId}`;
  await audit(tx, actor, 'order.refund_after_release.retry', 'post_release_refund', refundId, reason, { status: 'DEFICIT' }, { state });
  return { path: `/admin/orders/${String(refund!.order_id)}`, message: RECOVERY_MESSAGE[state] ?? state };
};

const coverRefundDeficit: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['finance', 'admin'], 'Covering a refund deficit');
  const reason = reasonOf(form);
  const refundId = uuid(form, 'refund_id');
  const state = await asConflict(() => coverPostReleaseDeficit(tx, actor.id, refundId, reason));
  const [refund] = await tx<Row[]>`select order_id,covered_minor from app.post_release_refunds where id=${refundId}`;
  await audit(tx, actor, 'order.refund_after_release.cover', 'post_release_refund', refundId, reason, { status: 'DEFICIT' }, { state, covered_minor: String(refund!.covered_minor) });
  return { path: `/admin/orders/${String(refund!.order_id)}`, message: state === 'REFUND_REQUESTED' ? 'Platform cover approved; buyer refund requested from the provider' : `Platform cover approved; the provider did not accept the refund yet (${state})` };
};

/** Same logical operation only (§14.3 "retry cùng operation"). Lookup-first reconciliation, never a new key. */
/**
 * §9.6: decide a view bonus the checkpoint held for review. The money outcome is the buyer's, so this needs finance.
 * Nothing here edits the count that was measured; it only says whether that bonus is paid or returned to the buyer.
 */
const decidePerformanceBonus = (decision: BonusDecision): CommandHandler => async ({ tx, actor, form }) => {
  requireRole(actor, ['finance', 'admin'], 'View bonus decisions');
  const reason = reasonOf(form);
  const orderId = uuid(form, 'order_id');
  const [order] = await tx<Row[]>`select id,version,settlement_status from app.orders where id=${orderId} for update`;
  if (!order) throw new CommandError('Order not found', 'NOT_FOUND');
  const expected = expectedVersion(form);
  if (expected !== null && Number(order.version) !== expected) throw new CommandError('The order changed; reload before deciding', 'VERSION_CONFLICT');
  if (String(order.settlement_status) === 'RELEASED') throw new CommandError('This order was already paid out', 'ORDER_STATE_CONFLICT');
  const outcome = await decideHeldBonus(tx, orderId, decision, actor.id, reason);
  await orderEvent(tx, orderId, actor.id, decision === 'APPROVE' ? 'PERFORMANCE_BONUS_APPROVED' : 'PERFORMANCE_BONUS_REJECTED',
    { bonus_minor: outcome.bonusMinor.toString(), refund_minor: outcome.refundMinor.toString() });
  await audit(tx, actor, `order.performance_bonus.${decision.toLowerCase()}`, 'order', orderId, reason,
    { status: 'HELD', bonus_minor: outcome.measuredBonusMinor.toString() },
    { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', bonus_minor: outcome.bonusMinor.toString(), performance_refund_minor: outcome.refundMinor.toString() });
  return {
    path: `/admin/orders/${orderId}`,
    message: decision === 'APPROVE'
      ? `Bonus approved; the creator is paid the fixed fee plus ${(Number(outcome.bonusMinor) / 100).toFixed(2)} and the buyer gets the rest of the hold back`
      : 'Bonus refused; the creator is paid the fixed fee only and the whole bonus hold returns to the buyer',
  };
};

const retryOperation: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['finance', 'admin'], 'Operation retry');
  const reason = reasonOf(form);
  const operationId = text(form, 'operation_id', true, 255);
  const [operation] = await tx<Row[]>`select id,operation_id,order_id,kind,status,outcome from app.provider_operations where operation_id=${operationId}`;
  if (!operation) throw new CommandError('Provider operation not found', 'NOT_FOUND');
  const { reconcileProviderOperations } = await import('@/modules/jobs');
  const report = await reconcileProviderOperations({ orderId: operation.order_id ? String(operation.order_id) : undefined, minAgeSeconds: 0 });
  const [after] = await tx<Row[]>`select status,outcome,provider_reference from app.provider_operations where id=${String(operation.id)}`;
  await audit(tx, actor, 'provider_operation.retry', 'provider_operation', String(operation.id), reason,
    { status: operation.status, kind: operation.kind }, { status: after?.status, outcomes: report.outcomes });
  return { path: '/admin/operations', message: `Reconciliation ran for ${operationId}: ${JSON.stringify(report.outcomes)}` };
};

const resolveCase: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['finance', 'support', 'admin'], 'Case resolution');
  const reason = reasonOf(form);
  const caseId = uuid(form, 'case_id');
  const status = text(form, 'status');
  if (!['RESOLVED', 'IGNORED'].includes(status)) throw new CommandError('status must be RESOLVED or IGNORED');
  const [item] = await tx<Row[]>`select * from app.reconciliation_cases where id=${caseId} for update`;
  if (!item) throw new CommandError('Case not found', 'NOT_FOUND');
  if (!['OPEN', 'ASSIGNED'].includes(String(item.status))) throw new CommandError('Case is already closed', 'ORDER_STATE_CONFLICT');
  await tx`update app.reconciliation_cases set status=${status},resolution=${reason},resolved_by=${actor.id},resolved_at=now(),updated_at=now() where id=${caseId}`;
  await audit(tx, actor, `case.${status.toLowerCase()}`, 'reconciliation_case', caseId, reason, { status: item.status, kind: item.kind }, { status });
  return { path: '/admin/cases', message: `Case ${status.toLowerCase()}` };
};

const assignCase: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['finance', 'support', 'admin'], 'Case assignment');
  const reason = reasonOf(form);
  const caseId = uuid(form, 'case_id');
  const assigneeId = uuid(form, 'assignee_id');
  const [assignee] = await tx<Row[]>`select 1 from app.user_roles where user_id=${assigneeId} and revoked_at is null and role in ('finance','support','admin') limit 1`;
  if (!assignee) throw new CommandError('Assignee must hold an operator role');
  const [item] = await tx<Row[]>`update app.reconciliation_cases set status='ASSIGNED',assigned_to=${assigneeId},owner=${assigneeId},updated_at=now()
    where id=${caseId} and status in ('OPEN','ASSIGNED') returning id`;
  if (!item) throw new CommandError('Open case not found', 'NOT_FOUND');
  await audit(tx, actor, 'case.assign', 'reconciliation_case', caseId, reason, null, { assigned_to: assigneeId });
  return { path: '/admin/cases', message: 'Case assigned' };
};

const moderateSample: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['moderator', 'admin'], 'Sample moderation');
  const reason = reasonOf(form);
  const sampleId = uuid(form, 'sample_id');
  const decision = text(form, 'decision');
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new CommandError('decision must be APPROVED or REJECTED');
  const [sample] = await tx<Row[]>`select * from app.samples where id=${sampleId} for update`;
  if (!sample) throw new CommandError('Sample not found', 'NOT_FOUND');
  if (decision === 'APPROVED' && sample.storage_asset_id) {
    const [asset] = await tx<Row[]>`select lifecycle_state from app.storage_assets where id=${sample.storage_asset_id} for share`;
    if (asset?.lifecycle_state !== 'READY') throw new CommandError('The sample file is quarantined or removed and cannot be published', 'DOMAIN_RULE');
  }
  await tx`update app.samples set moderation_status=${decision},moderated_by=${actor.id},moderated_at=now(),moderation_reason=${reason} where id=${sampleId}`;
  await audit(tx, actor, `sample.${decision.toLowerCase()}`, 'sample', sampleId, reason, { moderation_status: sample.moderation_status }, { moderation_status: decision });
  return { path: '/admin/moderation', message: `Sample ${decision.toLowerCase()}` };
};

/** §10.3: a moderator invalidates a bid with evidence; history is kept, the leader is recomputed, Buy Now stays off. */
const invalidateBid: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['moderator', 'admin'], 'Bid invalidation');
  const reason = reasonOf(form);
  const bidId = uuid(form, 'bid_id');
  const [lookup] = await tx<Row[]>`select auction_id from app.bids where id=${bidId}`;
  if (!lookup) throw new CommandError('Bid not found', 'NOT_FOUND');
  const auctionId = String(lookup.auction_id);
  const [auction] = await tx<Row[]>`select * from app.auctions where id=${auctionId} for update`;
  if (!['SCHEDULED', 'LIVE'].includes(String(auction!.status))) throw new CommandError('Bids can only be invalidated while the auction is open', 'ORDER_STATE_CONFLICT');
  const [bid] = await tx<Row[]>`select * from app.bids where id=${bidId} for update`;
  if (bid!.status !== 'ACCEPTED') throw new CommandError('This bid is already invalidated', 'ORDER_STATE_CONFLICT');
  await tx`update app.bids set status='INVALIDATED',invalidated_reason=${reason},invalidated_by=${actor.id},invalidated_at=now() where id=${bidId}`;
  const top = await recomputeHighestBid(tx, auctionId);
  await audit(tx, actor, 'bid.invalidate', 'bid', bidId, reason, { status: 'ACCEPTED', amount_minor: String(bid!.amount_minor), current_bid_id: auction!.current_bid_id },
    { status: 'INVALIDATED', current_bid_id: top ? String(top.id) : null, first_valid_bid_at: auction!.first_valid_bid_at });
  return { path: `/auctions/${auctionId}`, message: 'Bid invalidated; the highest valid bid was recomputed' };
};

/** Pulls an unsafe file from every download path; deliveries using it stop counting toward auto-accept (ORD-07). */
const quarantineFile: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['moderator', 'admin'], 'File quarantine');
  const reason = reasonOf(form);
  const assetId = uuid(form, 'asset_id');
  const before = await quarantineAsset(tx, assetId, reason);
  if (before.purpose === 'SAMPLE') {
    await tx`update app.samples set moderation_status='REJECTED',moderated_by=${actor.id},moderated_at=now(),moderation_reason=${reason} where storage_asset_id=${assetId}`;
  }
  if (before.purpose === 'REQUEST_IMAGE' || before.purpose === 'ITEM_IMAGE') {
    // A picture and its card copy are one picture: quarantining either takes both out of view.
    const pairs = before.purpose === 'REQUEST_IMAGE'
      ? await tx<Row[]>`select asset_id,thumb_asset_id from app.request_images where asset_id=${assetId} or thumb_asset_id=${assetId}`
      : await tx<Row[]>`select asset_id,thumb_asset_id from app.item_listing_images where asset_id=${assetId} or thumb_asset_id=${assetId}`;
    for (const pair of pairs) {
      for (const other of [pair.asset_id, pair.thumb_asset_id]) {
        if (!other || String(other) === assetId) continue;
        const [state] = await tx<Row[]>`select lifecycle_state from app.storage_assets where id=${String(other)}`;
        if (state && !['QUARANTINED', 'DELETED'].includes(String(state.lifecycle_state))) await quarantineAsset(tx, String(other), reason);
      }
    }
  }
  await audit(tx, actor, 'asset.quarantine', 'storage_asset', assetId, reason, { lifecycle_state: before.lifecycle_state, bucket: before.bucket }, { lifecycle_state: 'QUARANTINED' });
  return { path: before.order_id ? `/admin/orders/${before.order_id}` : '/admin/moderation', message: 'File quarantined' };
};

const setUserStatus = (target: 'SUSPENDED' | 'ACTIVE'): CommandHandler => async ({ tx, actor, form }) => {
  requireRole(actor, ['moderator', 'admin'], 'Account status changes');
  const reason = reasonOf(form);
  const userId = uuid(form, 'user_id');
  if (userId === actor.id) throw new CommandError('You cannot change your own account status', 'FORBIDDEN');
  const [user] = await tx<Row[]>`select id,status from app.users where id=${userId} for update`;
  if (!user) throw new CommandError('User not found', 'NOT_FOUND');
  const [privileged] = await tx<Row[]>`select 1 from app.user_roles where user_id=${userId} and revoked_at is null and role='admin'`;
  if (privileged && !actor.roles.includes('admin')) throw new CommandError('Only admins can change an admin account', 'FORBIDDEN');
  if (user.status === target) throw new CommandError(`Account is already ${target.toLowerCase()}`, 'ORDER_STATE_CONFLICT');
  // Suspension blocks new activity only; existing orders, refunds and payouts continue (SEC-10).
  await tx`update app.users set status=${target} where id=${userId}`;
  await audit(tx, actor, target === 'SUSPENDED' ? 'user.suspend' : 'user.reactivate', 'user', userId, reason, { status: user.status }, { status: target });
  return { path: '/admin/users', message: target === 'SUSPENDED' ? 'Account suspended for new activity' : 'Account reactivated' };
};

const setRole = (grant: boolean): CommandHandler => async ({ tx, actor, form }) => {
  requireRole(actor, ['admin'], 'Role changes');
  const reason = reasonOf(form);
  const userId = uuid(form, 'user_id');
  const role = text(form, 'role') as PrivilegedRole;
  if (!['moderator', 'finance', 'support', 'admin'].includes(role)) throw new CommandError('Unknown privileged role');
  if (userId === actor.id) throw new CommandError('You cannot change your own privileged roles', 'FORBIDDEN');
  const [user] = await tx<Row[]>`select id,is_test from app.users where id=${userId}`;
  if (!user) throw new CommandError('User not found', 'NOT_FOUND');
  if (grant) {
    const inserted = await tx`insert into app.user_roles (user_id,role,granted_by,granted_reason) values (${userId},${role},${actor.id},${reason}) on conflict do nothing returning id`;
    if (inserted.length === 0) throw new CommandError('Role is already granted', 'ORDER_STATE_CONFLICT');
  } else {
    const revoked = await tx`update app.user_roles set revoked_at=now(),revoked_by=${actor.id},revoked_reason=${reason} where user_id=${userId} and role=${role} and revoked_at is null returning id`;
    if (revoked.length === 0) throw new CommandError('Role is not currently granted', 'ORDER_STATE_CONFLICT');
  }
  await audit(tx, actor, grant ? 'role.grant' : 'role.revoke', 'user', userId, reason, null, { role, granted: grant });
  return { path: '/admin/users', message: grant ? `Granted ${role}` : `Revoked ${role}` };
};

const setFlag: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['admin'], 'Feature flag changes');
  const reason = reasonOf(form);
  const key = text(form, 'key') as FeatureFlagKey;
  const enabled = text(form, 'enabled') === 'true';
  const [flag] = await tx<Row[]>`select * from app.feature_flags where key=${key} for update`;
  if (!flag) throw new CommandError('Unknown feature flag', 'NOT_FOUND');
  // Live money cannot be switched on from the UI; it needs the environment gate and readiness evidence (§8.2).
  if (key === 'LIVE_PAYMENTS_ENABLED' && enabled && process.env.LIVE_PAYMENTS_ENABLED !== 'true') {
    throw new CommandError('Live payments stay off until the environment and payment readiness gates allow them', 'FEATURE_DISABLED');
  }
  await tx`update app.feature_flags set enabled=${enabled},changed_by=${actor.id},changed_reason=${reason},updated_at=now() where key=${key}`;
  await audit(tx, actor, 'feature_flag.set', 'feature_flag', null, reason, { key, enabled: flag.enabled }, { key, enabled });
  return { path: '/admin/flags', message: `${key} is now ${enabled ? 'on' : 'off'}` };
};

export const adminCommands: Record<string, CommandHandler> = {
  admin_resolve_dispute: resolveDispute,
  admin_refund_order: refundOrder,
  admin_refund_after_release: refundAfterRelease,
  admin_refund_late_funding: refundLateFunding,
  admin_retry_refund_recovery: retryRefundRecovery,
  admin_cover_refund_deficit: coverRefundDeficit,
  admin_retry_operation: retryOperation,
  admin_approve_performance_bonus: decidePerformanceBonus('APPROVE'),
  admin_reject_performance_bonus: decidePerformanceBonus('REJECT'),
  admin_resolve_case: resolveCase,
  admin_assign_case: assignCase,
  admin_moderate_sample: moderateSample,
  admin_quarantine_asset: quarantineFile,
  admin_invalidate_bid: invalidateBid,
  admin_suspend_user: setUserStatus('SUSPENDED'),
  admin_reactivate_user: setUserStatus('ACTIVE'),
  admin_grant_role: setRole(true),
  admin_revoke_role: setRole(false),
  admin_set_flag: setFlag,
};
