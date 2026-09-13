import { OrderMessagesPanel } from '@/components/order-workspace/messages-panel';
import { OrderNextStepPanel } from '@/components/order-workspace/next-step-panel';
import { OrderTimelinePanel } from '@/components/order-workspace/timeline-panel';
import { OrderDeliveryPanel } from '@/components/order-workspace/delivery-panel';
import { OrderBriefPanel } from '@/components/order-workspace/brief-panel';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrderData } from '@/lib/read-model';
import { Badge, money, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function OrderPage({
  params,
  searchParams
}: PageProps<{
  orderId: string;
}>) {
  const query = await searchParams;
  const {
    orderId
  } = await params;
  const route = `/orders/${orderId}`;
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const result = await getOrderData(actor, orderId);
  if (!result) notFound();
  const d = row(result),
    o = row(d.order),
    delivery = rows(d.deliveries),
    events = rows(d.events),
    messages = rows(d.messages),
    reviews = rows(d.reviews);
  const creator = actor.id === str(o.creator_id),
    buyer = actor.id === str(o.buyer_id);
  return <main className="container">
    {notices}
    <div className="breadcrumbs">
      <Link href="/dashboard">Workspace</Link>
      {" / Order "}
      {str(o.id).slice(0, 8)}
    </div>
    <div className="section-heading">
      <PageHeading
        eyebrow={`${str(o.source, 'BOOK')} order · ${str(o.status)}`}
        title={str(o.title)}
        description={`${str(o.buyer_name)} and ${str(o.creator_name)} · ${money(o.amount_minor)} · Platform fee $0.00`}
      />
      <Badge>
        {str(o.payment_status, 'PENDING')}
      </Badge>
    </div>
    <div className="split">
      <div>
        <OrderBriefPanel order={o} />
        <OrderDeliveryPanel order={o} delivery={delivery} creator={creator} route={route} />
        <OrderTimelinePanel events={events} />
      </div>
      <aside>
        <OrderNextStepPanel order={o} buyer={buyer} creator={creator} reviews={reviews} route={route} />
        <OrderMessagesPanel order={o} messages={messages} route={route} />
      </aside>
    </div>
  </main>;
}
