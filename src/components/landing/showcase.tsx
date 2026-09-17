import Link from 'next/link';
import { Avatar } from '@/components/avatar';
import { Countdown } from '@/components/items/countdown';
import { availabilityLabel, money, num, str } from '@/components/ui';
import { ITEM_CONFIRM_HOURS, ITEM_PAYMENT_HOURS, ORIGIN_LABEL, usd, type ItemOrigin } from '@/lib/items';
import { auctionMoneyNote } from '@/lib/environment';
import styles from './landing.module.css';

type Row = Record<string, unknown>;

/**
 * The three strips of real stock on the landing page: services with a picture, the creators behind them and open
 * item auctions. Each one draws nothing at all when it has no rows — a marketplace with no stock says so by being
 * quiet, it does not fill the space with sample cards.
 */

/** A service the way a marketplace shows one: the work first, then who made it, then the price to start from. */
function ServiceTile({ service }: { service: Row }) {
  const title = str(service.title, 'Service');
  return <Link className={styles.serviceTile} href={`/services/${str(service.id)}`}>
    <span className={styles.serviceArt}>
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed redirect, not a static asset */}
      <img src={`/api/samples/${str(service.sample_asset_id)}`} alt={str(service.sample_title, `Work sample for ${title}`)} loading="lazy" />
    </span>
    <span className={styles.serviceBy}>
      <Avatar name={service.creator_name} assetId={service.avatar_asset_id} size={24} />
      <span>{str(service.creator_name, 'Independent creator')}</span>
    </span>
    <span className={styles.serviceTitle}>{title}</span>
    <span className={styles.servicePrice}>From <strong>{money(service.price_minor)}</strong></span>
  </Link>;
}

export function PopularServices({ services, label }: { services: Row[]; label: 'POPULAR' | 'NEW' }) {
  if (!services.length) return null;
  // DSC-04: "Popular" is a claim about demand. Without the evidence the heading says what the order really is.
  const heading = label === 'POPULAR' ? 'Popular services' : 'New services';
  const blurb = label === 'POPULAR'
    ? 'Ready to buy at a fixed price, with the delivery time and revisions agreed up front.'
    : 'Recently published and ready to buy at a fixed price. Not enough completed orders yet to rank them by demand.';
  return <section id="services" className={styles.stripSection} aria-labelledby="services-heading">
    <div className={styles.containerWide}>
      <div className={styles.goalsHead}>
        <div>
          <p className={styles.kicker}>Services</p>
          <h2 id="services-heading" className={styles.h2Flush}>{heading}</h2>
          <p className={styles.stripBlurb}>{blurb}</p>
        </div>
        <Link className={styles.more} href="/explore">Browse all services ›</Link>
      </div>
      <div className={styles.serviceGrid}>
        {services.map((service) => <ServiceTile key={str(service.id)} service={service} />)}
      </div>
    </div>
  </section>;
}

/** A creator card: who they are, what they work on, what they start at and whether they can take an order today. */
function CreatorTile({ creator }: { creator: Row }) {
  const handle = str(creator.handle);
  const availability = availabilityLabel(creator.availability_status);
  return <Link className={styles.creatorTile} href={handle ? `/creators/${handle}` : `/explore?selected=${str(creator.id)}`}>
    <Avatar name={creator.creator_name} assetId={creator.avatar_asset_id} size={56} />
    <span className={styles.creatorName}>{str(creator.creator_name, 'Independent creator')}</span>
    {handle ? <span className={styles.creatorHandle}>@{handle}</span> : null}
    {creator.niche ? <span className={styles.creatorNiche}>{str(creator.niche)}</span> : null}
    <span className={styles.creatorPrice}>From <strong>{money(creator.from_price_minor)}</strong></span>
    <span className={styles.creatorStatus} data-accepting={availability.accepting ? 'yes' : 'no'}>{availability.label}</span>
  </Link>;
}

export function CreatorsAvailable({ creators }: { creators: Row[] }) {
  if (!creators.length) return null;
  return <section id="creators" className={styles.stripSection} aria-labelledby="creators-heading">
    <div className={styles.containerWide}>
      <div className={styles.goalsHead}>
        <div>
          <p className={styles.kicker}>Creators</p>
          <h2 id="creators-heading" className={styles.h2Flush}>Creators available</h2>
          <p className={styles.stripBlurb}>Crypto-native writers, analysts and hosts on X, chosen on their work samples.</p>
        </div>
        <Link className={styles.more} href="/explore">Explore creators ›</Link>
      </div>
      <div className={styles.creatorGrid}>
        {creators.map((creator) => <CreatorTile key={str(creator.id)} creator={creator} />)}
      </div>
    </div>
  </section>;
}

/** One open item auction: what is on the block, the price to beat, the step to clear it and the server's clock. */
function AuctionTile({ listing, serverNow }: { listing: Row; serverNow: string }) {
  const currentBid = listing.current_bid_minor == null ? null : num(listing.current_bid_minor);
  const upcoming = Boolean(listing.upcoming);
  const origin = str(listing.origin, 'RESALE') as ItemOrigin;
  return <Link className={styles.auctionTile} href={`/auctions/${str(listing.id)}`}>
    <span className={styles.auctionTop}>
      <span className={styles.auctionType}>{str(listing.item_type)}</span>
      <span className={styles.auctionOrigin}>{ORIGIN_LABEL[origin] ?? str(listing.origin)}</span>
    </span>
    <span className={styles.auctionTitle}>{str(listing.title, 'Item')}</span>
    <span className={styles.auctionMeta}>{str(listing.project_name)} · {str(listing.seller_name, 'Seller')}</span>
    <span className={styles.auctionNumbers}>
      <span>
        <span className={styles.auctionLabel}>{currentBid == null ? 'Starting at' : 'Current bid'}</span>
        <strong className={styles.auctionPrice}>{usd(currentBid ?? num(listing.starting_price_minor))}</strong>
      </span>
      <span>
        <span className={styles.auctionLabel}>{upcoming ? 'Opens in' : 'Ends in'}</span>
        <span className={styles.auctionClock}><Countdown to={str(upcoming ? listing.starts_at : listing.ends_at)} serverNow={serverNow} /></span>
      </span>
    </span>
    <span className={styles.auctionFoot}>Bid in steps of {usd(num(listing.min_increment_minor))} · collateral {usd(num(listing.collateral_minor))}</span>
  </Link>;
}

export function AuctionsStrip({ auctions, serverNow }: { auctions: Row[]; serverNow: string }) {
  return <section id="auctions" className={styles.stripSection} aria-labelledby="auctions-heading">
    <div className={styles.containerWide}>
      <div className={styles.goalsHead}>
        <div>
          <p className={styles.kicker}>Auctions</p>
          <h2 id="auctions-heading" className={styles.h2Flush}>A third way to buy.</h2>
          <p className={styles.stripBlurb}>Whitelist spots, guaranteed mints and pre-market allocations, bid for in the open.</p>
        </div>
        <Link className={styles.more} href="/auctions">See open auctions ›</Link>
      </div>
      {auctions.length
        ? <div className={styles.auctionGrid}>
          {auctions.map((listing) => <AuctionTile key={str(listing.id)} listing={listing} serverNow={serverNow} />)}
        </div>
        // Nothing is open: describe the mechanism that actually runs rather than invent a listing to look busy.
        : <ol className={styles.auctionRules} aria-label="How an item auction works">
          <li><strong>The seller locks collateral</strong><span>A listing opens only once the collateral behind it is locked.</span></li>
          <li><strong>The winner pays into escrow</strong><span>{ITEM_PAYMENT_HOURS} hours to pay; the seller cannot touch it yet.</span></li>
          <li><strong>Delivery is confirmed</strong><span>{ITEM_CONFIRM_HOURS} hours to confirm. Nothing delivered means your money back with the collateral.</span></li>
        </ol>}
      {auctionMoneyNote() && <p className={styles.auctionNote}>{auctionMoneyNote()}</p>}
    </div>
  </section>;
}
