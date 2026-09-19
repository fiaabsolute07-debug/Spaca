import Link from 'next/link';
import { ORIGIN_LABEL, usd } from '@/lib/items';
import type { ListingCard } from '@/modules/items/queries';
import { Countdown } from './countdown';
import { ItemArt } from './item-art';
import media from './item-media.module.css';

/**
 * One item up for auction: what it is, who sells it, the price to beat, time left and the seller's collateral.
 * `wide` lays the card down with its picture beside the details, for a board holding only one or two listings — a
 * lone upright card in a three-up grid leaves most of the row empty.
 */
export function ItemCard({ listing, serverNow, wide = false }: { listing: ListingCard; serverNow: string; wide?: boolean }) {
  const price = listing.currentBid ?? listing.startingPrice;
  return <Link className={`item-card${wide ? ' is-wide' : ''}`} href={`/auctions/${listing.id}`}>
    <span className={`${media.cover} item-cover`}>
      {listing.coverId
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed redirect, not a static asset
        ? <img src={`/api/item-images/${listing.coverId}`} alt="" loading="lazy" />
        : <ItemArt itemType={listing.itemType} decorative />}
    </span>
    <span className="item-card-body">
      <span className="item-card-top">
        <span className="chip">{listing.itemType}</span>
        <span className={`item-origin item-origin-${listing.origin.toLowerCase()}`}>{ORIGIN_LABEL[listing.origin]}</span>
      </span>
      <h3>{listing.title}</h3>
      <span className="item-card-meta">{listing.projectName} · {listing.network} · {listing.quantity}</span>
      <span className="item-card-numbers">
        <span>
          <span className="item-label">{listing.currentBid == null ? 'Starting at' : 'Current bid'}</span>
          <strong className="item-price">{usd(price)}</strong>
        </span>
        <span className="item-card-time">
          <span className="item-label">{listing.upcoming ? 'Opens in' : 'Ends in'}</span>
          <Countdown to={listing.upcoming ? listing.startsAt : listing.endsAt} serverNow={serverNow} />
        </span>
      </span>
      <span className="item-card-foot">
        <span>Collateral {usd(listing.collateral)}</span>
        <span>{listing.bidCount} {listing.bidCount === 1 ? 'bid' : 'bids'}</span>
        {listing.buyNowPrice != null && listing.bidCount === 0 ? <span>Buy now {usd(listing.buyNowPrice)}</span> : null}
      </span>
    </span>
  </Link>;
}
