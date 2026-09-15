/**
 * Operator read models (master §14.3 queues). Authorization is enforced here, not by hiding UI.
 * Provider references are redacted to their last characters; private brief/delivery text is not included.
 */
import type { Actor } from '@/lib/auth';
import { UUID_PATTERN } from '@/lib/commands';
import { sql } from '@/lib/db';
import { hasAnyRole } from './policy';

type Row = Record<string, unknown>;

export class OperatorAccessError extends Error {
  constructor() {
    super('Operator access required');
    this.name = 'OperatorAccessError';
  }
}

const redact = (reference: unknown) => (typeof reference === 'string' && reference.length > 6 ? `…${reference.slice(-6)}` : reference ?? null);

export async function getOperatorQueues(actor: Actor) {
  const finance = hasAnyRole(actor, ['finance', 'support', 'admin']);
  const moderation = hasAnyRole(actor, ['moderator', 'admin']);
  if (!finance && !moderation) throw new OperatorAccessError();

  const [cases, disputes, holds, operations, outbox, reconciling, samples, overdue, flags, drift, reports] = await Promise.all([
    finance ? sql<Row[]>`select c.id,c.kind,c.severity,c.status,c.order_id,c.next_action,c.assigned_to,c.created_at,extract(epoch from now()-c.created_at)::int as age_seconds
      from app.reconciliation_cases c where c.status in ('OPEN','ASSIGNED') order by case c.severity when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end, c.created_at limit 200` : [],
    sql<Row[]>`select d.id,d.order_id,d.status,d.created_at,d.assigned_to,o.status_before_dispute,o.amount_minor,o.currency,extract(epoch from now()-d.created_at)::int as age_seconds
      from app.disputes d join app.orders o on o.id=d.order_id where d.status in ('OPEN','UNDER_REVIEW') order by d.created_at limit 200`,
    finance ? sql<Row[]>`select h.order_id,h.reason,h.delivery_version,h.created_at from app.review_holds h where h.resolved_at is null order by h.created_at limit 200` : [],
    // Unresolved outcomes (PENDING, UNKNOWN) come before settled failures so an old FAILED backlog never hides them.
    finance ? sql<Row[]>`select p.operation_id,p.kind,p.status,p.order_id,p.provider_reference,p.outcome->>'lastError' as last_error,p.updated_at
      from app.provider_operations p where p.status in ('PENDING','UNKNOWN','FAILED') order by (p.status='FAILED'), p.updated_at limit 200` : [],
    finance ? sql<Row[]>`select id,semantic_key,status,attempts,available_at from app.outbox where status='FAILED' order by available_at limit 200` : [],
    finance ? sql<Row[]>`select c.order_id,c.creator_id,u.display_name as creator_name,c.units,c.expires_at from app.workload_claims c join app.users u on u.id=c.creator_id
      where c.state='EXPIRY_RECONCILING' order by c.expires_at limit 200` : [],
    moderation ? sql<Row[]>`select s.id,s.creator_id,s.title,s.url,s.storage_asset_id,s.visibility,s.created_at from app.samples s where s.moderation_status='PENDING' order by s.created_at limit 200` : [],
    finance ? sql<Row[]>`select id,status,delivery_due_at from app.orders where status in ('FUNDED','IN_PROGRESS') and delivery_due_at < now() order by delivery_due_at limit 200` : [],
    sql<Row[]>`select key,enabled,description,changed_by,changed_reason,updated_at from app.feature_flags order by key`,
    // Runbook §20.4: counters must equal the sum of claims; any row here means pause the creator and investigate.
    finance ? sql<Row[]>`select d.*,u.display_name as creator_name from app.workload_counter_drift d join app.users u on u.id=d.creator_id limit 200` : [],
    moderation ? sql<Row[]>`select r.id,r.source,r.target_type,r.target_id,r.reason,r.details,r.status,r.created_at,u.display_name as reporter_name
      from app.reports r left join app.users u on u.id=r.reporter_id where r.status in ('OPEN','ASSIGNED') order by r.created_at limit 200` : [],
  ]);

  return {
    roles: actor.roles,
    cases,
    disputes: finance ? disputes : disputes.map(({ amount_minor: _amount, currency: _currency, ...rest }) => rest),
    review_holds: holds,
    provider_operations: operations.map((op): Row => ({ ...op, provider_reference: redact(op.provider_reference) })),
    failed_outbox: outbox,
    reconciling_holds: reconciling,
    workload_drift: drift,
    pending_samples: samples,
    open_reports: reports,
    overdue_orders: overdue,
    feature_flags: flags,
  };
}

export async function getAuditLog(actor: Actor, filter: { entityType?: string; entityId?: string; limit?: number } = {}) {
  if (!hasAnyRole(actor, ['finance', 'admin'])) throw new OperatorAccessError();
  if (filter.entityId && !UUID_PATTERN.test(filter.entityId)) return [];
  return sql<Row[]>`select id,actor_id,actor_roles,action,entity_type,entity_id,reason,before_state,after_state,created_at from app.audit_log
    where (${filter.entityType ?? null}::text is null or entity_type=${filter.entityType ?? null})
      and (${filter.entityId ?? null}::uuid is null or entity_id=${filter.entityId ?? null}::uuid)
    order by created_at desc limit ${Math.min(Math.max(filter.limit ?? 100, 1), 500)}`;
}

/** Operator order view: state, money, provider operations (redacted), cases, disputes and file metadata; no brief or delivery text. */
export async function getOperatorOrder(actor: Actor, orderId: string) {
  if (!hasAnyRole(actor, ['finance', 'support', 'admin'])) throw new OperatorAccessError();
  if (!UUID_PATTERN.test(orderId)) return null;
  const [order] = await sql<Row[]>`select o.id,o.source,o.source_ref,o.title,o.status,o.status_before_dispute,o.payment_status,o.settlement_status,o.amount_minor,o.currency,
      o.platform_fee_minor,o.provider_fee_minor,o.cancellation_refund_minor,o.funded_at,o.delivery_due_at,o.review_due_at,o.approved_at,o.completed_at,o.cancelled_at,o.version,o.created_at,
      o.buyer_id,bu.display_name as buyer_name,o.creator_id,cu.display_name as creator_name
    from app.orders o join app.users bu on bu.id=o.buyer_id join app.users cu on cu.id=o.creator_id where o.id=${orderId}`;
  if (!order) return null;
  const [events, operations, cases, disputes, files, holds] = await Promise.all([
    sql<Row[]>`select kind,actor_id,created_at from app.order_events where order_id=${orderId} order by created_at`,
    sql<Row[]>`select operation_id,kind,status,provider_reference,outcome->>'lastError' as last_error,updated_at from app.provider_operations where order_id=${orderId} order by created_at`,
    sql<Row[]>`select id,kind,severity,status,next_action,assigned_to,resolution,created_at from app.reconciliation_cases where order_id=${orderId} order by created_at`,
    sql<Row[]>`select id,status,outcome,refund_amount_minor,assigned_to,created_at,resolved_at from app.disputes where order_id=${orderId} order by created_at`,
    sql<Row[]>`select id,purpose,filename,mime,size_bytes,lifecycle_state,scan_detail,created_at from app.storage_assets where order_id=${orderId} and lifecycle_state <> 'DELETED' order by created_at`,
    sql<Row[]>`select reason,delivery_version,created_at,resolved_at,resolution from app.review_holds where order_id=${orderId} order by created_at`,
  ]);
  return {
    order,
    events,
    provider_operations: operations.map((op): Row => ({ ...op, provider_reference: redact(op.provider_reference) })),
    cases,
    disputes,
    files,
    review_holds: holds,
  };
}

/** User lookup for suspension and role grants (moderator/admin). Matches email or display name; returns active grants. */
export async function searchOperatorUsers(actor: Actor, query: string) {
  if (!hasAnyRole(actor, ['moderator', 'admin'])) throw new OperatorAccessError();
  const term = query.trim().slice(0, 120);
  if (term.length < 2) return [];
  return sql<Row[]>`select u.id,u.email,u.display_name,u.status,u.roles as marketplace_roles,u.is_test,u.created_at,
      coalesce((select array_agg(r.role order by r.role) from app.user_roles r where r.user_id=u.id and r.revoked_at is null), '{}') as grants
    from app.users u where u.email ilike ${`%${term}%`} or u.display_name ilike ${`%${term}%`} order by u.created_at desc limit 50`;
}
