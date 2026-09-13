/**
 * Order lifecycle rules shared by commands, funding and jobs (master §7). The database enforces the
 * transition matrix (drizzle/0004); these helpers compute clocks and evidence consistently.
 */
import { CommandError, type Row, type Tx } from '@/lib/commands';
import { enqueueNotification } from '@/modules/notifications/enqueue';

export const REVISION_TURNAROUND_HOURS = 48;
export const DEFAULT_REVIEW_WINDOW_HOURS = 72;
export const MIN_DELIVERY_NOTE_CHARS = 20;

export type OrderTerms = { turnaroundHours: number; revisionLimit: number; reviewWindowHours: number; autoAcceptConsent: boolean };

export function termsOf(order: Row): OrderTerms {
  const terms = (order.terms ?? {}) as Record<string, unknown>;
  return {
    turnaroundHours: Number(terms.turnaround_hours ?? 72),
    revisionLimit: Number(terms.revision_limit ?? 1),
    reviewWindowHours: Number(terms.review_window_hours ?? DEFAULT_REVIEW_WINDOW_HOURS),
    autoAcceptConsent: terms.auto_accept_consent === true,
  };
}

/**
 * ORD-03/04: the work clock starts at max(funded_at, brief_ready_at) and the due date is fixed once set.
 * Creator start clicks never move it.
 */
export async function recomputeWorkClock(tx: Tx, orderId: string): Promise<void> {
  await tx`update app.orders set
      work_start_at = greatest(funded_at, brief_ready_at),
      delivery_due_at = coalesce(delivery_due_at, greatest(funded_at, brief_ready_at) + (coalesce((terms->>'turnaround_hours')::int, 72) * interval '1 hour'))
    where id=${orderId} and funded_at is not null and brief_ready_at is not null and work_start_at is null`;
}

export async function latestDelivery(tx: Tx, orderId: string): Promise<Row | undefined> {
  const [delivery] = await tx<Row[]>`select * from app.deliveries where order_id=${orderId} order by version desc limit 1`;
  return delivery;
}

/** ORD-08: mutations that act on a delivery must name the version the actor saw. */
export async function assertCurrentDelivery(tx: Tx, orderId: string, deliveryVersion: number | null): Promise<Row> {
  const delivery = await latestDelivery(tx, orderId);
  if (!delivery) throw new CommandError('There is no delivery to act on yet', 'ORDER_STATE_CONFLICT');
  if (deliveryVersion === null) throw new CommandError('delivery_version is required so the right version is approved or revised');
  if (Number(delivery.version) !== deliveryVersion) {
    throw new CommandError(`A newer delivery (version ${delivery.version}) exists. Reload and review it first.`, 'VERSION_CONFLICT');
  }
  if (delivery.validation_status !== 'VALID') throw new CommandError('This delivery is not available for review', 'ORDER_STATE_CONFLICT');
  return delivery;
}

export async function resolveReviewHold(tx: Tx, orderId: string, resolution: 'BUYER_VIEWED' | 'BUYER_ACTED' | 'OPERATOR' | 'SUPERSEDED'): Promise<boolean> {
  const resolved = await tx`update app.review_holds set resolved_at=now(),resolution=${resolution} where order_id=${orderId} and resolved_at is null returning id`;
  return resolved.length > 0;
}

export async function expirePendingCancellation(tx: Tx, orderId: string): Promise<void> {
  const expired = await tx<Row[]>`update app.cancellation_requests set status='EXPIRED',responded_at=now() where order_id=${orderId} and status='REQUESTED' returning id,requested_by`;
  for (const request of expired) {
    await tx`insert into app.order_events (order_id,actor_id,kind,payload) values (${orderId},${null},'CANCELLATION_EXPIRED',${JSON.stringify({ request_id: String(request.id) })}::jsonb)`;
    await enqueueNotification(tx, orderId, `notify:order.cancellation_resolved:${String(request.id)}:EXPIRED`, {
      templateId: 'order.cancellation_resolved', recipientId: String(request.requested_by), params: { orderRef: orderId, outcome: 'EXPIRED' },
    });
  }
}

/**
 * Buyer opened the latest delivery (§7.5 evidence). Clears a notification-evidence hold and restarts a full
 * review window from now (ORD-11). Idempotent per delivery version.
 */
export async function recordBuyerView(tx: Tx, order: Row): Promise<{ recorded: boolean; resumed: boolean }> {
  const delivery = await latestDelivery(tx, String(order.id));
  if (!delivery || delivery.buyer_viewed_at) return { recorded: false, resumed: false };
  await tx`update app.deliveries set buyer_viewed_at=now() where id=${String(delivery.id)} and buyer_viewed_at is null`;
  const [hold] = await tx<Row[]>`select id,reason from app.review_holds where order_id=${String(order.id)} and resolved_at is null for update`;
  if (hold && order.status === 'DELIVERED' && hold.reason === 'NO_BUYER_NOTIFICATION_EVIDENCE') {
    await resolveReviewHold(tx, String(order.id), 'BUYER_VIEWED');
    const window = termsOf(order).reviewWindowHours;
    await tx`update app.orders set review_due_at=now() + (${window} * interval '1 hour'),updated_at=now() where id=${String(order.id)}`;
    await tx`insert into app.order_events (order_id,actor_id,kind,payload) values (${String(order.id)},${String(order.buyer_id)},'REVIEW_WINDOW_RESUMED',${JSON.stringify({ delivery_version: Number(delivery.version), review_window_hours: window })}::jsonb)`;
    return { recorded: true, resumed: true };
  }
  return { recorded: true, resumed: false };
}

export type ReputationSummary = {
  completed_jobs: number;
  on_time_rate: number | null;
  on_time_sample: number;
  rating: number | null;
  review_count: number;
  repeat_buyers: number;
};

/**
 * REV-03: metrics from real completed orders only. Test fixtures are excluded unless
 * REPUTATION_INCLUDE_TEST_DATA=true (local demos). N is reported and null means "—".
 */
export async function creatorReputation(db: Tx | import('postgres').Sql, creatorId: string): Promise<ReputationSummary> {
  const includeTest = process.env.REPUTATION_INCLUDE_TEST_DATA === 'true';
  const [row] = await db<Row[]>`with eligible as (
      select o.* from app.orders o join app.users b on b.id=o.buyer_id join app.users c on c.id=o.creator_id
      where o.creator_id=${creatorId} and o.status='COMPLETED' and (${includeTest} or (not b.is_test and not c.is_test))
    ), first_delivery as (
      select e.id, e.delivery_due_at, min(d.created_at) as first_valid_at from eligible e
      join app.deliveries d on d.order_id=e.id and d.validation_status='VALID' group by e.id, e.delivery_due_at
    )
    select
      (select count(*)::int from eligible) as completed_jobs,
      (select count(*)::int from first_delivery where delivery_due_at is not null) as on_time_sample,
      (select count(*)::int from first_delivery where delivery_due_at is not null and first_valid_at <= delivery_due_at) as on_time_count,
      (select count(*)::int from app.reviews r join eligible e on e.id=r.order_id where r.reviewer_id=e.buyer_id) as review_count,
      (select round(avg(r.rating)::numeric, 1)::text from app.reviews r join eligible e on e.id=r.order_id where r.reviewer_id=e.buyer_id) as rating,
      (select count(*)::int from (select buyer_id from eligible group by buyer_id having count(*) >= 2) repeaters) as repeat_buyers`;
  const sample = Number(row!.on_time_sample);
  return {
    completed_jobs: Number(row!.completed_jobs),
    on_time_rate: sample === 0 ? null : Number(row!.on_time_count) / sample,
    on_time_sample: sample,
    rating: row!.rating === null ? null : Number(row!.rating),
    review_count: Number(row!.review_count),
    repeat_buyers: Number(row!.repeat_buyers),
  };
}
