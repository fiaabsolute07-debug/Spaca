/**
 * Operator read models (master §14.3 queues). Authorization is enforced here, not by hiding UI.
 * Provider references are redacted to their last characters; private brief/delivery text is not included.
 */
import type { Actor } from '@/lib/auth';
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

  const [cases, disputes, holds, operations, outbox, reconciling, samples, overdue, flags] = await Promise.all([
    finance ? sql<Row[]>`select c.id,c.kind,c.severity,c.status,c.order_id,c.next_action,c.assigned_to,c.created_at,extract(epoch from now()-c.created_at)::int as age_seconds
      from app.reconciliation_cases c where c.status in ('OPEN','ASSIGNED') order by case c.severity when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end, c.created_at limit 200` : [],
    sql<Row[]>`select d.id,d.order_id,d.status,d.created_at,d.assigned_to,o.status_before_dispute,o.amount_minor,o.currency,extract(epoch from now()-d.created_at)::int as age_seconds
      from app.disputes d join app.orders o on o.id=d.order_id where d.status in ('OPEN','UNDER_REVIEW') order by d.created_at limit 200`,
    finance ? sql<Row[]>`select h.order_id,h.reason,h.delivery_version,h.created_at from app.review_holds h where h.resolved_at is null order by h.created_at limit 200` : [],
    finance ? sql<Row[]>`select p.operation_id,p.kind,p.status,p.order_id,p.provider_reference,p.outcome->>'lastError' as last_error,p.updated_at
      from app.provider_operations p where p.status in ('PENDING','UNKNOWN','FAILED') order by p.updated_at limit 200` : [],
    finance ? sql<Row[]>`select id,semantic_key,status,attempts,available_at from app.outbox where status='FAILED' order by available_at limit 200` : [],
    finance ? sql<Row[]>`select r.order_id,r.bucket_id,r.expires_at from app.reservations r where r.state='RECONCILING' order by r.expires_at limit 200` : [],
    moderation ? sql<Row[]>`select s.id,s.creator_id,s.title,s.url,s.visibility,s.created_at from app.samples s where s.moderation_status='PENDING' order by s.created_at limit 200` : [],
    finance ? sql<Row[]>`select id,status,delivery_due_at from app.orders where status in ('FUNDED','IN_PROGRESS') and delivery_due_at < now() order by delivery_due_at limit 200` : [],
    sql<Row[]>`select key,enabled,description,changed_by,changed_reason,updated_at from app.feature_flags order by key`,
  ]);

  return {
    roles: actor.roles,
    cases,
    disputes: finance ? disputes : disputes.map(({ amount_minor: _amount, currency: _currency, ...rest }) => rest),
    review_holds: holds,
    provider_operations: operations.map((op): Row => ({ ...op, provider_reference: redact(op.provider_reference) })),
    failed_outbox: outbox,
    reconciling_holds: reconciling,
    pending_samples: samples,
    overdue_orders: overdue,
    feature_flags: flags,
  };
}

export async function getAuditLog(actor: Actor, filter: { entityType?: string; entityId?: string; limit?: number } = {}) {
  if (!hasAnyRole(actor, ['finance', 'admin'])) throw new OperatorAccessError();
  return sql<Row[]>`select id,actor_id,actor_roles,action,entity_type,entity_id,reason,before_state,after_state,created_at from app.audit_log
    where (${filter.entityType ?? null}::text is null or entity_type=${filter.entityType ?? null})
      and (${filter.entityId ?? null}::uuid is null or entity_id=${filter.entityId ?? null}::uuid)
    order by created_at desc limit ${Math.min(Math.max(filter.limit ?? 100, 1), 500)}`;
}
