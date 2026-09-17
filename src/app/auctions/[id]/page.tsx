import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { ITEM_CONFIRM_HOURS, ITEM_PAYMENT_HOURS, ORIGIN_LABEL, SALE_STATUS_LABEL, usd } from '@/lib/items';
import { getItemListing, type ItemListingDetail } from '@/modules/items/queries';
import { Avatar } from '@/components/avatar';
import { Countdown } from '@/components/items/countdown';
import { LiveRefresh } from '@/components/items/live-refresh';
import { XProfileCard } from '@/components/x/x-profile-card';
import { BidForm } from '@/components/items/bid-form';
import { ItemArt } from '@/components/items/item-art';
import { ItemGallery } from '@/components/items/item-gallery';
import { FileUploadField } from '@/components/files/file-upload-field';
import media from '@/components/items/item-media.module.css';
import { randomUUID } from 'node:crypto';
import { CommandForm, Empty, date } from '@/components/ui';
import { Notices } from '@/components/notices';
import type { PageProps } from '@/components/page-props';
import { PaymentsClosed } from '@/components/payments-closed';
import { appStage, auctionMoneyNote, paymentsOpen } from '@/lib/environment';

export const dynamic = 'force-dynamic';

const LISTING_STATE: Record<string, string> = { AWAITING_COLLATERAL: 'Waiting for collateral', OPEN: 'Open', SOLD: 'Sold', NO_BIDS: 'Ended without bids', CANCELLED: 'Cancelled' };

/** The price box for everyone while the auction runs, and for the two parties after it sold. */
function ActionPanel({ detail, route, signedIn }: { detail: ItemListingDetail; route: string; signedIn: boolean }) {
  const { listing, sale, role } = detail;
  const values = { listing_id: listing.id };

  if (listing.status === 'AWAITING_COLLATERAL') {
    return <>
      <h2>Lock the collateral</h2>
      <p>Bidding opens once your <strong className="item-money">{usd(listing.collateral)}</strong> collateral is locked. You get it back when the buyer confirms delivery, or if nobody bids.</p>
      {paymentsOpen()
        ? <CommandForm command="post_item_collateral" label={`Lock ${usd(listing.collateral)}${appStage() === 'production' ? '' : ' (sandbox)'}`} values={values} returnTo={route} />
        : <PaymentsClosed>Locking collateral opens when payments open on spaca, and bidding starts after that. Your listing and its pictures are saved.</PaymentsClosed>}
      <CommandForm command="cancel_item_listing" label="Cancel listing" variant="secondary" values={values} returnTo={route} />
    </>;
  }

  if (listing.status === 'OPEN') {
    const price = listing.currentBid ?? listing.startingPrice;
    return <>
      <div className="item-price-block">
        <span className="item-label">{listing.currentBid == null ? 'Starting price' : 'Current bid'}</span>
        <strong className="item-price item-price-large">{usd(price)}</strong>
        <span className="muted">{listing.bidCount} {listing.bidCount === 1 ? 'bid' : 'bids'}{listing.leading ? ' · You are the highest bidder' : ''}</span>
      </div>
      <p className="item-clock">
        <span className="item-label">{listing.upcoming ? 'Opens in' : 'Ends in'}</span>
        <Countdown to={listing.upcoming ? listing.startsAt : listing.endsAt} serverNow={listing.serverNow} />
      </p>
      {role === 'seller' ? <>
        <p className="muted">This is your listing. Bidding closes on its own at {date(listing.endsAt)}.</p>
        {listing.bidCount === 0 && <CommandForm command="cancel_item_listing" label="Cancel and unlock collateral" variant="secondary" values={values} returnTo={route} />}
      </> : !signedIn ? <Link className="button button-dark item-action" href={`/sign-in?return_to=${encodeURIComponent(route)}`}>Log in to bid</Link>
        : !paymentsOpen() ? <PaymentsClosed>Bidding opens when payments open on spaca, because a winning bid is paid into escrow.</PaymentsClosed>
        : listing.live ? <>
          <BidForm listingId={listing.id} nextMinimum={listing.nextMinimum} idempotencyKey={randomUUID()} route={route} />
          {listing.buyNowAvailable && <CommandForm command="buy_item_now" label={`Buy now for ${usd(listing.buyNowPrice!)}`} variant="secondary" values={values} returnTo={route} />}
        </> : <p className="muted">Bidding opens {date(listing.startsAt)}.</p>}
      <p className="item-collateral-note">Seller collateral <strong className="item-money">{usd(listing.collateral)}</strong>, {Math.round((listing.collateral / price) * 100)}% of the {listing.currentBid == null ? 'starting price' : 'current bid'}. If the item is not delivered by {date(listing.deliveryDueAt)}, the winner gets their payment back plus this collateral.</p>
    </>;
  }

  if (!sale) return <><h2>{LISTING_STATE[listing.status]}</h2><p className="muted">{listing.status === 'NO_BIDS' ? 'Nobody bid, so the collateral went back to the seller.' : listing.cancelReason ?? 'This listing is closed.'}</p></>;

  const saleValues = { sale_id: sale.id };
  const outcome = <div className="item-price-block">
    <span className="item-label">{sale.kind === 'BUY_NOW' ? 'Bought now for' : 'Winning bid'}</span>
    <strong className="item-price item-price-large">{usd(sale.price)}</strong>
    <span className={`item-sale-status item-sale-${sale.status.toLowerCase()}`}>{SALE_STATUS_LABEL[sale.status]}</span>
  </div>;

  if (role === 'buyer') {
    return <>
      {outcome}
      {sale.status === 'AWAITING_PAYMENT' && (sale.paymentOverdue ? <p className="muted">The payment window closed.</p> : <>
        <p>You won. Pay into escrow within <Countdown to={sale.paymentDueAt} serverNow={listing.serverNow} />; the seller cannot touch it until you confirm delivery.</p>
        {!paymentsOpen() ? <PaymentsClosed>Paying into escrow opens when payments open on spaca.</PaymentsClosed> : <CommandForm command="pay_item_sale" label={`Pay ${usd(sale.price)} into escrow${appStage() === 'production' ? '' : ' (sandbox)'}`} values={saleValues} returnTo={route}>
          <div className="field">
            <label htmlFor="item-buyer-details">Your {listing.buyerProvides}</label>
            <input id="item-buyer-details" name="buyer_details" required minLength={3} maxLength={300} autoCapitalize="none" spellCheck={false} />
            <small>Only the seller sees this, to deliver the item.</small>
          </div>
        </CommandForm>}
      </>)}
      {sale.status === 'AWAITING_DELIVERY' && <>
        <p>Your payment is held. The seller must deliver by <strong>{date(listing.deliveryDueAt)}</strong>.</p>
        {sale.buyerDetails && <p className="item-detail-line"><span className="item-label">You gave</span> <span className="mono">{sale.buyerDetails}</span></p>}
        {sale.deliveryOverdue && <CommandForm command="claim_item_refund" label={`Claim ${usd(sale.price + sale.collateral)} refund`} values={saleValues} returnTo={route} />}
      </>}
      {sale.status === 'DELIVERED' && <>
        <p>The seller marked it delivered. Check it, then confirm. Without a reply by {date(sale.confirmBy)}, it counts as confirmed.</p>
        {sale.deliveryProof && <p className="item-proof"><span className="item-label">Seller’s proof</span>{sale.deliveryProof}</p>}
        <CommandForm command="confirm_item_received" label="I received it" values={saleValues} returnTo={route} />
      </>}
      {(sale.status === 'AWAITING_DELIVERY' || sale.status === 'DELIVERED') && <details className="item-dispute">
        <summary>Something is wrong</summary>
        <CommandForm command="dispute_item_sale" label="Open a dispute" variant="danger" values={saleValues} returnTo={route}>
          <div className="field">
            <label htmlFor="item-dispute-reason">What went wrong</label>
            <textarea id="item-dispute-reason" name="dispute_reason" required minLength={10} maxLength={1000} rows={3} />
            <small>The payment and collateral stay in escrow until an operator decides.</small>
          </div>
        </CommandForm>
      </details>}
      <SaleOutcome detail={detail} />
    </>;
  }

  if (role === 'seller') {
    return <>
      {outcome}
      {sale.status === 'AWAITING_PAYMENT' && <p>Waiting for the winner to pay into escrow, until {date(sale.paymentDueAt)}. If they do not, your collateral is unlocked.</p>}
      {sale.status === 'AWAITING_DELIVERY' && <>
        <p>Paid into escrow. Deliver by <strong>{date(listing.deliveryDueAt)}</strong>: <Countdown to={listing.deliveryDueAt} serverNow={listing.serverNow} /> left.</p>
        {sale.buyerDetails && <p className="item-detail-line"><span className="item-label">Deliver to ({listing.buyerProvides})</span> <span className="mono">{sale.buyerDetails}</span></p>}
        <CommandForm command="mark_item_delivered" label="Mark as delivered" values={saleValues} returnTo={route}>
          <div className="field">
            <label htmlFor="item-delivery-proof">Proof of delivery</label>
            <textarea id="item-delivery-proof" name="delivery_proof" required minLength={5} maxLength={500} rows={3}
              placeholder="Transaction hash, allowlist checker link, or what the project confirmed" />
            <small>The buyer then has {ITEM_CONFIRM_HOURS} hours to confirm or dispute.</small>
          </div>
        </CommandForm>
      </>}
      {sale.status === 'DELIVERED' && <p>Waiting for the buyer to confirm, until {date(sale.confirmBy)}. Then you are paid and the collateral is unlocked.</p>}
      <SaleOutcome detail={detail} />
    </>;
  }

  return <>{outcome}<p className="muted">{sale.kind === 'BUY_NOW' ? 'Sold with Buy now.' : 'The auction has ended.'}</p></>;
}

/** Where the money went, once it has gone somewhere. */
function SaleOutcome({ detail }: { detail: ItemListingDetail }) {
  const { sale } = detail;
  if (!sale) return null;
  const lines: Record<string, string> = {
    COMPLETED: `The seller received ${usd(sale.price)} and the ${usd(sale.collateral)} collateral back.`,
    SELLER_DEFAULTED: `The buyer received ${usd(sale.price)} back plus the ${usd(sale.collateral)} collateral.`,
    REFUNDED: `The buyer received ${usd(sale.price)} back; the seller's collateral was unlocked.`,
    PAYMENT_EXPIRED: `The winner did not pay in time. The seller's collateral was unlocked.`,
    DISPUTED: 'In dispute: the payment and collateral stay in escrow until an operator decides.',
  };
  return lines[sale.status] ? <p className="item-outcome">{lines[sale.status]}</p> : null;
}

export default async function ItemListingPage({ params, searchParams }: PageProps<{ id: string }>) {
  const query = await searchParams;
  const { id } = await params;
  const route = `/auctions/${id}`;
  const actor = await getActor();
  const detail = await getItemListing(id, actor);
  if (!detail) notFound();
  const { listing, seller, bids } = detail;

  return <main className="container item-page">
    <Notices query={query} />
    <LiveRefresh active={listing.status === 'OPEN'} />
    <header className="item-head">
      <div className="chip-row">
        <span className="chip">{listing.itemType}</span>
        <span className={`item-origin item-origin-${listing.origin.toLowerCase()}`}>{ORIGIN_LABEL[listing.origin]}</span>
        <span className="chip">{LISTING_STATE[listing.status]}</span>
      </div>
      <h1>{listing.title}</h1>
      <p className="item-head-meta">
        {listing.projectUrl ? <a className="text-link" href={listing.projectUrl} target="_blank" rel="noreferrer nofollow">{listing.projectName} ↗</a> : listing.projectName}
        {' · '}{listing.network}{' · '}{listing.quantity}
      </p>
    </header>

    <div className="item-layout">
      <div className="item-main">
        {detail.images.length
          ? <ItemGallery title={listing.title} images={detail.images} />
          : <div className={media.heroArt}><ItemArt itemType={listing.itemType} size="hero" /></div>}
        {detail.role === 'seller' && (listing.status === 'AWAITING_COLLATERAL' || listing.status === 'OPEN') && <section className="panel" aria-labelledby="item-pictures">
          <h2 id="item-pictures">Pictures</h2>
          <p className="muted">{detail.images.length ? `${detail.images.length} of 6 shown; the first is the cover. Uploading replaces them all.` : 'Add the art, a project banner or an allowlist screenshot so bidders can see what they get.'}</p>
          <CommandForm command="set_item_images" label={detail.images.length ? 'Replace pictures' : 'Save pictures'} variant="secondary" values={{ listing_id: listing.id }} returnTo={route}>
            <FileUploadField purpose="ITEM_IMAGE" name="image_ids" label="Pictures" maxFiles={6} />
          </CommandForm>
          {detail.images.length > 0 && <CommandForm command="set_item_images" label="Remove all pictures" variant="danger" values={{ listing_id: listing.id, clear: 'true' }} returnTo={route} />}
        </section>}
        <section className="panel" aria-labelledby="item-about">
          <h2 id="item-about">About this item</h2>
          <p className="prewrap">{listing.description}</p>
        </section>
        <section className="panel" aria-labelledby="item-delivery">
          <h2 id="item-delivery">Delivery</h2>
          <p className="prewrap item-delivery-method">{listing.deliveryMethod}</p>
          <dl className="item-terms">
            <div><dt>Bidding opens</dt><dd>{date(listing.startsAt)}</dd></div>
            <div><dt>Bidding closes</dt><dd>{date(listing.endsAt)}</dd></div>
            <div><dt>The winner provides</dt><dd>{listing.buyerProvides}</dd></div>
            <div><dt>Delivered by</dt><dd>{date(listing.deliveryDueAt)}</dd></div>
            <div><dt>Winner pays within</dt><dd>{ITEM_PAYMENT_HOURS} hours</dd></div>
            <div><dt>Buyer confirms within</dt><dd>{ITEM_CONFIRM_HOURS} hours of delivery</dd></div>
          </dl>
        </section>
        <section className="panel" aria-labelledby="item-seller">
          <h2 id="item-seller">Seller</h2>
          <div className="item-seller">
            <Avatar name={seller.name} assetId={seller.avatarAssetId} size={44} />
            <div>
              <strong>{seller.name}</strong>
              <span className="muted">{seller.accountType} account{seller.handle ? ` · @${seller.handle}` : ''}</span>
            </div>
          </div>
          {seller.x ? <XProfileCard x={seller.x} variant="compact" /> : <p className="muted">No X account connected.</p>}
        </section>
        <section className="panel" aria-labelledby="item-bids">
          <h2 id="item-bids">Bid history</h2>
          {bids.length ? <ol className="item-bids">
            {bids.map((bid) => <li key={bid.sequence}>
              <strong className="item-money">{usd(bid.amount)}</strong>
              <span>{bid.bidder}</span>
              <span className="muted">{date(bid.at)}</span>
            </li>)}
          </ol> : <Empty title="No bids yet">Bids appear here as they come in, newest first.</Empty>}
        </section>
      </div>
      <aside className="panel item-action-panel" aria-label="Price and actions">
        <ActionPanel detail={detail} route={route} signedIn={Boolean(actor)} />
        {auctionMoneyNote() && <p className="items-sandbox">{auctionMoneyNote()}</p>}
      </aside>
    </div>
  </main>;
}
