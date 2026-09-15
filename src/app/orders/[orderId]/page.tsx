import { OrderMessagesPanel } from '@/components/order-workspace/messages-panel';
import { OrderNextStepPanel } from '@/components/order-workspace/next-step-panel';
import { OrderTimelinePanel } from '@/components/order-workspace/timeline-panel';
import { OrderDeliveryPanel } from '@/components/order-workspace/delivery-panel';
import { ReportForm } from '@/components/report-form';
import { OrderBriefPanel } from '@/components/order-workspace/brief-panel';
import { OrderDeadlinePanel } from '@/components/order-workspace/deadline-panel';
import { OrderFilesPanel } from '@/components/order-workspace/files-panel';
import { OrderDigitalPanel } from '@/components/order-workspace/digital-panel';
import { NetworkBadge } from '@/components/crypto/crypto-payment-panel';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrderData } from '@/lib/read-model';
import { recordOrderPageView } from '@/modules/orders/views';
import { Badge, money, row, rows, str, humanize } from '@/components/ui';
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
  // Buyer opening the order records delivery view evidence before rendering (§7.5, ORD-11/16).
  await recordOrderPageView(actor, orderId);
  const result = await getOrderData(actor, orderId);
  if (!result) notFound();
  const d = row(result),
    o = row(d.order),
    delivery = rows(d.deliveries),
    events = rows(d.events),
    messages = rows(d.messages),
    reviews = rows(d.reviews),
    files = rows(d.files);
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
        eyebrow={`${humanize(str(o.source, 'BOOK'))} order · ${humanize(str(o.status))}`}
        title={str(o.title)}
        description={`${str(o.buyer_name)} and ${str(o.creator_name)} · ${money(o.amount_minor)} · Platform fee ${money(o.platform_fee_minor)}`}
      />
      <div className="inline-actions">
        <Badge>
          {str(o.payment_status, 'PENDING')}
        </Badge>
        {str(o.payment_rail) === 'CRYPTO' && d.payment_receipt ? <NetworkBadge mode={row(d.payment_receipt).network_mode} /> : null}
      </div>
    </div>
    <div className="split">
      <div>
        {d.digital ? <OrderDigitalPanel order={o} digital={row(d.digital)} buyer={buyer} route={route} /> : null}
        <OrderBriefPanel order={o} digital={Boolean(d.digital)} />
        {d.digital ? null : <OrderDeadlinePanel order={o} actorId={actor.id} amendments={rows(d.amendments)} active={d.active_amendment ? row(d.active_amendment) : null} route={route} />}
        <OrderFilesPanel order={o} files={files} buyer={buyer} />
        <OrderDeliveryPanel order={o} delivery={delivery} files={files} creator={creator} route={route} publishTerms={d.publish_terms} proofs={rows(d.publish_proofs)} />
        <OrderTimelinePanel events={events} />
        <ReportForm targetType="ORDER" targetId={str(o.id)} returnTo={route} label={`Report a problem with ${creator ? 'the buyer' : 'the creator'}`} />
      </div>
      <aside>
        <OrderNextStepPanel
          order={o}
          buyer={buyer}
          creator={creator}
          actorId={actor.id}
          reviews={reviews}
          latestDeliveryVersion={d.latest_delivery_version === null ? null : Number(d.latest_delivery_version)}
          activeCancellation={d.active_cancellation_request ? row(d.active_cancellation_request) : null}
          activeHold={d.active_review_hold ? row(d.active_review_hold) : null}
          cryptoPayment={d.crypto_payment ? row(d.crypto_payment) : null}
          cryptoOptions={rows(d.crypto_options)}
          digital={Boolean(d.digital)}
          route={route}
        />
        <OrderMessagesPanel order={o} messages={messages} route={route} />
      </aside>
    </div>
  </main>;
}
