import Link from 'next/link';
import { ArrowRight, Briefcase, ClipboardList, Gavel, Handshake, Megaphone, Package, Search, type LucideIcon } from 'lucide-react';
import { getAccountSummary } from '@/lib/read-model';
import { getOverview, type ActionItem } from '@/modules/workspace/overview';
import { Badge, date, humanize, money, toneOf } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import styles from './overview.module.css';

export const dynamic = 'force-dynamic';

const KIND: Record<ActionItem['kind'], { label: string; icon: LucideIcon }> = {
  order: { label: 'Order', icon: Package },
  offer: { label: 'Offer', icon: Handshake },
  campaign: { label: 'Campaign', icon: Megaphone },
  auction: { label: 'Auction', icon: Gavel },
};

/** "due in 3 d", "due in 5 h", "overdue by 2 h", for the action list. */
function dueLabel(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  const span = (value: number) => (value >= 2 * 24 * 60 ? `${Math.floor(value / (24 * 60))} d` : value >= 60 ? `${Math.floor(value / 60)} h` : `${Math.max(1, value)} min`);
  return minutes >= 0 ? `due in ${span(minutes)}` : `overdue by ${span(-minutes)}`;
}

/**
 * The workspace overview. One question per band: what needs me now (the action list, most urgent first), how things
 * stand (four numbers), what happened lately (recent orders), and where to go next (shortcuts). Notifications live in
 * the header bell.
 */
export default async function DashboardPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const { actor, prompt } = await requireActorOrLoginPrompt('/dashboard', query);
  if (!actor) return prompt;
  const [overview, account] = await Promise.all([getOverview(actor), getAccountSummary(actor)]);
  const { creator } = overview;
  const now = Date.now();
  const shortcuts: { href: string; label: string; note: string; icon: LucideIcon }[] = creator
    ? [
      { href: '/creator/services/new', label: 'New service', note: 'A clear scope, price and samples', icon: Briefcase },
      { href: '/requests', label: 'Open campaigns', note: 'Apply with your approach and quote', icon: Megaphone },
      { href: '/buyer/orders', label: 'All orders', note: 'Everything you are delivering', icon: ClipboardList },
      { href: '/auctions/new', label: 'List an item', note: 'Auction a WL spot or allocation', icon: Gavel },
    ]
    : [
      { href: '/buyer/requests/new', label: 'Post a brief', note: 'One brief, many creators', icon: Megaphone },
      { href: '/explore', label: 'Find creators', note: 'Book a service directly', icon: Search },
      { href: '/buyer/orders', label: 'All orders', note: 'Pay, review and approve', icon: ClipboardList },
      { href: '/auctions', label: 'Auctions', note: 'WL spots, mints, allocations', icon: Gavel },
    ];

  return <main className={`container ${styles.overview}`}>
    <Notices query={query} />
    {!account.onboarded && <Link className="onboard-nudge" href="/welcome">
      <span className="onboard-nudge-text">
        <strong>Finish setting up your {creator ? 'creator profile' : 'project'}</strong>
        <span>{creator
          ? 'Add a photo, your creator name and a short introduction. Publishing services and applying to campaigns wait until then.'
          : 'Add your logo, the project name and a short introduction. Posting a campaign waits until then.'}</span>
      </span>
      <span className="button button-dark compact">Finish setup</span>
    </Link>}

    <header className={styles.head}>
      <PageHeading eyebrow={`Overview · ${creator ? 'Creator' : 'Buyer'} account`} title="Keep good work moving."
        description={creator ? 'Deliver what is due, answer offers and find your next campaign.' : 'Pay, review and approve what is waiting, and brief your next campaign.'} />
      <div className={styles.headActions}>
        {creator
          ? <><Link className="button button-dark" href="/creator/services/new">New service</Link><Link className="button button-outline" href="/requests">Find campaigns</Link></>
          : <><Link className="button button-dark" href="/buyer/requests/new">Post a brief</Link><Link className="button button-outline" href="/explore">Find creators</Link></>}
      </div>
    </header>

    <dl className={styles.stats} aria-label="At a glance">
      <div className={overview.todo ? styles.statAlert : undefined}><dt>Needs your action</dt><dd>{overview.todo}</dd></div>
      <div><dt>Active orders</dt><dd>{overview.stats.active}</dd></div>
      <div><dt>Completed</dt><dd>{overview.stats.completed}</dd></div>
      <div><dt>{creator ? 'Earned' : 'Funded'}</dt><dd>{money(overview.stats.moneyMinor)}</dd></div>
    </dl>

    <div className={styles.grid}>
      <section className={styles.band} aria-labelledby="overview-actions">
        <div className={styles.bandHead}>
          <h2 id="overview-actions">Needs your action</h2>
          {overview.actions.length > 8 && <span className={styles.more}>Showing the 8 most urgent of {overview.actions.length}</span>}
        </div>
        {overview.actions.length ? <ol className={styles.actions}>
          {overview.actions.slice(0, 8).map((item) => {
            const kind = KIND[item.kind];
            const due = dueLabel(item.dueAt, now);
            return <li key={item.key}>
              <Link className={`${styles.action}${item.waiting ? ` ${styles.waiting}` : ''}`} href={item.href}>
                <span className={styles.actionIcon} aria-hidden><kind.icon size={17} /></span>
                <span className={styles.actionText}>
                  <strong>{item.action}</strong>
                  <span><span className={styles.kind}>{kind.label}</span> {item.title}</span>
                </span>
                {due && <span className={`${styles.due}${due.startsWith('overdue') ? ` ${styles.overdue}` : ''}`} title={date(item.dueAt)}>{due}</span>}
                <ArrowRight size={16} className={styles.go} aria-hidden />
              </Link>
            </li>;
          })}
        </ol> : <div className={styles.clear}><strong>You’re all caught up.</strong><span>New orders, offers and deliveries that need you will show here.</span></div>}
      </section>

      <nav className={styles.band} aria-labelledby="overview-shortcuts">
        <div className={styles.bandHead}><h2 id="overview-shortcuts">Shortcuts</h2></div>
        <ul className={styles.shortcuts}>
          {shortcuts.map((shortcut) => <li key={shortcut.href}>
            <Link href={shortcut.href}>
              <span className={styles.actionIcon} aria-hidden><shortcut.icon size={16} /></span>
              <span className={styles.actionText}><strong>{shortcut.label}</strong><span>{shortcut.note}</span></span>
            </Link>
          </li>)}
        </ul>
      </nav>
    </div>

    <section className={styles.band} aria-labelledby="overview-recent">
      <div className={styles.bandHead}>
        <h2 id="overview-recent">Recent orders</h2>
        {overview.totalOrders > 0 && <Link className="text-link" href="/buyer/orders">View all ›</Link>}
      </div>
      {overview.recent.length ? <div className="table-wrap">
        <table>
          <thead><tr><th>Order</th><th>{creator ? 'Buyer' : 'Creator'}</th><th>Status</th><th>Amount</th><th>Created</th></tr></thead>
          <tbody>
            {overview.recent.map((order) => <tr key={order.id}>
              <td><Link className="text-link" href={`/orders/${order.id}`}>{order.title}</Link></td>
              <td>{order.counterpart}</td>
              <td><Badge tone={toneOf(order.status)}>{humanize(order.status)}</Badge></td>
              <td className="mono">{money(order.amountMinor)}</td>
              <td>{date(order.createdAt)}</td>
            </tr>)}
          </tbody>
        </table>
      </div> : <div className={styles.clear}><strong>No orders yet.</strong>
        <span>{creator ? <Link className="text-link" href="/creator/services/new">Publish your first service ›</Link> : <Link className="text-link" href="/explore">Find a creator ›</Link>}</span></div>}
    </section>
  </main>;
}
