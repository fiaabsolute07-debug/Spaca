'use client';

import Link from 'next/link';
import { useRef, useState, type KeyboardEvent } from 'react';
import { BriefComposer } from './brief-composer';
import styles from './landing.module.css';

type Tab = 'search' | 'plan';

/** Real destinations only: each suggestion opens the campaign tab for that kind of work. */
const SUGGESTIONS = [
  { label: 'Launch threads', href: '/campaigns/launch' },
  { label: 'Disclosed shill posts', href: '/campaigns/shiller' },
  { label: 'Airdrop explainers', href: '/campaigns/airdrop' },
  { label: 'X Spaces hosts', href: '/campaigns/ama' },
  { label: 'Testnet walkthroughs', href: '/campaigns/testnet' },
];

const SearchIcon = ({ size = 18 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
const BriefIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M7 4h7l4 4v12H7z" /><path d="M14 4v4h4M10 13h5M10 17h3" /></svg>;
const Arrow = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>;

/**
 * The hero search, in the shape people already know from service marketplaces: two tabs over one field and a row of
 * suggestions. "Find creators" searches Explore; "Plan a campaign" is the fill-in brief that prefills sign-up.
 */
export function HeroSearch() {
  const [tab, setTab] = useState<Tab>('search');
  const tabs = useRef<Record<Tab, HTMLButtonElement | null>>({ search: null, plan: null });

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const next: Tab = tab === 'search' ? 'plan' : 'search';
    setTab(next);
    tabs.current[next]?.focus();
  };

  return <div className={styles.searchPanel}>
    <div className={styles.searchTabs} role="tablist" aria-label="Start with" onKeyDown={onKey}>
      <button ref={(el) => { tabs.current.search = el; }} type="button" role="tab" id="hero-tab-search" aria-controls="hero-panel-search"
        aria-selected={tab === 'search'} tabIndex={tab === 'search' ? 0 : -1} className={styles.searchTab} onClick={() => setTab('search')}>
        <SearchIcon /> Find creators
      </button>
      <button ref={(el) => { tabs.current.plan = el; }} type="button" role="tab" id="hero-tab-plan" aria-controls="hero-panel-plan"
        aria-selected={tab === 'plan'} tabIndex={tab === 'plan' ? 0 : -1} className={styles.searchTab} onClick={() => setTab('plan')}>
        <BriefIcon /> Plan a campaign
      </button>
    </div>

    <div role="tabpanel" id="hero-panel-search" aria-labelledby="hero-tab-search" hidden={tab !== 'search'}>
      <form className={styles.searchField} action="/explore" method="get" role="search">
        <input name="q" type="search" aria-label="Search creators" placeholder="Try “mainnet launch thread”" autoComplete="off" />
        <button type="submit" className={styles.searchGo} aria-label="Search"><SearchIcon size={20} /></button>
      </form>
      <nav className={styles.searchChips} aria-label="Popular campaigns">
        {SUGGESTIONS.map((item) => <Link key={item.href} className={styles.searchChip} href={item.href}>{item.label} <Arrow /></Link>)}
      </nav>
    </div>

    <div role="tabpanel" id="hero-panel-plan" aria-labelledby="hero-tab-plan" hidden={tab !== 'plan'}>
      <BriefComposer variant="panel" />
    </div>
  </div>;
}
