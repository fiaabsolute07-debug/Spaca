import Link from 'next/link';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { PageHeading } from '@/components/page-heading';
import { Notices } from '@/components/notices';
import { NetworkBadge } from '@/components/crypto/crypto-payment-panel';
import { Badge, date, humanize, money, num, str, type Row } from '@/components/ui';
import { accountTypeOf } from '@/lib/account';
import { activityLabel, getFundsOverview } from '@/modules/funds/queries';

export const dynamic = 'force-dynamic';

const railLabel = (order: Row) => {
  if (str(order.payment_rail) === 'CRYPTO') return 'Crypto';
  if (str(order.payment_rail) === 'POOL') return 'Campaign reward pool';
  return str(order.funding_method) === 'BANK_TRANSFER' ? 'Bank transfer · test provider' : 'Card · test provider';
};
const shortHash = (hash: unknown) => (hash ? `${str(hash).slice(0, 10)}…${str(hash).slice(-6)}` : null);

const VISIBLE_ROWS = 6;
/** The read model returns at most this many rows per list. */
const LIST_LIMIT = 50;

/** The first rows of a long list, with the rest one click away, so each section stays scannable. */
function Rows<T extends Row>({ items, render, noun }: { items: T[]; render: (item: T) => React.ReactNode; noun: string }) {
  const shown = items.slice(0, VISIBLE_ROWS);
  const rest = items.slice(VISIBLE_ROWS);
  return <>
    <ul className="funds-list">{shown.map(render)}</ul>
    {rest.length > 0 && <details className="funds-more">
      <summary>Show {rest.length} more {noun}</summary>
      <ul className="funds-list">{rest.map(render)}</ul>
      {items.length >= LIST_LIMIT && <p className="muted">These are the latest {LIST_LIMIT}; the totals above count all of them.</p>}
    </details>}
  </>;
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: React.ReactNode }) {
  return <section className="panel funds-section" id={id} aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>{title}</h2>
    {intro ? <p className="muted">{intro}</p> : null}
    {children}
  </section>;
}

/**
 * Funds: where money stands for this account, from recorded facts only — order amounts and the ledger's order principal.
 * No totals are derived from a fee model (the platform fee is undecided), and every amount links to the order it
 * belongs to.
 */
export default async function FundsPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/funds';
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const creator = accountTypeOf(actor) === 'creator';
  const data = await getFundsOverview(actor);
  const s = data.summary;
  const figures: [string, string, string][] = creator
    ? [
      ['Held for your work', money(s.held_for_creator_minor), 'Paid by buyers, released when they approve'],
      ['Released to you', money(s.released_to_creator_minor), 'Before any provider cost shown on the order'],
      ['Awaiting buyer payment', money(s.awaiting_buyer_payment_minor), 'Orders not paid yet'],
    ]
    : [
      ['To pay', money(s.to_pay_minor), `${num(s.to_pay_count)} order${num(s.to_pay_count) === 1 ? '' : 's'} waiting for payment`],
      ['Held for work', money(s.held_as_buyer_minor), 'Paid, waiting on delivery or approval'],
      ['Refunded to you', money(s.refunded_to_buyer_minor), 'Returned to how you paid'],
      ['Released to creators', money(s.released_by_buyer_minor), 'Paid out for approved work'],
    ];

  return <main className="container">
    <Notices query={query} />
    <div className="section-heading">
      <PageHeading eyebrow="Funds" title={creator ? 'Your earnings and payouts' : 'Your payments and campaign funds'}
        description="Everything paid, held, refunded and released for your orders, from the payment record. Local sandbox: simulated payments and local-devnet crypto; no real money moves." />
      {creator ? <Link className="button button-dark" href="/creator/requests">Find paid work</Link>
        : <Link className="button button-dark" href="/buyer/requests/new">Post a brief</Link>}
    </div>
    <div className="stats funds-stats">
      {figures.map(([label, value, note]) => <div className="stat" key={label}>
        <span>{label}</span>
        <strong>{value}</strong>
        <small className="muted">{note}</small>
      </div>)}
    </div>

    {!creator && <Section id="to-pay" title="Pay for orders" intro="Work starts when payment is confirmed. Each order keeps its checkout for a short time before it expires.">
      {data.to_pay.length ? <Rows items={data.to_pay} noun="orders" render={(order) => <li key={str(order.id)} className="funds-row">
          <div><Link className="text-link" href={`/orders/${str(order.id)}`}>{str(order.title)}</Link><small className="muted">{str(order.creator_name)} · {humanize(str(order.source))} · created {date(order.created_at)}</small></div>
          <Badge tone={str(order.payment_status) === 'FAILED' ? 'bad' : 'waiting'}>{str(order.payment_status) === 'FAILED' ? 'Payment failed' : 'Awaiting payment'}</Badge>
          <strong className="funds-amount">{money(order.amount_minor)}</strong>
          <Link className="button compact" href={`/orders/${str(order.id)}`}>Pay</Link>
        </li>} /> : <p className="muted">Nothing to pay right now.</p>}
    </Section>}

    <Section id="held" title={creator ? 'Held for your work' : 'Held for work'} intro={creator
      ? 'Buyers have paid for these orders. The money is released to you when they approve, or when the review window ends.'
      : 'You have paid for these orders. The money stays held until you approve the work, or is refunded if an order is cancelled.'}>
      {data.held.length ? <Rows items={data.held} noun="orders" render={(order) => <li key={str(order.id)} className="funds-row">
          <div><Link className="text-link" href={`/orders/${str(order.id)}`}>{str(order.title)}</Link><small className="muted">{creator ? `for ${str(order.buyer_name)}` : `by ${str(order.creator_name)}`} · {railLabel(order)} · paid {date(order.funded_at)}</small></div>
          <Badge>{humanize(str(order.status))}</Badge>
          <strong className="funds-amount">{money(order.held_minor)}</strong>
        </li>} /> : <p className="muted">No money is held for {creator ? 'your work' : 'work'} right now.</p>}
    </Section>

    {creator && <Section id="payouts" title="Payouts on chain" intro="Crypto releases and campaign rewards sent to your wallet. Card and bank orders are paid out by the test provider and appear under Money activity.">
      {data.payouts.length ? <Rows items={data.payouts} noun="payouts" render={(payout) => <li key={str(payout.id)} className="funds-row">
          <div><Link className="text-link" href={`/orders/${str(payout.order_id)}`}>{str(payout.title)}</Link><small className="muted">{str(payout.kind) === 'ALLOCATION' ? 'Campaign reward' : 'Order release'} · {str(payout.network_name)} · {date(payout.confirmed_at ?? payout.created_at)}{shortHash(payout.tx_hash) ? ` · ${shortHash(payout.tx_hash)}` : ''}</small></div>
          <NetworkBadge mode={payout.network_mode} />
          <Badge tone={str(payout.state) === 'CONFIRMED' ? 'good' : str(payout.state) === 'FAILED' ? 'bad' : 'waiting'}>{humanize(str(payout.state))}</Badge>
        </li>} /> : <p className="muted">No on-chain payouts yet.</p>}
    </Section>}

    {!creator && <Section id="pools" title="Campaign reward pools" intro="Crypto you deposit for a campaign's rewards. Each hire holds its reward until the work is approved.">
      {data.pools.length ? <Rows items={data.pools} noun="pools" render={(pool) => <li key={str(pool.id)} className="funds-row">
          <div><Link className="text-link" href={`/requests/${str(pool.request_id)}`}>{str(pool.title)}</Link><small className="muted">{str(pool.network_name)} · {num(pool.confirmed_deposits)} deposit{num(pool.confirmed_deposits) === 1 ? '' : 's'} confirmed{num(pool.open_deposits) ? `, ${num(pool.open_deposits)} waiting` : ''} · {num(pool.held_allocations)} reward{num(pool.held_allocations) === 1 ? '' : 's'} held, {num(pool.released_allocations)} released</small></div>
          <NetworkBadge mode={pool.network_mode} />
          <Badge>{humanize(str(pool.status))}</Badge>
        </li>} /> : <p className="muted">No reward pools. Add one from a campaign page.</p>}
    </Section>}

    <Section id="activity" title="Money activity" intro="Every payment, refund and release on your orders, newest first.">
      {data.activity.length ? <Rows items={data.activity} noun="entries" render={(entry) => <li key={str(entry.id)} className="funds-row">
          <div><strong className="funds-kind">{activityLabel(str(entry.kind), entry.after_release === true)}</strong><small className="muted"><Link className="text-link" href={`/orders/${str(entry.order_id)}`}>{str(entry.title)}</Link> · {date(entry.created_at)}</small></div>
          <strong className="funds-amount">{money(entry.amount_minor)}</strong>
        </li>} /> : <p className="muted">No money has moved on your orders yet.</p>}
    </Section>

    <Section id="wallets" title="Wallets" intro={creator ? 'Crypto payouts go to a wallet you proved you control.' : 'Pool deposits and crypto checkout use a wallet you proved you control.'}>
      {data.wallets.length ? <Rows items={data.wallets} noun="wallets" render={(wallet) => <li key={str(wallet.id)} className="funds-row">
          <div><strong className="prewrap funds-address">{str(wallet.address)}</strong><small className="muted">{str(wallet.network_name)} · linked {date(wallet.verified_at)}</small></div>
          <NetworkBadge mode={wallet.network_mode} />
        </li>} /> : <p className="muted">No wallet linked yet.</p>}
      <Link className="text-link" href="/settings/profile#wallets">{data.wallets.length ? 'Link another wallet ›' : 'Link a wallet ›'}</Link>
    </Section>
  </main>;
}
