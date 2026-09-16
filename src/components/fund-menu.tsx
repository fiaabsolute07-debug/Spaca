'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Landmark, Wallet } from 'lucide-react';
import { MenuIcon } from './menu-icon';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AccountType } from '@/lib/account';

type Summary = {
  to_pay_minor: string; to_pay_count: number; held_as_buyer_minor: string; refunded_to_buyer_minor: string; released_by_buyer_minor: string;
  held_for_creator_minor: string; released_to_creator_minor: string; awaiting_buyer_payment_minor: string;
};
type Entry = { href: string; title: string; description: string; icon: ReactNode };

const usd = (minor: string | undefined) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(minor ?? 0) / 100);

const BUYER_LINKS: Entry[] = [
  { href: '/funds#to-pay', title: 'Pay for orders', description: 'Orders waiting for your payment', icon: <MenuIcon name="pay" /> },
  { href: '/funds#held', title: 'Held for work', description: 'Paid and waiting on delivery or approval', icon: <MenuIcon name="held" /> },
  { href: '/funds#pools', title: 'Campaign reward pools', description: 'Deposits and rewards for your campaigns', icon: <MenuIcon name="pool" /> },
  { href: '/funds#activity', title: 'Money activity', description: 'Payments, refunds and releases', icon: <MenuIcon name="activity" /> },
  { href: '/funds#wallets', title: 'Wallets', description: 'Addresses you proved you control', icon: <MenuIcon name="wallet" /> },
];
const CREATOR_LINKS: Entry[] = [
  { href: '/funds#held', title: 'Held for your work', description: 'Paid by buyers, released on approval', icon: <MenuIcon name="held" /> },
  { href: '/funds#payouts', title: 'Payouts', description: 'Releases and pool rewards on chain', icon: <MenuIcon name="payout" /> },
  { href: '/funds#activity', title: 'Money activity', description: 'Payments, refunds and releases', icon: <MenuIcon name="activity" /> },
  { href: '/funds#wallets', title: 'Wallets', description: 'Where crypto payouts are sent', icon: <MenuIcon name="wallet" /> },
];

/**
 * The Fund button beside Account: money at a glance and the ways into it. The numbers load when the menu first opens,
 * so no page pays for them unless someone looks. Closes like the Account menu: Escape, a click outside, navigating.
 */
export function FundMenu({ type }: { type: AccountType | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const creator = type === 'creator';

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    // Fresh numbers each time the menu opens: money moves while a page stays open.
    let cancelled = false;
    fetch('/api/funds/summary', { method: 'POST', headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((body: Summary) => { if (!cancelled) { setSummary(body); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const figures: [string, string, string?][] = creator
    ? [['Held for your work', usd(summary?.held_for_creator_minor)], ['Released to you', usd(summary?.released_to_creator_minor)]]
    : [['To pay', usd(summary?.to_pay_minor), summary ? `${summary.to_pay_count} order${summary.to_pay_count === 1 ? '' : 's'}` : undefined], ['Held for work', usd(summary?.held_as_buyer_minor)]];

  return <div className="fund-menu" ref={root}>
    <button ref={button} type="button" className="fund-menu-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <Wallet size={15} aria-hidden /> Fund <ChevronDown size={14} aria-hidden />
    </button>
    <div id={panelId} className="fund-menu-panel" hidden={!open} role="group" aria-label="Fund menu">
      <div className="fund-figures" aria-live="polite">
        {figures.map(([label, value, note]) => <div key={label} className="fund-figure">
          <span>{label}</span>
          <strong>{summary ? value : failed ? '—' : '…'}</strong>
          {note ? <small>{note}</small> : null}
        </div>)}
      </div>
      {failed && <p className="fund-note">The figures could not be loaded. The Funds page has the full record.</p>}
      <nav aria-label="Funds">
        {(creator ? CREATOR_LINKS : BUYER_LINKS).map((entry) => <Link key={entry.href} className="nav-item" href={entry.href} onClick={() => setOpen(false)}>
          <span className="nav-item-icon">{entry.icon}</span>
          <span className="nav-item-text"><strong>{entry.title}</strong><small>{entry.description}</small></span>
        </Link>)}
      </nav>
      <Link className="button compact fund-open" href="/funds" onClick={() => setOpen(false)}><Landmark size={15} aria-hidden /> Open Funds</Link>
      <p className="fund-note">Local sandbox: simulated payments and local-devnet crypto. No real money moves.</p>
    </div>
  </div>;
}
