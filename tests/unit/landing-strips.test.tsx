import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuctionsStrip, CreatorsAvailable, PopularServices } from '@/components/landing/showcase';

/**
 * The landing's three strips show real stock or nothing at all. These render both sides of that rule, because the
 * browser suite can only see whichever state the development database happens to be in.
 */
const NOW = '2026-09-17T06:00:00.000Z';

const service = {
  id: 'a1', title: 'Launch thread for an L2', price_minor: 25000, creator_name: 'Ari Nguyen',
  avatar_asset_id: 'av1', sample_asset_id: 'sm1', sample_title: 'A previous launch thread',
};
const creator = {
  id: 'c1', creator_name: 'Ari Nguyen', handle: 'aringuyen', niche: 'Layer 2', avatar_asset_id: 'av1',
  from_price_minor: 9000, availability_status: 'ACCEPTING',
};
const listing = {
  id: 'l1', title: 'Arcadia genesis WL spot', item_type: 'WL spot', project_name: 'Arcadia', origin: 'PROJECT',
  starting_price_minor: 10000, min_increment_minor: 1000, collateral_minor: 2000, bid_count: 2,
  starts_at: '2026-09-16T06:00:00.000Z', ends_at: '2026-09-20T06:00:00.000Z', upcoming: false,
  seller_name: 'Linh Pham', current_bid_minor: 12000,
};

describe('the services strip', () => {
  it('shows the work, the creator and the price to start from', () => {
    const html = renderToStaticMarkup(<PopularServices services={[service]} label="POPULAR" />);
    expect(html).toContain('Popular services');
    expect(html).toContain('/api/samples/sm1');
    expect(html).toContain('href="/services/a1"');
    expect(html).toContain('Ari Nguyen');
    expect(html).toContain('$250.00');
  });

  it('only claims "popular" with the demand evidence behind it, and says "new" otherwise (DSC-04)', () => {
    const html = renderToStaticMarkup(<PopularServices services={[service]} label="NEW" />);
    expect(html).toContain('New services');
    expect(html).not.toContain('Popular services');
    expect(html).toContain('Not enough completed orders yet');
  });

  it('draws nothing at all rather than a sample card when there is no stock', () => {
    expect(renderToStaticMarkup(<PopularServices services={[]} label="NEW" />)).toBe('');
  });
});

describe('the creators strip', () => {
  it('shows the handle, the field, the lowest price and whether orders can be placed', () => {
    const html = renderToStaticMarkup(<CreatorsAvailable creators={[creator]} />);
    expect(html).toContain('@aringuyen');
    expect(html).toContain('href="/creators/aringuyen"');
    expect(html).toContain('Layer 2');
    expect(html).toContain('$90.00');
    expect(html).toContain('Accepting orders');
    expect(html).toContain('data-accepting="yes"');
  });

  it('never paints a paused creator as available', () => {
    const html = renderToStaticMarkup(<CreatorsAvailable creators={[{ ...creator, availability_status: 'PAUSED' }]} />);
    expect(html).toContain('Paused');
    expect(html).toContain('data-accepting="no"');
  });

  it('draws nothing when no creator has published anything', () => {
    expect(renderToStaticMarkup(<CreatorsAvailable creators={[]} />)).toBe('');
  });
});

describe('the auctions strip', () => {
  it('with open auctions, shows the real item, the price to beat and the step to clear it', () => {
    const html = renderToStaticMarkup(<AuctionsStrip auctions={[listing]} serverNow={NOW} />);
    expect(html).toContain('href="/auctions/l1"');
    expect(html).toContain('Arcadia genesis WL spot');
    expect(html).toContain('Current bid');
    expect(html).toContain('$120.00');
    expect(html).toContain('Bid in steps of');
    expect(html).toContain('$10.00');
    // The countdown starts from the server's clock, so the first paint agrees with the server that closes it.
    expect(html).toContain('3d 0h');
    // The explanation replaces listings, it does not sit under them.
    expect(html).not.toContain('The seller locks collateral');
  });

  it('says "Starting at" until someone bids, and counts down to the opening of an auction not yet live', () => {
    const html = renderToStaticMarkup(<AuctionsStrip auctions={[{
      ...listing, current_bid_minor: null, bid_count: 0, upcoming: true, starts_at: '2026-09-17T08:00:00.000Z',
    }]} serverNow={NOW} />);
    expect(html).toContain('Starting at');
    expect(html).toContain('$100.00');
    expect(html).toContain('Opens in');
    expect(html).toContain('2h 00m');
  });

  it('with nothing open, explains the mechanism that actually runs instead of inventing a listing', () => {
    const html = renderToStaticMarkup(<AuctionsStrip auctions={[]} serverNow={NOW} />);
    expect(html).toContain('The seller locks collateral');
    expect(html).toContain('24 hours to pay');
    expect(html).toContain('72 hours to confirm');
    expect(html).toContain('href="/auctions"');
    // No prices, no countdowns, no card that looks like stock.
    expect(html).not.toContain('Current bid');
    expect(html).not.toContain('countdown');
  });

  it('keeps the sandbox label in both states, because no funds move either way', () => {
    for (const auctions of [[], [listing]]) {
      expect(renderToStaticMarkup(<AuctionsStrip auctions={auctions} serverNow={NOW} />)).toContain('no funds move');
    }
  });
});
