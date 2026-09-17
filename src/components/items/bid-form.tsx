'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { usd } from '@/lib/items';
import styles from './item-media.module.css';

/** An auctioneer's gavel over its sound block; the hammer turns about the end of its handle. */
function Gavel() {
  return <svg className={styles.gavel} viewBox="0 0 48 48" aria-hidden focusable="false">
    <g className={styles.gavelHammer}>
      <path className={styles.gavelHandle} d="M22 21l17 17" />
      <rect className={styles.gavelHead} x="7" y="9" width="22" height="11" rx="2.5" transform="rotate(-45 18 14.5)" />
      <path className={styles.gavelBand} d="M12.5 13.5l7.5 7.5M16.5 9.5l7.5 7.5" />
    </g>
    <rect className={styles.gavelBlock} x="3" y="38" width="22" height="6" rx="1.5" />
    <path className={styles.gavelSpark} d="M6 33l-3-3M14 31v-4M22 33l3-3" />
  </svg>;
}

const STRIKE_MS = 520;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Place bid" as a gavel. Pressing it swings the gavel onto its block while the bid is sent; the answer shows under the
 * button and the price updates in place. Without JavaScript it is a plain form post and the page answers the same way.
 */
export function BidForm({ listingId, nextMinimum, idempotencyKey, route }: { listingId: string; nextMinimum: number; idempotencyKey: string; route: string }) {
  const router = useRouter();
  const id = useId();
  const minimum = (nextMinimum / 100).toFixed(2);
  const [amount, setAmount] = useState(minimum);
  const [strikes, setStrikes] = useState(0);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  // A new minimum after someone bids (or this bid lands) becomes the suggested amount.
  useEffect(() => setAmount(minimum), [minimum]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const body = new FormData(event.currentTarget);
    body.set('idempotency_key', crypto.randomUUID());
    setBusy(true);
    setAnswer(null);
    setStrikes((count) => count + 1);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const [response] = await Promise.all([
      fetch('/api/commands', { method: 'POST', body, headers: { accept: 'application/json' } }).catch(() => null),
      pause(still ? 0 : STRIKE_MS),
    ]);
    const result = response ? await response.json().catch(() => ({})) as { message?: string; error?: string } : { error: 'Network error. Try again.' };
    if (response?.ok) {
      setAnswer({ tone: 'ok', text: result.message ?? 'Bid placed.' });
      router.refresh();
    } else {
      setAnswer({ tone: 'error', text: result.error ?? 'The bid was not placed. Try again.' });
    }
    setBusy(false);
  }

  return <form method="post" action="/api/commands" className={styles.bidForm} onSubmit={submit}>
    <input type="hidden" name="command" value="bid_item" />
    <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    <input type="hidden" name="return_to" value={route} />
    <input type="hidden" name="listing_id" value={listingId} />
    <div className="field">
      <label htmlFor={`${id}-amount`}>Your bid (USD, at least {usd(nextMinimum)})</label>
      <input id={`${id}-amount`} name="amount" type="number" min={minimum} step="0.01" inputMode="decimal" required value={amount} onChange={(event) => setAmount(event.target.value)} />
    </div>
    <button type="submit" className={styles.bidButton} disabled={busy} aria-busy={busy}>
      <span key={strikes} className={`${styles.gavelWrap}${strikes ? ` ${styles.striking}` : ''}`}><Gavel /></span>
      <span className={styles.bidLabel}>{busy ? 'Bidding…' : 'Place bid'}</span>
    </button>
    {answer && <p className={answer.tone === 'ok' ? styles.bidOk : styles.bidError} role={answer.tone === 'ok' ? 'status' : 'alert'}>{answer.text}</p>}
  </form>;
}
