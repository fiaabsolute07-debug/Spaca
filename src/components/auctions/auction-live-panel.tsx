'use client';

import { useCallback, useEffect, useState } from 'react';

type Snapshot = {
  auction: {
    status: string;
    version: number;
    server_now: string;
    ends_at: string;
    starts_at: string;
    accepting_bids: boolean;
    highest_bid_minor: string | null;
    starting_price_minor: string;
    next_minimum_minor: string;
    bid_count: number;
    buy_now_available: boolean;
    payment_due_at: string | null;
  };
  viewer: { standing: string; my_highest_minor: string | null; order_id: string | null } | null;
};

const STANDING: Record<string, string> = {
  WINNING: 'You are the highest bidder',
  OUTBID: 'You have been outbid',
  WON_PAY: 'You won. Fund the order before the payment deadline',
  BOUGHT_PAY: 'Buy Now reserved. Fund the order to confirm',
  WON: 'You won and the order is funded',
  LOST: 'The auction ended with another winner',
  DEFAULTED: 'The payment window closed without funding',
  SELLER: 'You are the seller',
};

const usd = (minor: string | null) => (minor == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(minor) / 100));

function remaining(ms: number) {
  if (ms <= 0) return 'Ended';
  const seconds = Math.floor(ms / 1000);
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

/**
 * §10.6: polls the server snapshot every 5 s while visible and refetches on return. The countdown uses the server
 * clock offset. It never shows a bid as accepted unless the snapshot does.
 */
export function AuctionLivePanel({ auctionId, initial }: { auctionId: string; initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [offset, setOffset] = useState(() => new Date(initial.auction.server_now).getTime() - Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [stale, setStale] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/auctions/${auctionId}/snapshot`, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as Snapshot;
      setOffset(new Date(next.auction.server_now).getTime() - Date.now());
      setSnapshot(next);
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [auctionId]);

  useEffect(() => {
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => { clearInterval(poll); clearInterval(tick); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onVisible); };
  }, [refresh]);

  const a = snapshot.auction;
  const serverNow = now + offset;
  const startsIn = new Date(a.starts_at).getTime() - serverNow;
  return <div className="panel" aria-live="polite">
    <h2>Current standing</h2>
    <div className="price-big">{usd(a.highest_bid_minor ?? a.starting_price_minor)}</div>
    <ul className="facts">
      <li><span>Status</span><strong>{a.status.replaceAll('_', ' ')}</strong></li>
      <li><span>{startsIn > 0 ? 'Starts in' : 'Time left (server clock)'}</span><strong>{startsIn > 0 ? remaining(startsIn) : remaining(new Date(a.ends_at).getTime() - serverNow)}</strong></li>
      <li><span>Accepted bids</span><strong>{a.bid_count}</strong></li>
      <li><span>Minimum next bid</span><strong>{a.accepting_bids ? usd(a.next_minimum_minor) : '—'}</strong></li>
      {a.payment_due_at && <li><span>Winner payment due</span><strong>{new Date(a.payment_due_at).toUTCString()}</strong></li>}
      {snapshot.viewer && snapshot.viewer.standing !== 'NONE' && <li><span>You</span><strong>{STANDING[snapshot.viewer.standing] ?? snapshot.viewer.standing}{snapshot.viewer.my_highest_minor ? ` · your best ${usd(snapshot.viewer.my_highest_minor)}` : ''}</strong></li>}
    </ul>
    {snapshot.viewer?.order_id && <a className="text-link" href={`/orders/${snapshot.viewer.order_id}`}>Open your order ›</a>}
    <p className="muted">{stale ? 'Connection lost. Showing the last server snapshot; retrying.' : `Updated from the server every 5 seconds · version ${a.version}`}</p>
  </div>;
}
