/**
 * ORD-12: a deadline moves only when both parties agree. One party proposes a later date with a reason; the other
 * accepts or declines, or the proposer withdraws. Amendments are immutable records (drizzle/0020); the database also
 * refuses any change to a delivery deadline that is not backed by an amendment accepted in the same transaction, and
 * expires open proposals when the order's status changes.
 */
import { CommandError, instantField, orderEvent, text, uuid, type CommandHandler, type Row, type Tx } from '@/lib/commands';
import { enqueueNotification } from '@/modules/notifications/enqueue';
import { digitalTermsOf } from '@/modules/digital';
import { orderFor } from './commands';

export const AMENDMENT_POLICY_VERSION = 'amend-v1';
/** A proposal can move a deadline by at most this much at a time. */
export const MAX_EXTENSION_DAYS = 90;
const DAY_MS = 86_400_000;

type Deadline = { deadline: 'DELIVERY' | 'REVISION'; dueAt: Date };

/** The deadline an order is currently working against, or null when nothing is due (not funded, delivered, closed). */
export function currentDeadline(order: Row): Deadline | null {
  const status = String(order.status);
  if (['FUNDED', 'IN_PROGRESS'].includes(status) && order.delivery_due_at) return { deadline: 'DELIVERY', dueAt: new Date(order.delivery_due_at) };
  if (status === 'REVISION_REQUESTED' && order.revision_due_at) return { deadline: 'REVISION', dueAt: new Date(order.revision_due_at) };
  return null;
}

const counterpartyOf = (order: Row, actorId: string) => (actorId === String(order.buyer_id) ? String(order.creator_id) : String(order.buyer_id));
const done = (orderId: string, message: string, id?: string) => ({ path: `/orders/${orderId}`, message, ...(id ? { id } : {}) });

const requestDeadlineExtension: CommandHandler = async ({ tx, actor, form }) => {
  const order = await orderFor(tx, actor, uuid(form, 'order_id'));
  const orderId = String(order.id);
  if (digitalTermsOf(order.terms)) throw new CommandError('Digital purchases have no deadline to extend', 'DOMAIN_RULE');
  const current = currentDeadline(order);
  if (!current) throw new CommandError('This order has no open deadline to extend', 'ORDER_STATE_CONFLICT');
  const newDue = instantField(form, 'new_due_at');
  if (newDue.getTime() <= current.dueAt.getTime()) throw new CommandError('Propose a date after the current deadline');
  if (newDue.getTime() <= Date.now() + 3_600_000) throw new CommandError('Propose a date at least one hour from now');
  if (newDue.getTime() - current.dueAt.getTime() > MAX_EXTENSION_DAYS * DAY_MS) throw new CommandError(`An extension can add at most ${MAX_EXTENSION_DAYS} days at a time`);
  const reason = text(form, 'reason', true, 2000);
  if (reason.length < 10) throw new CommandError('Explain the extension in at least 10 characters');
  const [open] = await tx<Row[]>`select id from app.order_amendments where order_id=${orderId} and status='REQUESTED' for update`;
  if (open) throw new CommandError('A deadline proposal is already waiting for a response', 'ORDER_STATE_CONFLICT');

  const counterparty = counterpartyOf(order, actor.id);
  // The old deadline is copied in SQL: JavaScript dates drop the microseconds the deadline guard compares.
  const [amendment] = await tx<Row[]>`insert into app.order_amendments (order_id,deadline,proposed_by,counterparty_id,reason,old_due_at,new_due_at,order_version,policy_version)
    select o.id,${current.deadline},${actor.id},${counterparty},${reason},case when ${current.deadline}='DELIVERY' then o.delivery_due_at else o.revision_due_at end,
      ${newDue.toISOString()},${Number(order.version)},${AMENDMENT_POLICY_VERSION} from app.orders o where o.id=${orderId} returning id`;
  const amendmentId = String(amendment!.id);
  await orderEvent(tx, orderId, actor.id, 'DEADLINE_EXTENSION_REQUESTED', { amendment_id: amendmentId, deadline: current.deadline, old_due_at: current.dueAt.toISOString(), new_due_at: newDue.toISOString() });
  await enqueueNotification(tx, orderId, `notify:order.deadline_extension_requested:${amendmentId}`, {
    templateId: 'order.deadline_extension_requested', recipientId: counterparty, params: { orderRef: orderId, newDueAt: newDue.toISOString() },
  });
  return done(orderId, 'Deadline proposal sent. The current deadline stays until the other party accepts.', amendmentId);
};

const respondDeadlineExtension: CommandHandler = async ({ tx, actor, form }) => {
  const amendmentId = uuid(form, 'amendment_id');
  const decision = text(form, 'decision');
  if (!['accept', 'reject', 'withdraw'].includes(decision)) throw new CommandError('decision must be accept, reject or withdraw');
  // Lock the order before the amendment, the same order every order command uses.
  const [ref] = await tx<Row[]>`select order_id,proposed_by,counterparty_id from app.order_amendments where id=${amendmentId}`;
  if (!ref || (actor.id !== String(ref.proposed_by) && actor.id !== String(ref.counterparty_id))) throw new CommandError('Deadline proposal not found', 'FORBIDDEN');
  const order = await orderFor(tx, actor, String(ref.order_id));
  const orderId = String(order.id);
  const [amendment] = await tx<Row[]>`select a.*,a.old_due_at = case a.deadline when 'DELIVERY' then o.delivery_due_at else o.revision_due_at end as deadline_unchanged
    from app.order_amendments a join app.orders o on o.id=a.order_id where a.id=${amendmentId} for update of a`;
  if (amendment!.status !== 'REQUESTED') throw new CommandError(`This proposal is already ${String(amendment!.status).toLowerCase()}`, 'ORDER_STATE_CONFLICT');
  const notifyProposer = (outcome: 'ACCEPTED' | 'REJECTED') => enqueueNotification(tx, orderId, `notify:order.deadline_extension_resolved:${amendmentId}`, {
    templateId: 'order.deadline_extension_resolved', recipientId: String(amendment!.proposed_by), params: { orderRef: orderId, outcome },
  });

  if (decision === 'withdraw') {
    if (actor.id !== String(amendment!.proposed_by)) throw new CommandError('Only the person who proposed it can withdraw', 'FORBIDDEN');
    await tx`update app.order_amendments set status='WITHDRAWN',responded_at=now() where id=${amendmentId}`;
    await orderEvent(tx, orderId, actor.id, 'DEADLINE_EXTENSION_WITHDRAWN', { amendment_id: amendmentId });
    return done(orderId, 'Deadline proposal withdrawn');
  }
  if (actor.id !== String(amendment!.counterparty_id)) throw new CommandError('Only the other party can accept or decline', 'FORBIDDEN');
  if (decision === 'reject') {
    await tx`update app.order_amendments set status='REJECTED',responded_at=now() where id=${amendmentId}`;
    await orderEvent(tx, orderId, actor.id, 'DEADLINE_EXTENSION_REJECTED', { amendment_id: amendmentId });
    await notifyProposer('REJECTED');
    return done(orderId, 'Deadline proposal declined; the current deadline stays');
  }

  // Consent covers the deadline as it was proposed against; a changed deadline or state needs a new proposal.
  const current = currentDeadline(order);
  if (!current || current.deadline !== amendment!.deadline || amendment!.deadline_unchanged !== true) {
    throw new CommandError('The order changed after this proposal was made. Ask for a new proposal.', 'VERSION_CONFLICT');
  }
  const newDue = new Date(amendment!.new_due_at);
  if (newDue.getTime() <= Date.now()) throw new CommandError('The proposed date has already passed. Ask for a new proposal.', 'DOMAIN_RULE');
  await applyAcceptedExtension(tx, orderId, amendmentId, current.deadline, newDue);
  await orderEvent(tx, orderId, actor.id, 'DEADLINE_EXTENDED', { amendment_id: amendmentId, deadline: current.deadline, old_due_at: current.dueAt.toISOString(), new_due_at: newDue.toISOString() });
  await notifyProposer('ACCEPTED');
  return done(orderId, 'Deadline extended');
};

async function applyAcceptedExtension(tx: Tx, orderId: string, amendmentId: string, deadline: 'DELIVERY' | 'REVISION', newDue: Date) {
  // The amendment is accepted first: the delivery-deadline guard looks for it (drizzle/0020).
  await tx`update app.order_amendments set status='ACCEPTED',responded_at=now() where id=${amendmentId}`;
  if (deadline === 'DELIVERY') await tx`update app.orders set delivery_due_at=${newDue.toISOString()},version=version+1,updated_at=now() where id=${orderId}`;
  else await tx`update app.orders set revision_due_at=${newDue.toISOString()},version=version+1,updated_at=now() where id=${orderId}`;
}

export const amendmentCommands: Record<string, CommandHandler> = {
  request_deadline_extension: requestDeadlineExtension,
  respond_deadline_extension: respondDeadlineExtension,
};
