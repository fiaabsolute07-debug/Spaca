/**
 * Report queue (MOD-01, P6-07). Anyone signed in can report what they can see; a moderator resolves it with a reason
 * and at most one proportionate action. Evidence rows are never deleted; every resolution is audited.
 */
import { CommandError, text, uuid, type CommandHandler, type Row, type Tx } from '@/lib/commands';
import type { Actor } from '@/lib/auth';
import { audit, reasonOf, requireRole } from '@/modules/admin/policy';
import { withdrawOpenOffers } from '@/modules/requests/commands';

export const REPORT_TARGETS = ['REQUEST', 'ORDER', 'SERVICE', 'PROFILE', 'SAMPLE', 'PUBLISH_PROOF'] as const;
export const REPORT_REASONS = ['UNDISCLOSED_PROMOTION', 'FAKE_ENGAGEMENT', 'GUARANTEED_RETURNS', 'DECEPTIVE_SCRIPT', 'IMPERSONATION', 'POST_REMOVED_EARLY', 'SPAM', 'OTHER'] as const;
const ACTIONS_BY_TARGET: Record<string, string[]> = {
  REQUEST: ['NONE', 'CLOSE_REQUEST', 'SUSPEND_USER'],
  SERVICE: ['NONE', 'PAUSE_SERVICE', 'SUSPEND_USER'],
  PROFILE: ['NONE', 'SUSPEND_USER'],
  SAMPLE: ['NONE', 'REJECT_SAMPLE', 'SUSPEND_USER'],
  ORDER: ['NONE', 'SUSPEND_USER'],
  PUBLISH_PROOF: ['NONE', 'SUSPEND_USER'],
};

/** Returns the account responsible for the target, or throws when the reporter cannot see it. */
async function visibleTargetOwner(tx: Tx, actor: Actor, type: string, id: string): Promise<string> {
  const notFound = () => new CommandError('That item was not found or is not visible to you', 'NOT_FOUND');
  switch (type) {
    case 'REQUEST': {
      const [row] = await tx<Row[]>`select buyer_id,status from app.requests where id=${id}`;
      if (!row) throw notFound();
      return String(row.buyer_id);
    }
    case 'SERVICE': {
      const [row] = await tx<Row[]>`select creator_id,status from app.services where id=${id}`;
      if (!row || (row.status !== 'PUBLISHED' && String(row.creator_id) !== actor.id)) throw notFound();
      return String(row.creator_id);
    }
    case 'PROFILE': {
      const [row] = await tx<Row[]>`select user_id from app.profiles where user_id=${id}`;
      if (!row) throw notFound();
      return String(row.user_id);
    }
    case 'SAMPLE': {
      const [row] = await tx<Row[]>`select creator_id from app.samples where id=${id} and visibility='PUBLIC' and moderation_status='APPROVED'`;
      if (!row) throw notFound();
      return String(row.creator_id);
    }
    case 'ORDER':
    case 'PUBLISH_PROOF': {
      const [row] = type === 'ORDER'
        ? await tx<Row[]>`select buyer_id,creator_id from app.orders where id=${id}`
        : await tx<Row[]>`select o.buyer_id,o.creator_id from app.publish_proofs p join app.orders o on o.id=p.order_id where p.id=${id}`;
      if (!row || ![String(row.buyer_id), String(row.creator_id)].includes(actor.id)) throw notFound();
      // In an order the counterparty is the one being reported.
      return String(row.buyer_id) === actor.id ? String(row.creator_id) : String(row.buyer_id);
    }
    default:
      throw new CommandError('Unsupported report target');
  }
}

const reportContent: CommandHandler = async ({ tx, actor, form }) => {
  const targetType = text(form, 'target_type');
  if (!(REPORT_TARGETS as readonly string[]).includes(targetType)) throw new CommandError('Unsupported report target');
  const reason = text(form, 'reason');
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) throw new CommandError('Choose a report reason');
  const details = text(form, 'details', true, 2000);
  if (details.length < 10) throw new CommandError('Describe the problem in at least 10 characters');
  const targetId = uuid(form, 'target_id');
  const owner = await visibleTargetOwner(tx, actor, targetType, targetId);
  if (owner === actor.id) throw new CommandError('You cannot report your own content', 'FORBIDDEN');
  const [report] = await tx<Row[]>`insert into app.reports (reporter_id,source,target_type,target_id,reason,details)
    values (${actor.id},'USER',${targetType},${targetId},${reason},${details})
    on conflict do nothing returning id`;
  // An empty path sends the reporter back to the page they reported from (return_to).
  return { path: '', message: report ? 'Report sent to the moderation team' : 'You already reported this; it is in the queue', ...(report ? { id: String(report.id) } : {}) };
};

const resolveReport: CommandHandler = async ({ tx, actor, form }) => {
  requireRole(actor, ['moderator', 'admin'], 'Report moderation');
  const reason = reasonOf(form);
  const reportId = uuid(form, 'report_id');
  const decision = text(form, 'decision');
  if (!['ACTIONED', 'DISMISSED'].includes(decision)) throw new CommandError('decision must be ACTIONED or DISMISSED');
  const [report] = await tx<Row[]>`select * from app.reports where id=${reportId} for update`;
  if (!report) throw new CommandError('Report not found', 'NOT_FOUND');
  if (!['OPEN', 'ASSIGNED'].includes(String(report.status))) throw new CommandError('This report is already resolved', 'ORDER_STATE_CONFLICT');
  const action = decision === 'DISMISSED' ? 'NONE' : text(form, 'action', false) || 'NONE';
  if (!ACTIONS_BY_TARGET[String(report.target_type)]!.includes(action)) throw new CommandError(`Action ${action} does not apply to a ${String(report.target_type).toLowerCase()} report`);
  const targetId = String(report.target_id);
  let effect: Record<string, unknown> = {};

  if (action === 'CLOSE_REQUEST') {
    const [request] = await tx<Row[]>`select status from app.requests where id=${targetId} for update`;
    if (request && ['OPEN', 'FILLED'].includes(String(request.status))) {
      const withdrawn = await withdrawOpenOffers(tx, targetId, 'Request closed by moderation');
      await tx`update app.requests set status='CLOSED',closed_at=now(),version=version+1,updated_at=now() where id=${targetId}`;
      effect = { request_status: 'CLOSED', offers_withdrawn: withdrawn };
    }
  } else if (action === 'PAUSE_SERVICE') {
    const updated = await tx`update app.services set status='PAUSED',version=version+1,updated_at=now() where id=${targetId} and status='PUBLISHED' returning id`;
    effect = { service_status: updated.length ? 'PAUSED' : 'unchanged' };
  } else if (action === 'REJECT_SAMPLE') {
    await tx`update app.samples set moderation_status='REJECTED',moderated_by=${actor.id},moderated_at=now(),moderation_reason=${reason} where id=${targetId}`;
    effect = { sample_status: 'REJECTED' };
  } else if (action === 'SUSPEND_USER') {
    const owner = await ownerOf(tx, String(report.target_type), targetId, report.reporter_id ? String(report.reporter_id) : null);
    if (!owner) throw new CommandError('Could not find the account behind this report', 'NOT_FOUND');
    if (owner === actor.id) throw new CommandError('You cannot suspend your own account', 'FORBIDDEN');
    const [privileged] = await tx<Row[]>`select 1 from app.user_roles where user_id=${owner} and revoked_at is null and role='admin'`;
    if (privileged) throw new CommandError('Admin accounts are handled on the Users page by another admin', 'FORBIDDEN');
    // SEC-10: suspension blocks new activity only; existing orders, refunds and payouts continue.
    await tx`update app.users set status='SUSPENDED' where id=${owner} and status='ACTIVE'`;
    effect = { suspended_user: owner };
  }

  await tx`update app.reports set status=${decision},action=${action},resolution=${reason},resolved_by=${actor.id},resolved_at=now(),updated_at=now() where id=${reportId}`;
  await audit(tx, actor, `report.${decision.toLowerCase()}`, 'report', reportId, reason, { status: report.status }, { status: decision, action, ...effect });
  return { path: '/admin/moderation', message: decision === 'DISMISSED' ? 'Report dismissed' : `Report actioned (${action.toLowerCase().replace('_', ' ')})` };
};

async function ownerOf(tx: Tx, type: string, id: string, reporterId: string | null): Promise<string | null> {
  if (type === 'REQUEST') return (await tx<Row[]>`select buyer_id as owner from app.requests where id=${id}`)[0]?.owner ?? null;
  if (type === 'SERVICE') return (await tx<Row[]>`select creator_id as owner from app.services where id=${id}`)[0]?.owner ?? null;
  if (type === 'PROFILE') return id;
  if (type === 'SAMPLE') return (await tx<Row[]>`select creator_id as owner from app.samples where id=${id}`)[0]?.owner ?? null;
  const [order] = type === 'ORDER'
    ? await tx<Row[]>`select buyer_id,creator_id from app.orders where id=${id}`
    : await tx<Row[]>`select o.buyer_id,o.creator_id from app.publish_proofs p join app.orders o on o.id=p.order_id where p.id=${id}`;
  if (!order) return null;
  return String(order.buyer_id) === reporterId ? String(order.creator_id) : String(order.buyer_id);
}

export const moderationCommands: Record<string, CommandHandler> = {
  report_content: reportContent,
  admin_resolve_report: resolveReport,
};
