/**
 * Funds: every place money touches an account, in one read. Amounts come from what is already recorded — the order
 * amount, and the double-entry ledger's `order_principal:<order>` account, where a capture books −amount, a refund
 * +refunded and a release +released — never from a fee model, which is still undecided.
 *
 * The balance of that account is what is still held for an order: captured, not yet refunded or released.
 */
import type { Actor } from '@/lib/auth';
import { sql } from '@/lib/db';
import type { Row } from '@/lib/commands';
import { listVerifiedWallets } from '@/modules/crypto/wallets';

export type FundsSummary = {
  /** Orders the buyer still has to pay. */
  to_pay_minor: string;
  to_pay_count: number;
  /** Captured and neither refunded nor released yet: the buyer's money waiting on work. */
  held_as_buyer_minor: string;
  refunded_to_buyer_minor: string;
  released_by_buyer_minor: string;
  /** The same held money, seen from the creator doing the work. */
  held_for_creator_minor: string;
  released_to_creator_minor: string;
  awaiting_buyer_payment_minor: string;
};

const PAYABLE = sql`o.status='AWAITING_PAYMENT' and o.payment_status in ('PENDING','PROCESSING','FAILED')`;

/**
 * Money per order of this account, by what it was. A refund after the creator was paid is booked on the order's
 * `post_release_refund:<order>` account instead of its principal, so the buyer's refunds count both.
 */
const principalFor = (actorId: string) => sql`select t.order_id,
    coalesce(-sum(e.amount_minor) filter (where e.account='order_principal:' || t.order_id::text),0) as held_minor,
    coalesce(sum(e.amount_minor) filter (where e.account='order_principal:' || t.order_id::text and t.kind in ('REFUND_SETTLED','REFUND_SUCCEEDED','BANK_FUNDS_RETURNED')),0)
      + coalesce(sum(e.amount_minor) filter (where e.account='post_release_refund:' || t.order_id::text and t.kind='REFUND_SETTLED'),0) as refunded_minor,
    coalesce(sum(e.amount_minor) filter (where e.account='order_principal:' || t.order_id::text and t.kind='SETTLEMENT_RELEASED'),0) as released_minor
  from app.ledger_transactions t join app.ledger_entries e on e.transaction_id=t.id
    and e.account in ('order_principal:' || t.order_id::text, 'post_release_refund:' || t.order_id::text)
  where t.order_id in (select o.id from app.orders o where o.buyer_id=${actorId} or o.creator_id=${actorId})
  group by t.order_id`;

export async function getFundsSummary(actor: Actor): Promise<FundsSummary> {
  const [row] = await sql<Row[]>`with mine as (
      select o.id,o.buyer_id,o.creator_id,o.amount_minor,o.status,o.payment_status from app.orders o where o.buyer_id=${actor.id} or o.creator_id=${actor.id}
    ), principal as (${principalFor(actor.id)})
    select
      coalesce(sum(o.amount_minor) filter (where o.buyer_id=${actor.id} and ${PAYABLE}),0)::text as to_pay_minor,
      (count(*) filter (where o.buyer_id=${actor.id} and ${PAYABLE}))::int as to_pay_count,
      coalesce(sum(p.held_minor) filter (where o.buyer_id=${actor.id}),0)::text as held_as_buyer_minor,
      coalesce(sum(p.refunded_minor) filter (where o.buyer_id=${actor.id}),0)::text as refunded_to_buyer_minor,
      coalesce(sum(p.released_minor) filter (where o.buyer_id=${actor.id}),0)::text as released_by_buyer_minor,
      coalesce(sum(p.held_minor) filter (where o.creator_id=${actor.id}),0)::text as held_for_creator_minor,
      coalesce(sum(p.released_minor) filter (where o.creator_id=${actor.id}),0)::text as released_to_creator_minor,
      coalesce(sum(o.amount_minor) filter (where o.creator_id=${actor.id} and ${PAYABLE}),0)::text as awaiting_buyer_payment_minor
    from mine o left join principal p on p.order_id=o.id`;
  return row as unknown as FundsSummary;
}

const ACTIVITY_LABELS: Record<string, string> = {
  FUNDING_CAPTURED: 'Payment captured',
  LATE_FUNDING_CAPTURED: 'Late payment captured',
  REFUND_SETTLED: 'Refunded to the buyer',
  REFUND_SUCCEEDED: 'Refunded to the buyer',
  SETTLEMENT_RELEASED: 'Released to the creator',
  BANK_FUNDS_RETURNED: 'Bank transfer returned',
};

export const activityLabel = (kind: string, afterRelease = false) => afterRelease && kind === 'REFUND_SETTLED'
  ? 'Refunded to the buyer after release'
  : ACTIVITY_LABELS[kind] ?? kind.toLowerCase().replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

export async function getFundsOverview(actor: Actor) {
  const [summary, toPay, held, activity, pools, payouts, wallets] = await Promise.all([
    getFundsSummary(actor),
    sql<Row[]>`select o.id,o.title,o.amount_minor,o.currency,o.payment_status,o.created_at,o.source,cu.display_name as creator_name
      from app.orders o join app.users cu on cu.id=o.creator_id
      where o.buyer_id=${actor.id} and ${PAYABLE} order by o.created_at desc limit 50`,
    sql<Row[]>`with principal as (${principalFor(actor.id)})
      select o.id,o.title,o.status,o.settlement_status,o.payment_rail,o.funding_method,o.currency,o.funded_at,p.held_minor,
        o.buyer_id,o.creator_id,bu.display_name as buyer_name,cu.display_name as creator_name
      from app.orders o join principal p on p.order_id=o.id join app.users bu on bu.id=o.buyer_id join app.users cu on cu.id=o.creator_id
      where (o.buyer_id=${actor.id} or o.creator_id=${actor.id}) and p.held_minor > 0 order by o.funded_at desc nulls last limit 50`,
    sql<Row[]>`select t.id,t.kind,t.created_at,t.order_id,o.title,o.buyer_id,o.creator_id,o.payment_rail,abs(e.amount_minor) as amount_minor,e.currency,
        e.account like 'post_release_refund:%' as after_release
      from app.ledger_transactions t join app.ledger_entries e on e.transaction_id=t.id
        and (e.account='order_principal:' || t.order_id::text or (e.account='post_release_refund:' || t.order_id::text and t.kind='REFUND_SETTLED'))
      join app.orders o on o.id=t.order_id
      where o.buyer_id=${actor.id} or o.creator_id=${actor.id} order by t.created_at desc, t.id limit 50`,
    sql<Row[]>`select p.id,p.status,p.request_id,r.title,n.name as network_name,n.mode as network_mode,
        (select count(*)::int from app.pool_funding_intents f where f.pool_id=p.id and f.status='CONFIRMED') as confirmed_deposits,
        (select count(*)::int from app.pool_funding_intents f where f.pool_id=p.id and f.status in ('AWAITING_DEPOSIT','PENDING_FINALITY')) as open_deposits,
        (select count(*)::int from app.pool_allocations a where a.pool_id=p.id and a.state in ('ACTIVE','RELEASE_PENDING')) as held_allocations,
        (select count(*)::int from app.pool_allocations a where a.pool_id=p.id and a.state='RELEASED') as released_allocations
      from app.campaign_pools p join app.requests r on r.id=p.request_id join app.chain_networks n on n.chain_id=p.chain_id
      where p.owner_id=${actor.id} order by p.created_at desc limit 50`,
    sql<Row[]>`select cp.id,cp.kind,cp.state,cp.created_at,cp.confirmed_at,cp.tx_hash,n.name as network_name,n.mode as network_mode,o.id as order_id,o.title
      from app.chain_payouts cp join app.chain_networks n on n.chain_id=cp.chain_id
      left join app.pool_allocations a on cp.kind='ALLOCATION' and a.id=cp.subject_id
      join app.orders o on o.id=coalesce(cp.order_id,a.order_id)
      where cp.kind in ('ORDER_RELEASE','ALLOCATION') and o.creator_id=${actor.id} order by cp.created_at desc limit 50`,
    listVerifiedWallets(actor.id),
  ]);
  return { summary, to_pay: toPay, held, activity, pools, payouts, wallets };
}
