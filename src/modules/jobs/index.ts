/**
 * Durable background jobs (master §14.1). Each job re-checks state under row locks at execution time,
 * so it is safe to run late, repeatedly, or concurrently. Scheduling is external: Inngest/cron in a
 * deployed environment, `POST /api/dev/jobs` locally.
 *
 * The local MockPaymentProvider keeps state in the Next.js process, so provider-touching jobs must run
 * in that same process (the dev route does).
 */
import { sql } from '@/lib/db';
import { NotificationDispatcher, NotificationError, type NotificationTemplateId } from '@/modules/notifications';
import { DatabaseNotificationSink } from '@/modules/notifications/store';
import {
  PaymentFlowError,
  applyFetchedProviderFact,
  cancelOpenFunding,
  deliverPendingMockWebhooks,
  eventFromInboxRow,
  getMockPaymentProvider,
  mockPaymentsEnabled,
  openCase,
  processVerifiedEvent,
  refundReasonFor,
  requestCreatorRelease,
  requestProviderRefund,
} from '@/modules/payments/funding';
import { isProviderError } from '@/modules/payments/providers';
import { enqueueNotification } from '@/modules/notifications/enqueue';
import { approveOrder } from '@/modules/orders/commands';
import { latestDelivery, termsOf } from '@/modules/orders/lifecycle';
import { FINALIZE_GRACE_SECONDS, type StorageBucket } from '@/modules/storage/policy';
import { getStorageProvider } from '@/modules/storage/provider';

type Row = Record<string, unknown>;

export type JobReport = { job: string; examined: number; outcomes: Record<string, number> };

function report(job: string) {
  const result: JobReport = { job, examined: 0, outcomes: {} };
  const tally = (outcome: string) => {
    result.examined += 1;
    result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
  };
  return { result, tally };
}

const ageFilter = (seconds: number) => Math.max(0, Math.floor(seconds));

/** `orderId` narrows a job to one order (operator retry of a single case; deterministic tests). */
export type JobScope = { limit?: number; orderId?: string };
const scoped = (column: ReturnType<typeof sql>, options: JobScope) => (options.orderId ? sql`${column}=${options.orderId}` : sql`true`);

/** Releases expired checkout holds only after any open provider payment is cancelled (master §6.3). */
export async function expireCheckoutHolds(options: JobScope = {}): Promise<JobReport> {
  const { result, tally } = report('expire_checkout_holds');
  const candidates = await sql<Row[]>`select r.order_id from app.reservations r join app.orders o on o.id=r.order_id
    where r.state in ('HELD','RECONCILING') and r.expires_at < now() and o.status='AWAITING_PAYMENT' and ${scoped(sql`o.id`, options)}
    order by r.expires_at asc limit ${options.limit ?? 50}`;
  for (const candidate of candidates) {
    const orderId = String(candidate.order_id);
    try {
      tally(await sql.begin(async (tx) => {
        const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} and status='AWAITING_PAYMENT' for update`;
        const [reservation] = await tx<Row[]>`select * from app.reservations where order_id=${orderId} and state in ('HELD','RECONCILING') and expires_at < now() for update`;
        if (!order || !reservation) return 'SKIPPED_STATE_CHANGED';
        try {
          if (mockPaymentsEnabled()) await cancelOpenFunding(tx, orderId);
        } catch (error) {
          if (!(error instanceof PaymentFlowError)) throw error;
          if (reservation.state === 'HELD') {
            await tx`update app.reservations set state='RECONCILING' where id=${String(reservation.id)}`;
            await openCase(tx, orderId, null, 'HOLD_EXPIRED_PAYMENT_UNRESOLVED', 'MEDIUM', error.message);
            await tx`insert into app.order_events (order_id,actor_id,kind,payload) values (${orderId},${null},'HOLD_RECONCILING',${JSON.stringify({ reason: error.message })}::jsonb)`;
          }
          return 'RECONCILING';
        }
        await tx`update app.reservations set state='RELEASED' where id=${String(reservation.id)}`; // counters via DB trigger
        await tx`update app.orders set status='CANCELLED',version=version+1,updated_at=now() where id=${orderId}`;
        await tx`insert into app.order_events (order_id,actor_id,kind,payload) values (${orderId},${null},'HOLD_EXPIRED',${JSON.stringify({ released_units: 1 })}::jsonb)`;
        if (order.source === 'AUCTION' && order.source_ref) {
          await tx`update app.auctions set status='EXPIRED',updated_at=now() where id=${String(order.source_ref)} and status='AWAITING_WINNER_PAYMENT'`;
        }
        return 'RELEASED';
      }));
    } catch (error) {
      console.error('expire_checkout_holds failed', orderId, error);
      tally('ERROR');
    }
  }
  return result;
}

/** Re-applies verified inbox rows whose processing failed earlier. */
export async function reprocessWebhookInbox(options: JobScope & { minAgeSeconds?: number; maxAttempts?: number } = {}): Promise<JobReport> {
  const { result, tally } = report('reprocess_webhook_inbox');
  const rows = await sql<Row[]>`select * from app.webhook_inbox where provider='mock' and processed_at is null
    and attempts < ${options.maxAttempts ?? 10} and ${options.orderId ? sql`payload->>'orderId'=${options.orderId}` : sql`true`} and created_at < now() - (${ageFilter(options.minAgeSeconds ?? 30)} * interval '1 second')
    order by created_at asc limit ${options.limit ?? 50}`;
  for (const row of rows) {
    try {
      tally((await processVerifiedEvent(eventFromInboxRow(row))).outcome);
    } catch (error) {
      console.error('reprocess_webhook_inbox failed', row.event_id, error);
      tally('ERROR');
    }
  }
  return result;
}

/**
 * Resolves PENDING/UNKNOWN provider operations with lookups (never with new keys), retries money-moving
 * operations under the same operation id, and fetches provider status for facts whose webhook is missing.
 */
export async function reconcileProviderOperations(options: JobScope & { minAgeSeconds?: number } = {}): Promise<JobReport> {
  const { result, tally } = report('reconcile_provider_operations');
  if (!mockPaymentsEnabled()) return result;
  const provider = getMockPaymentProvider();
  const minAge = ageFilter(options.minAgeSeconds ?? 60);
  const limit = options.limit ?? 50;

  const unresolved = await sql<Row[]>`select * from app.provider_operations where provider='mock' and status in ('PENDING','UNKNOWN') and ${scoped(sql`order_id`, options)}
    and updated_at < now() - (${minAge} * interval '1 second') order by updated_at asc limit ${limit}`;
  for (const operation of unresolved) {
    const operationId = String(operation.operation_id);
    try {
      const lookup = await provider.lookupOperation(operationId);
      if (lookup?.state === 'APPLIED') {
        await sql`update app.provider_operations set status='SUCCEEDED',provider_reference=${lookup.reference},
          outcome=coalesce(outcome,'{}'::jsonb)-'lastError',updated_at=now() where id=${String(operation.id)} and status in ('PENDING','UNKNOWN')`;
        tally('RESOLVED_APPLIED');
      } else if (operation.kind === 'funding.create' || operation.kind === 'funding.cancel') {
        // No money moved; the next attempt is free to start a new intent.
        await sql`update app.provider_operations set status='FAILED',
          outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('lastError','NOT_APPLIED_AT_PROVIDER'),updated_at=now()
          where id=${String(operation.id)} and status in ('PENDING','UNKNOWN')`;
        tally('RESOLVED_NOT_APPLIED');
      } else {
        tally(await sql.begin(async (tx) => {
          const [order] = await tx<Row[]>`select * from app.orders where id=${String(operation.order_id)} for update`;
          if (operation.kind === 'refund.create' && order?.payment_status === 'REFUND_PENDING') {
            return `RETRIED_SAME_OPERATION_${(await requestProviderRefund(tx, order, refundReasonFor(order.status))).state}`;
          }
          if (operation.kind === 'release.create' && order && ['READY', 'PENDING'].includes(String(order.settlement_status))) {
            return `RETRIED_SAME_OPERATION_${(await requestCreatorRelease(tx, order)).state}`;
          }
          return 'SKIPPED_STATE_CHANGED';
        }));
      }
    } catch (error) {
      console.error('reconcile_provider_operations failed', operationId, error);
      tally('ERROR');
    }
  }

  const awaitingFacts = await sql<Row[]>`select * from app.provider_operations where provider='mock' and status='SUCCEEDED' and provider_reference is not null and ${scoped(sql`order_id`, options)}
    and updated_at < now() - (${minAge} * interval '1 second') and (
      (kind='funding.create' and coalesce(outcome->>'fundingStatus','') not in ('SUCCEEDED','FAILED','CANCELED'))
      or (kind='refund.create' and coalesce(outcome->>'refundStatus','') not in ('SUCCEEDED','FAILED'))
      or (kind='release.create' and coalesce(outcome->>'releaseStatus','') not in ('SUCCEEDED','FAILED')))
    order by updated_at asc limit ${limit}`;
  for (const operation of awaitingFacts) {
    const reference = String(operation.provider_reference);
    const operationId = String(operation.operation_id);
    try {
      if (operation.kind === 'funding.create') {
        const status = await provider.getFundingStatus(reference);
        if (!['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status.status)) { tally('PROVIDER_STILL_PENDING'); continue; }
        const receipt = await applyFetchedProviderFact({
          type: `funding.${status.status.toLowerCase()}` as 'funding.succeeded', objectType: 'funding', reference, fundingReference: reference,
          operationId, orderId: status.orderId, status: status.status, amount: status.amount, currency: status.currency, providerFee: status.providerFee,
        });
        tally(`FETCHED_${receipt.outcome}`);
      } else {
        const status = operation.kind === 'refund.create' ? await provider.getRefundStatus(reference) : await provider.getReleaseStatus(reference);
        if (status.status === 'PENDING') { tally('PROVIDER_STILL_PENDING'); continue; }
        const objectType = operation.kind === 'refund.create' ? 'refund' : 'release';
        const receipt = await applyFetchedProviderFact({
          type: `${objectType}.${status.status.toLowerCase()}` as 'refund.succeeded', objectType, reference, fundingReference: status.fundingReference,
          operationId, orderId: status.orderId, status: status.status, amount: status.amount, currency: status.currency, providerFee: null,
        });
        tally(`FETCHED_${receipt.outcome}`);
      }
    } catch (error) {
      if (isProviderError(error, 'NOT_FOUND')) {
        await sql.begin((tx) => openCase(tx, operation.order_id ? String(operation.order_id) : null, String(operation.id), 'PROVIDER_OBJECT_MISSING', 'HIGH', 'Provider has no record of this reference; verify manually'));
        tally('PROVIDER_OBJECT_MISSING');
      } else {
        console.error('reconcile fetch failed', operationId, error);
        tally('ERROR');
      }
    }
  }
  await deliverPendingMockWebhooks();
  return result;
}

/** Releases creator entitlement for approved, undisputed, provider-funded orders. */
export async function releaseReadySettlements(options: JobScope = {}): Promise<JobReport> {
  const { result, tally } = report('release_ready_settlements');
  if (!mockPaymentsEnabled()) return result;
  // Approved orders, or mutually cancelled orders whose agreed refund left a creator remainder (ORD-15).
  const readyCondition = sql`o.settlement_status='READY'
    and ((o.status='APPROVED' and o.payment_status='SUCCEEDED')
      or (o.status='CANCELLED' and o.cancellation_refund_minor is not null and o.cancellation_refund_minor < o.amount_minor
          and o.payment_status in ('SUCCEEDED','REFUND_PENDING','PARTIALLY_REFUNDED')))
    and not exists (select 1 from app.disputes d where d.order_id=o.id and d.status in ('OPEN','UNDER_REVIEW'))`;
  const ready = await sql<Row[]>`select o.id from app.orders o where ${readyCondition} and ${scoped(sql`o.id`, options)} order by o.updated_at asc limit ${options.limit ?? 50}`;
  for (const candidate of ready) {
    try {
      tally(await sql.begin(async (tx) => {
        const [order] = await tx<Row[]>`select o.* from app.orders o where o.id=${String(candidate.id)} and ${readyCondition} for update of o`;
        if (!order) return 'SKIPPED_STATE_CHANGED';
        const release = await requestCreatorRelease(tx, order);
        return release.state === 'READY' ? 'RELEASE_REQUESTED' : `RELEASE_${release.state}_${release.code}`;
      }));
    } catch (error) {
      if (error instanceof PaymentFlowError) tally(`BLOCKED_${error.code}`);
      else { console.error('release_ready_settlements failed', candidate.id, error); tally('ERROR'); }
    }
  }
  await deliverPendingMockWebhooks();
  return result;
}

const MAX_OUTBOX_ATTEMPTS = 5;

/** Claims notification outbox rows (skip locked) and delivers them through the deduplicating dispatcher. */
export async function dispatchNotificationOutbox(options: JobScope & { dispatcher?: NotificationDispatcher } = {}): Promise<JobReport> {
  const { result, tally } = report('dispatch_notification_outbox');
  const dispatcher = options.dispatcher ?? new NotificationDispatcher({ sink: new DatabaseNotificationSink() });
  const claimed = await sql<Row[]>`update app.outbox set status='PROCESSING',attempts=attempts+1,available_at=now()
    where id in (select id from app.outbox where topic='notification' and attempts < ${MAX_OUTBOX_ATTEMPTS} and ${scoped(sql`aggregate_id`, options)} and (
        (status in ('PENDING','FAILED') and available_at <= now())
        or (status='PROCESSING' and available_at < now() - interval '5 minutes'))
      order by created_at asc limit ${options.limit ?? 50} for update skip locked)
    returning *`;
  for (const row of claimed) {
    const payload = row.payload as Row;
    const params = { ...((payload.params as Row | undefined) ?? {}) };
    if (typeof params.amount === 'string') params.amount = BigInt(params.amount);
    try {
      const outcomes = await dispatcher.dispatch({
        recipientId: String(payload.recipientId),
        templateId: String(payload.templateId) as NotificationTemplateId,
        semanticEventKey: String(row.semantic_key),
        params: params as never,
      });
      if (outcomes.some((outcome) => outcome.status === 'FAILED')) {
        await sql`update app.outbox set status='FAILED',available_at=now() + (${2 ** Number(row.attempts) * 30} * interval '1 second') where id=${String(row.id)}`;
        tally('RETRY_SCHEDULED');
      } else {
        await sql`update app.outbox set status='SENT',sent_at=now() where id=${String(row.id)}`;
        tally('SENT');
      }
    } catch (error) {
      // Invalid template/params never succeed on retry: park the row for an operator.
      const poison = error instanceof NotificationError;
      await sql`update app.outbox set status='FAILED',attempts=${poison ? MAX_OUTBOX_ATTEMPTS : Number(row.attempts)},
        available_at=now() + interval '5 minutes' where id=${String(row.id)}`;
      if (!poison) console.error('dispatch_notification_outbox failed', row.semantic_key, error);
      tally(poison ? 'POISONED' : 'ERROR');
    }
  }
  return result;
}

/**
 * ORD-09/11/16: approve delivered orders whose review window ended, only for the current valid delivery,
 * with consent, no dispute or pending cancellation, and evidence the buyer saw the delivery. Otherwise a
 * single ReviewHold is created for operators; the order stays DELIVERED (no extra enum).
 */
export async function autoAcceptDeliveries(options: JobScope = {}): Promise<JobReport> {
  const { result, tally } = report('auto_accept_deliveries');
  const candidates = await sql<Row[]>`select o.id from app.orders o where o.status='DELIVERED' and o.review_due_at < now() and ${scoped(sql`o.id`, options)}
    and not exists (select 1 from app.review_holds h where h.order_id=o.id and h.resolved_at is null)
    order by o.review_due_at asc limit ${options.limit ?? 50}`;
  for (const candidate of candidates) {
    const orderId = String(candidate.id);
    try {
      tally(await sql.begin(async (tx) => {
        const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} and status='DELIVERED' and review_due_at < now() for update`;
        if (!order) return 'SKIPPED_STATE_CHANGED';
        const [activeHold] = await tx<Row[]>`select id from app.review_holds where order_id=${orderId} and resolved_at is null`;
        if (activeHold) return 'SKIPPED_ON_HOLD';
        const [blocker] = await tx<Row[]>`select 'dispute' as kind from app.disputes where order_id=${orderId} and status in ('OPEN','UNDER_REVIEW')
          union all select 'cancellation' from app.cancellation_requests where order_id=${orderId} and status='REQUESTED' limit 1`;
        if (blocker) return `SKIPPED_${String(blocker.kind).toUpperCase()}`;
        const delivery = await latestDelivery(tx, orderId);
        const hold = async (reason: string) => {
          await tx`insert into app.review_holds (order_id,delivery_version,reason) values (${orderId},${Number(delivery?.version ?? 1)},${reason})`;
          await tx`insert into app.order_events (order_id,actor_id,kind,payload) values (${orderId},${null},'REVIEW_HOLD_CREATED',${JSON.stringify({ reason, delivery_version: Number(delivery?.version ?? 0) })}::jsonb)`;
          await openCase(tx, orderId, null, 'REVIEW_HOLD', 'MEDIUM', `Auto-accept paused: ${reason}`);
          return `HOLD_${reason}`;
        };
        if (!delivery || delivery.validation_status !== 'VALID') return hold('DELIVERY_NOT_VALID');
        const [unsafeFile] = await tx<Row[]>`select 1 from app.delivery_assets da join app.storage_assets a on a.id=da.asset_id
          where da.delivery_id=${delivery.id} and a.lifecycle_state <> 'READY' limit 1`;
        if (unsafeFile) return hold('DELIVERY_NOT_VALID');
        if (!termsOf(order).autoAcceptConsent) return hold('NO_AUTO_ACCEPT_CONSENT');
        if (!delivery.buyer_viewed_at) return hold('NO_BUYER_NOTIFICATION_EVIDENCE');
        await approveOrder(tx, order, null, Number(delivery.version), 'ORDER_AUTO_APPROVED');
        return 'AUTO_APPROVED';
      }));
    } catch (error) {
      console.error('auto_accept_deliveries failed', orderId, error);
      tally('ERROR');
    }
  }
  return result;
}

/** Review reminder 24h before auto-accept, due-soon to the creator, overdue notice to the buyer (§14.1). Deduped by semantic key. */
export async function sendOrderReminders(options: JobScope = {}): Promise<JobReport> {
  const { result, tally } = report('order_reminders');
  const reviewDue = await sql<Row[]>`select o.id,o.buyer_id,o.review_due_at,(select max(version) from app.deliveries d where d.order_id=o.id) as version from app.orders o
    where o.status='DELIVERED' and o.review_due_at > now() and o.review_due_at - interval '24 hours' <= now() and ${scoped(sql`o.id`, options)} limit ${options.limit ?? 100}`;
  const dueSoon = await sql<Row[]>`select id,creator_id,delivery_due_at from app.orders o where status in ('FUNDED','IN_PROGRESS','REVISION_REQUESTED')
    and delivery_due_at > now() and delivery_due_at - interval '24 hours' <= now() and ${scoped(sql`o.id`, options)} limit ${options.limit ?? 100}`;
  const overdue = await sql<Row[]>`select id,buyer_id from app.orders o where status in ('FUNDED','IN_PROGRESS') and delivery_due_at < now() and ${scoped(sql`o.id`, options)} limit ${options.limit ?? 100}`;
  await sql.begin(async (tx) => {
    for (const o of reviewDue) {
      await enqueueNotification(tx, String(o.id), `notify:order.review_reminder:${String(o.id)}:v${String(o.version)}`, {
        templateId: 'order.review_reminder', recipientId: String(o.buyer_id), params: { orderRef: String(o.id), reviewDeadlineAt: new Date(String(o.review_due_at)).toISOString() },
      });
      tally('REVIEW_REMINDER');
    }
    for (const o of dueSoon) {
      await enqueueNotification(tx, String(o.id), `notify:order.due_soon:${String(o.id)}`, {
        templateId: 'order.due_soon', recipientId: String(o.creator_id), params: { orderRef: String(o.id), dueAt: new Date(String(o.delivery_due_at)).toISOString() },
      });
      tally('DUE_SOON');
    }
    for (const o of overdue) {
      await enqueueNotification(tx, String(o.id), `notify:order.overdue:${String(o.id)}`, { templateId: 'order.overdue', recipientId: String(o.buyer_id), params: { orderRef: String(o.id) } });
      tally('OVERDUE');
    }
  });
  return result;
}

/**
 * Master §4.4: removes objects of abandoned uploads after the finalize grace, and unattached delivery/sample
 * files after `orphanGraceSeconds`. The DB row changes first (a trigger refuses referenced assets), the object after.
 */
export async function cleanupStorage(options: JobScope & { orphanGraceSeconds?: number } = {}): Promise<JobReport> {
  const { result, tally } = report('cleanup_storage');
  const provider = getStorageProvider();
  const limit = options.limit ?? 100;
  const intents = await sql<Row[]>`update app.upload_intents set closed_at=now(),outcome='ABANDONED',outcome_detail='finalize window passed'
    where id in (select id from app.upload_intents where closed_at is null and expires_at < now() - (${FINALIZE_GRACE_SECONDS} * interval '1 second')
      and ${scoped(sql`order_id`, options)} order by expires_at limit ${limit} for update skip locked)
    returning bucket,object_key`;
  for (const intent of intents) {
    try {
      await provider.remove(String(intent.bucket) as StorageBucket, String(intent.object_key));
      tally('ABANDONED_UPLOAD_REMOVED');
    } catch (error) {
      console.error('cleanup_storage remove failed', error);
      tally('ERROR');
    }
  }
  const orphanGrace = ageFilter(options.orphanGraceSeconds ?? 24 * 3600);
  const orphans = await sql<Row[]>`select a.id from app.storage_assets a where a.lifecycle_state='READY' and a.purpose in ('DELIVERY','SAMPLE')
    and a.created_at < now() - (${orphanGrace} * interval '1 second') and ${scoped(sql`a.order_id`, options)}
    and not exists (select 1 from app.delivery_assets d where d.asset_id=a.id) and not exists (select 1 from app.samples s where s.storage_asset_id=a.id)
    order by a.created_at limit ${limit}`;
  for (const orphan of orphans) {
    try {
      const [removed] = await sql<Row[]>`update app.storage_assets set lifecycle_state='DELETED',deleted_at=now() where id=${String(orphan.id)} and lifecycle_state='READY' returning bucket,object_key`;
      if (!removed) {
        tally('SKIPPED_STATE_CHANGED');
        continue;
      }
      await provider.remove(String(removed.bucket) as StorageBucket, String(removed.object_key));
      tally('ORPHAN_REMOVED');
    } catch (error) {
      // The guard trigger refuses assets that became referenced after the scan.
      if (String((error as Error).message).includes('referenced storage assets')) tally('SKIPPED_REFERENCED');
      else {
        console.error('cleanup_storage orphan failed', orphan.id, error);
        tally('ERROR');
      }
    }
  }
  return result;
}

export async function runJobsOnce(): Promise<JobReport[]> {
  return [
    await reprocessWebhookInbox(),
    await reconcileProviderOperations(),
    await expireCheckoutHolds(),
    await autoAcceptDeliveries(),
    await releaseReadySettlements(),
    await sendOrderReminders(),
    await dispatchNotificationOutbox(),
    await cleanupStorage(),
  ];
}
