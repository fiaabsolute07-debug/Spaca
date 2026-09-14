import { listInAppNotifications } from '@/modules/notifications/store';
import { WorkspaceSidebar } from '@/components/workspace-sidebar';
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
  return <main className="container">
    <div className="workspace">
      <WorkspaceSidebar actor={actor} />
      <section className="workspace-main">
        {notices}
        <PageHeading
          eyebrow="Your workspace"
          title="Keep good work moving."
          description="Track orders, manage your services, and respond to opportunities from one place."
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
            <span>Gross volume</span>
            <strong>
              {money(stats.gross_minor)}
            </strong>
          </div>
          <div className="stat">
            <span>Order limit in use</span>
            <strong>
              {num(workload.in_flight_units)}
              {" of "}
              {num(workload.max_active_units)}
            </strong>
          </div>
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
          <Link href="/explore" className="text-link">Find a creator ›</Link>
        </Empty>}
        <div className="section-heading">
          <h2>Shortcuts</h2>
        </div>
        <div className="service-grid">
          <Link className="panel" href="/creator/services/new">
            <Badge>Creator</Badge>
            <h3>Publish a service</h3>
            <p>Set a clear scope, price, samples, and real available capacity.</p>
          </Link>
          <Link className="panel" href="/buyer/requests/new">
            <Badge>Buyer</Badge>
            <h3>Post an open brief</h3>
            <p>Tell the community what you need and compare approaches.</p>
          </Link>
          <Link className="panel" href="/creator/auctions/new">
            <Badge>Optional</Badge>
            <h3>Open an auction</h3>
            <p>Offer a time-bound slot when direct booking is not the right fit.</p>
          </Link>
        </div>
      </section>
    </div>
  </main>;
}
