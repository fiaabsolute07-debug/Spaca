import { listInAppNotifications } from '@/modules/notifications/store';
import { isCreator } from '@/lib/account';
import Link from 'next/link';
import { getDashboardData } from '@/lib/read-model';
import { Badge, Empty, OrderList, date, money, num, row, rows } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/dashboard";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const d = row(await getDashboardData(actor));
  const notifications = await listInAppNotifications(actor.id, 8);
  const stats = row(d.stats);
  const workload = row(d.workload);
  const orders = rows(d.orders);
  const creatorAccount = isCreator(actor);
  return <main className="container">
      <section>
        {notices}
        <PageHeading
          eyebrow="Your workspace"
          title="Keep good work moving."
          description={creatorAccount ? 'Manage your services, deliver orders and find new campaigns.' : 'Hire creators, follow your orders and run campaigns from one place.'}
        />
        <div className="stats">
          <div className="stat">
            <span>Completed orders</span>
            <strong>
              {num(stats.completed_orders)}
            </strong>
          </div>
          <div className="stat">
            <span>Active orders</span>
            <strong>
              {num(stats.active_orders)}
            </strong>
          </div>
          <div className="stat">
            <span>{creatorAccount ? 'Completed sales' : 'Funded orders'}</span>
            <strong>
              {money(creatorAccount ? stats.sales_minor : stats.funded_minor)}
            </strong>
          </div>
          {creatorAccount && <div className="stat">
            <span>Orders in progress</span>
            <strong>
              {num(workload.in_flight_units)}
            </strong>
          </div>}
        </div>
        <div className="section-heading">
          <h2>Notifications</h2>
        </div>
        {notifications.length ? <div className="panel">
          {notifications.map(n => <Link className="record" key={n.id} href={n.link_path}>
            <strong>
              {n.subject}
            </strong>
            <p>
              {n.body}
            </p>
            <span className="muted">
              {date(n.created_at)}
            </span>
          </Link>)}
        </div> : <p className="muted">No notifications yet.</p>}
        <div className="section-heading">
          <h2>Recent orders</h2>
          <Link className="text-link" href="/buyer/orders">View all ›</Link>
        </div>
        {orders.length ? <OrderList orders={orders.slice(0, 8)} /> : <Empty title="Your next collaboration starts here">
          {creatorAccount ? <Link href="/creator/services/new" className="text-link">Publish your first service ›</Link> : <Link href="/explore" className="text-link">Find a creator ›</Link>}
        </Empty>}
        <div className="section-heading">
          <h2>Shortcuts</h2>
        </div>
        {creatorAccount ? <div className="service-grid">
          <Link className="panel" href="/creator/services/new">
            <h3>Publish a service</h3>
            <p>Set a clear scope, price and samples so buyers can book you.</p>
          </Link>
          <Link className="panel" href="/requests">
            <h3>Apply to campaigns</h3>
            <p>Send your approach and quote to open briefs from projects.</p>
          </Link>
          <Link className="panel" href="/settings/profile">
            <h3>Complete your profile</h3>
            <p>A photo, headline and linked accounts help buyers choose you.</p>
          </Link>
        </div> : <div className="service-grid">
          <Link className="panel" href="/explore">
            <h3>Find creators</h3>
            <p>Filter by category, price and delivery time, then book directly.</p>
          </Link>
          <Link className="panel" href="/buyer/requests/new">
            <h3>Post a brief</h3>
            <p>Describe the campaign once and compare creators&apos; approaches.</p>
          </Link>
          <Link className="panel" href="/auctions">
            <h3>Browse auctions</h3>
            <p>Bid on time-bound slots when a creator offers one.</p>
          </Link>
        </div>}
      </section>
  </main>;
}
