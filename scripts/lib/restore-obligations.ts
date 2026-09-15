/**
 * What a restore must conserve (OPS-02): money, holds, provider work, unsent effects, cases and schema guards, as
 * deterministic rows. `hard_invariants` must also be zero; everything else must equal the source snapshot.
 */
const TABLES = [
  'app.users', 'app.services', 'app.service_versions', 'app.orders', 'app.order_events', 'app.deliveries', 'app.messages', 'app.reviews',
  'app.ledger_transactions', 'app.ledger_entries', 'app.provider_operations', 'app.webhook_inbox', 'app.outbox', 'app.reconciliation_cases',
  'app.workload_claims', 'app.creator_workloads', 'app.requests', 'app.request_budget_reservations', 'app.auctions', 'app.bids',
  'app.chain_payouts', 'app.pool_assets', 'app.pool_ledger', 'app.digital_entitlements', 'app.digital_releases', 'app.storage_assets', 'app.request_images',
  'app.order_amendments', 'app.payment_disputes', 'app.post_release_refunds', 'app.provider_cost_adjustments', 'app.audit_log',
];

export const OBLIGATION_QUERIES: Record<string, string> = {
  migrations: `select id from public.schema_migrations order by id`,
  table_counts: `select * from (${TABLES.map((table) => `select '${table}' as table, count(*)::int as rows from ${table}`).join(' union all ')}) counts order by 1`,
  schema_guards: `select * from (select 'triggers' as kind, count(*)::int as n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace s on s.oid=c.relnamespace where s.nspname='app' and not t.tgisinternal
    union all select 'constraints', count(*)::int from pg_constraint k join pg_namespace s on s.oid=k.connamespace where s.nspname='app'
    union all select 'constraints not validated', count(*)::int from pg_constraint k join pg_namespace s on s.oid=k.connamespace where s.nspname='app' and not k.convalidated) guards order by 1`,
  order_money: `select status, payment_status, settlement_status, coalesce(funding_method,'') as funding_method, payment_rail, currency, count(*)::int as n, sum(amount_minor)::text as amount
    from app.orders group by 1,2,3,4,5,6 order by 1,2,3,4,5,6`,
  ledger_by_account_kind: `select split_part(e.account, ':', 1) as account_kind, e.currency, sum(e.amount_minor)::text as total, count(*)::int as entries
    from app.ledger_entries e group by 1,2 order by 1,2`,
  provider_operations: `select kind, status, count(*)::int as n from app.provider_operations group by 1,2 order by 1,2`,
  webhook_inbox: `select (processed_at is not null) as processed, count(*)::int as n, coalesce(sum(attempts),0)::int as attempts from app.webhook_inbox group by 1 order by 1`,
  outbox: `select status, count(*)::int as n from app.outbox group by 1 order by 1`,
  holds: `select 'workload_claims' as source, state, count(*)::int as n, sum(units)::int as units from app.workload_claims group by 2
    union all select 'digital_entitlements', state, count(*)::int, 0 from app.digital_entitlements group by 2 order by 1,2`,
  creator_workloads: `select sum(held_units)::int as held, sum(active_units)::int as active, count(*) filter (where not accepting_orders)::int as paused from app.creator_workloads`,
  request_budgets: `select count(*)::int as requests, coalesce(sum(budget_minor),0)::text as budget, coalesce(sum(reserved_minor),0)::text as reserved, coalesce(sum(committed_minor),0)::text as committed from app.requests`,
  chain_payouts: `select kind, state, count(*)::int as n, sum(amount_atomic)::text as amount from app.chain_payouts group by 1,2 order by 1,2`,
  pools: `select sum(confirmed_deposit)::text as deposit, sum(unallocated)::text as unallocated, sum(allocated_active)::text as allocated, sum(pending_outflow)::text as pending, sum(released)::text as released, sum(refunded)::text as refunded from app.pool_assets`,
  cases: `select kind, status, count(*)::int as n from app.reconciliation_cases group by 1,2 order by 1,2`,
  payment_facts: `select 'payment_disputes' as source, status, count(*)::int as n, coalesce(sum(amount_minor),0)::text as amount from app.payment_disputes group by 2
    union all select 'post_release_refunds', status, count(*)::int, (sum(amount_minor)::text || '/' || sum(recovered_minor)::text || '/' || sum(covered_minor)::text) from app.post_release_refunds group by 2
    union all select 'provider_cost_adjustments', phase, count(*)::int, (sum(creator_share_minor)::text || '/' || sum(platform_share_minor)::text || '/' || sum(creator_credit_minor)::text) from app.provider_cost_adjustments group by 2
    order by 1,2`,
  hard_invariants: `select * from (select 'unbalanced ledger transactions' as check, count(*)::int as violations from (
        select t.id from app.ledger_transactions t join app.ledger_entries e on e.transaction_id=t.id group by t.id, e.currency having sum(e.amount_minor) <> 0) x
    union all select 'workload counter drift', count(*)::int from app.workload_counter_drift
    union all select 'pool bucket conservation', count(*)::int from app.pool_assets where confirmed_deposit <> unallocated + allocated_active + pending_outflow + released + refunded
    union all select 'request budget oversold', count(*)::int from app.requests where reserved_minor + committed_minor > budget_minor
    union all select 'order principal paid out beyond funding', count(*)::int from (
        select t.order_id from app.ledger_entries e join app.ledger_transactions t on t.id=e.transaction_id where e.account like 'order_principal:%' group by t.order_id having sum(e.amount_minor) > 0) y
    union all select 'orders released more than once', count(*)::int from (
        select order_id from app.ledger_transactions where kind='SETTLEMENT_RELEASED' group by order_id having count(*) > 1) z
    union all select 'orphan rows (orders, ledger, deliveries, claims, provider operations)', (
        (select count(*) from app.orders o where not exists (select 1 from app.users u where u.id=o.buyer_id) or not exists (select 1 from app.users u where u.id=o.creator_id))
      + (select count(*) from app.ledger_entries e where not exists (select 1 from app.ledger_transactions t where t.id=e.transaction_id))
      + (select count(*) from app.ledger_transactions t where t.order_id is not null and not exists (select 1 from app.orders o where o.id=t.order_id))
      + (select count(*) from app.deliveries d where not exists (select 1 from app.orders o where o.id=d.order_id))
      + (select count(*) from app.workload_claims c where c.order_id is not null and not exists (select 1 from app.orders o where o.id=c.order_id))
      + (select count(*) from app.workload_claims c where c.order_id is null and not exists (select 1 from app.auctions a where a.id=c.auction_id))
      + (select count(*) from app.provider_operations p where p.order_id is not null and not exists (select 1 from app.orders o where o.id=p.order_id)))::int
    union all select 'confirmed chain payouts duplicated', count(*)::int from (
        select subject_id, kind from app.chain_payouts where state='CONFIRMED' and kind in ('ORDER_RELEASE','ORDER_REFUND') group by 1,2 having count(*) > 1) w) checks order by 1`,
};

/**
 * Jobs dry-run: what each background job would pick up as of one fixed instant, without running it. Compared between the
 * source snapshot and the restore, and reported so an operator reconciles these effects before jobs are started.
 */
export function dueJobWorkQuery(asOf: string): string {
  const t = `'${asOf.replaceAll("'", "")}'::timestamptz`;
  return `select * from (
    select 'reprocess_webhook_inbox' as job, count(*)::int as due from app.webhook_inbox where processed_at is null
    union all select 'reconcile_provider_operations', count(*)::int from app.provider_operations where status in ('PENDING','UNKNOWN')
    union all select 'expire_checkout_holds', count(*)::int from (
        select c.order_id from app.workload_claims c join app.orders o on o.id=c.order_id where c.state in ('HELD','EXPIRY_RECONCILING') and c.expires_at < ${t} and o.status='AWAITING_PAYMENT'
        union all select e.order_id from app.digital_entitlements e join app.orders o on o.id=e.order_id where e.state in ('HELD','EXPIRY_RECONCILING') and e.expires_at < ${t} and o.status='AWAITING_PAYMENT') h
    union all select 'close_due_auctions', count(*)::int from app.auctions where status in ('SCHEDULED','LIVE') and ends_at < ${t}
    union all select 'auto_accept_deliveries', count(*)::int from app.orders where status='DELIVERED' and review_due_at < ${t}
    union all select 'release_ready_settlements', count(*)::int from app.orders o where o.settlement_status='READY'
        and ((o.status='APPROVED' and o.payment_status='SUCCEEDED') or (o.status='CANCELLED' and o.cancellation_refund_minor is not null and o.cancellation_refund_minor < o.amount_minor))
        and not exists (select 1 from app.disputes d where d.order_id=o.id and d.status in ('OPEN','UNDER_REVIEW'))
        and not exists (select 1 from app.payment_disputes pd where pd.order_id=o.id and pd.status in ('OPEN','LOST'))
    union all select 'dispatch_chain_payouts', count(*)::int from app.chain_payouts where state in ('QUEUED','RETRY','UNKNOWN') and next_attempt_at <= ${t}
    union all select 'dispatch_notification_outbox', count(*)::int from app.outbox where status in ('PENDING','PROCESSING')
  ) due order by 1`;
}
