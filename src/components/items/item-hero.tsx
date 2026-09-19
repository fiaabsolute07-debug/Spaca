import Link from 'next/link';
import { usd } from '@/lib/items';
import type { ListingCard } from '@/modules/items/queries';
import { Countdown } from './countdown';
import { ItemArt } from './item-art';

/**
 * The one listing at the top of the board, with its picture at the size the seller uploaded it for.
 *
 * Which listing it is, is a rule rather than an editorial pick: the board already orders live listings by the time
 * they end, so this is the one **closing soonest** — and when nothing is live, the one opening next. That is why the
 * label says so instead of "featured": spaca does not have a way to choose a favourite, and would not claim one.
 * Everything shown is the listing's own: its picture, or its type's drawing when it has none.
 */
export function ItemHero({ listing, serverNow }: { listing: ListingCard; serverNow: string }) {
  const price = listing.currentBid ?? listing.startingPrice;
  return <Link className="item-hero" href={`/auctions/${listing.id}`}>
    <span className="item-hero-text">
      <span className="item-hero-eyebrow">{listing.upcoming ? 'Opening next' : 'Closing soonest'} · {listing.itemType}</span>
      <strong className="item-hero-title">{listing.title}</strong>
      <span className="item-hero-meta">{listing.projectName} · {listing.network} · {listing.quantity}</span>
      <span className="item-hero-numbers">
        <span>
          <span className="item-label">{listing.currentBid == null ? 'Starting at' : 'Current bid'}</span>
          <strong className="item-price item-price-large">{usd(price)}</strong>
        </span>
        <span>
          <span className="item-label">{listing.upcoming ? 'Opens in' : 'Ends in'}</span>
          <Countdown to={listing.upcoming ? listing.startsAt : listing.endsAt} serverNow={serverNow} />
        </span>
      </span>
      <span className="item-hero-foot">
        <span className="button button-dark item-hero-cta">{listing.upcoming ? 'See the listing' : 'Place a bid'}</span>
        <span className="item-hero-note">Collateral {usd(listing.collateral)} · {listing.bidCount} {listing.bidCount === 1 ? 'bid' : 'bids'}</span>
      </span>
    </span>
    <span className="item-hero-art">
      {listing.coverId
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed redirect, not a static asset
        ? <img src={`/api/item-images/${listing.coverId}`} alt="" />
        : <ItemArt itemType={listing.itemType} size="hero" decorative />}
    </span>
  </Link>;
}
