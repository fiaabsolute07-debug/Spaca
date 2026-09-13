/**
 * Operator commands (master §13.2 admin rows, §14.3). Each checks privileged roles, requires a reason,
 * re-validates state under locks and writes an append-only audit entry in the same transaction.
 * There is deliberately no "force paid", "set balance" or "edit order state" command.
 */
import { CommandError, expectedVersion, money, orderEvent, text, uuid, type CommandHandler, type Row } from '@/lib/commands';
import { consumeOrderReservation } from '@/modules/capacity';
import { enqueueNotification } from '@/modules/notifications/enqueue';
import { approveOrder } from '@/modules/orders/commands';
import { latestDelivery, termsOf } from '@/modules/orders/lifecycle';
import { PaymentFlowError, openCase, requestProviderRefund } from '@/modules/payments/funding';
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
    // Work was underway, so its capacity stays consumed (CAP-12).
    await consumeOrderReservation(tx, orderId);
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

/** Same logical operation only (§14.3 "retry cùng operation"). Lookup-first reconciliation, never a new key. */
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
  await tx`update app.samples set moderation_status=${decision},moderated_by=${actor.id},moderated_at=now(),moderation_reason=${reason} where id=${sampleId}`;
  await audit(tx, actor, `sample.${decision.toLowerCase()}`, 'sample', sampleId, reason, { moderation_status: sample.moderation_status }, { moderation_status: decision });
  return { path: '/admin/moderation', message: `Sample ${decision.toLowerCase()}` };
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
  admin_retry_operation: retryOperation,
  admin_resolve_case: resolveCase,
  admin_assign_case: assignCase,
  admin_moderate_sample: moderateSample,
  admin_suspend_user: setUserStatus('SUSPENDED'),
  admin_reactivate_user: setUserStatus('ACTIVE'),
  admin_grant_role: setRole(true),
  admin_revoke_role: setRole(false),
  admin_set_flag: setFlag,
};
