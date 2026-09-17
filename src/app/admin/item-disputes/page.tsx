import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasAnyRole } from '@/modules/admin/policy';
import { getItemDisputes } from '@/modules/items/queries';
import { usd } from '@/lib/items';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import type { PageProps } from '@/components/page-props';
import { AdminCommand, AdminPage, SelectField, age } from '@/components/admin/ui';
import { date } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** Disputed web3 item sales (drizzle/0033). Support reads; finance or admin decide, with a reason for the audit log. */
export default async function ItemDisputesPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const route = '/admin/item-disputes';
  const { actor, prompt } = await requireActorOrLoginPrompt(route, query);
  if (!actor) return prompt;
  if (!hasAnyRole(actor, ['finance', 'support', 'admin'])) notFound();
  const disputes = await getItemDisputes();

  return <AdminPage actor={actor} route={route} query={query} title="Item disputes"
    description="Payment and collateral stay in escrow until decided. Pay the seller, refund the buyer with the collateral (seller at fault), or refund without fault (collateral back to the seller).">
    {!disputes.length && <p className="muted">No open item disputes.</p>}
    <div className="admin-card-grid">
      {disputes.map((dispute) => <section className="panel" key={dispute.id}>
        <h2>{dispute.title}</h2>
        <p><Link className="text-link" href={`/auctions/${dispute.listingId}`}>Open the listing ›</Link> · {dispute.itemType} · open {age(Math.max(0, (Date.now() - new Date(dispute.disputedAt).getTime()) / 1000))}</p>
        <ul className="facts">
          <li><span>Buyer</span><strong>{dispute.buyerName}</strong></li>
          <li><span>Seller</span><strong>{dispute.sellerName}</strong></li>
          <li><span>Price in escrow</span><strong>{usd(dispute.price)}</strong></li>
          <li><span>Seller collateral</span><strong>{usd(dispute.collateral)}</strong></li>
          <li><span>Delivery deadline</span><strong>{date(dispute.deliveryDueAt)}</strong></li>
          <li><span>Buyer gave ({dispute.buyerProvides})</span><strong className="mono">{dispute.buyerDetails ?? '—'}</strong></li>
          <li><span>Seller’s proof</span><strong>{dispute.deliveryProof ?? 'Not marked delivered'}</strong></li>
          <li><span>Buyer’s reason</span><strong>{dispute.disputeReason}</strong></li>
        </ul>
        <AdminCommand command="admin_resolve_item_dispute" route={route} values={{ sale_id: dispute.id }} label="Resolve dispute">
          <SelectField name="outcome" label="Outcome" options={['RELEASE_TO_SELLER', 'REFUND_WITH_COLLATERAL', 'REFUND']} />
        </AdminCommand>
      </section>)}
    </div>
  </AdminPage>;
}
