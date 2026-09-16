'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { AccountType } from '@/lib/account';
import type { AccountSummary } from '@/lib/read-model';
import { Avatar } from './avatar';

type NavLink = { href: string; label: string };
type NavGroup = { title: string; links: NavLink[] };

const CREATOR_NAV: NavGroup[] = [
  { title: 'Workspace', links: [{ href: '/dashboard', label: 'Overview' }, { href: '/creator/services', label: 'My services' }, { href: '/buyer/orders', label: 'Orders' }, { href: '/creator/requests', label: 'My applications' }] },
  { title: 'Find work', links: [{ href: '/requests', label: 'Open campaigns' }, { href: '/creator/services/new', label: 'New service' }, { href: '/creator/auctions/new', label: 'New auction' }] },
];
const BUYER_NAV: NavGroup[] = [
  { title: 'Workspace', links: [{ href: '/dashboard', label: 'Overview' }, { href: '/buyer/orders', label: 'Orders' }, { href: '/buyer/requests', label: 'My campaigns' }] },
  { title: 'Hire', links: [{ href: '/explore', label: 'Find creators' }, { href: '/buyer/requests/new', label: 'Post a brief' }, { href: '/auctions', label: 'Auctions' }] },
];
const ACCOUNT_NAV: NavGroup = { title: 'Account', links: [{ href: '/settings/profile', label: 'Profile' }, { href: '/funds', label: 'Funds' }] };

/** 0x12ab…9f3c: enough to recognise an address without reading all of it. */
const shortAddress = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

/** Pages that belong to a menu entry without being under its URL. */
const ALIASES: [RegExp, string][] = [[/^\/orders\//, '/buyer/orders']];

const within = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

function activeHref(pathname: string, groups: NavGroup[]): string | null {
  const alias = ALIASES.find(([pattern]) => pattern.test(pathname));
  if (alias) return alias[1];
  // The most specific entry wins: /creator/services/new is "New service", not "My services".
  return groups.flatMap((group) => group.links).filter((link) => within(pathname, link.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

/**
 * Workspace navigation for signed-in accounts, in the header's top-right corner (the user wanted it there rather than in a
 * sidebar). A disclosure: the button toggles a panel of links and Log out; Escape, a click outside or navigating closes it.
 * The panel opens on the account itself (2026-09-16): photo, name, whether it is a buyer or a creator account, setup
 * state and the linked wallet, then the workspace links.
 */
export function AccountMenu({ type, account }: { type: AccountType | null; account: AccountSummary }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const groups = [...(type === 'creator' ? CREATOR_NAV : BUYER_NAV), ACCOUNT_NAV];
  const active = activeHref(pathname, groups);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
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
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return <div className="account-menu" ref={root}>
    <button ref={button} type="button" className="button compact account-menu-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <span className="account-menu-face">
        <Avatar name={account.name} assetId={account.avatarAssetId} size={22} />
        {!account.onboarded && <span className="account-menu-dot" aria-hidden />}
      </span>
      Account <ChevronDown size={14} aria-hidden />
    </button>
    <div id={panelId} className="account-menu-panel" hidden={!open}>
      <section className="account-card" aria-label="Signed in as">
        <div className="account-card-who">
          <Avatar name={account.name} assetId={account.avatarAssetId} size={44} />
          <div>
            <strong className="account-card-name">{account.name}</strong>
            {account.handle && account.onboarded && <span className="account-card-handle">@{account.handle}</span>}
            <span className={`account-card-type account-card-${type ?? 'operator'}`}>{type === 'creator' ? 'Creator account' : type === 'buyer' ? 'Buyer account' : 'Operator'}</span>
          </div>
        </div>
        {!account.onboarded && <Link className="account-card-setup" href="/welcome" onClick={() => setOpen(false)}>
          <span><strong>Finish setup</strong>{type === 'creator' ? 'Photo, creator name and introduction' : 'Logo, project name and introduction'}</span>
          <ChevronRight size={16} aria-hidden />
        </Link>}
        <Link className="account-card-wallet" href="/settings/profile#wallets" onClick={() => setOpen(false)}>
          <span className="account-card-label">Wallet</span>
          {account.wallet
            ? <span className="account-card-value"><span className="status-dot status-good" aria-hidden /> <span className="mono">{shortAddress(account.wallet.address)}</span>
              <span className="account-card-network">{account.wallet.network}{account.wallet.count > 1 ? ` · +${account.wallet.count - 1}` : ''}</span></span>
            : <span className="account-card-value account-card-connect">Connect wallet</span>}
          <ChevronRight size={14} aria-hidden />
        </Link>
      </section>
      <nav aria-label="Account menu">
        {groups.map((group) => <div key={group.title} className="account-menu-group">
          <h4>{group.title}</h4>
          {group.links.map((link) => <Link key={link.href} href={link.href} aria-current={active === link.href ? 'page' : undefined} onClick={() => setOpen(false)}>{link.label}</Link>)}
        </div>)}
      </nav>
      <form method="post" action="/api/auth" className="account-menu-logout">
        <input type="hidden" name="action" value="logout" />
        <button className="plain-button" type="submit">Log out</button>
      </form>
    </div>
  </div>;
}

function parentOf(pathname: string, type: AccountType | null): NavLink {
  if (/^\/orders\//.test(pathname)) return { href: '/buyer/orders', label: 'Orders' };
  if (pathname === '/creator/services/new') return { href: '/creator/services', label: 'My services' };
  if (pathname === '/buyer/requests/new') return { href: '/buyer/requests', label: 'My campaigns' };
  if (/^\/requests\/[^/]+$/.test(pathname)) return type === 'creator' ? { href: '/requests', label: 'Open campaigns' } : { href: '/buyer/requests', label: 'My campaigns' };
  if (/^\/auctions\/[^/]+$/.test(pathname)) return { href: '/auctions', label: 'Auctions' };
  if (/^\/(services|creators)\/[^/]+$/.test(pathname)) return type === 'creator' ? { href: '/creator/services', label: 'My services' } : { href: '/explore', label: 'Find creators' };
  return { href: '/dashboard', label: 'Overview' };
}

/** The overview and the marketplace lists (reached from the header) show no back link. */
const NO_BACK = new Set(['/dashboard', '/explore', '/requests', '/auctions', '/funds', '/welcome']);

/** Back link above every other workspace page; it goes to the page's parent in the workspace. */
export function WorkspaceBack({ type }: { type: AccountType | null }) {
  const pathname = usePathname();
  // Campaign tabs are marketplace sections reached from the header, like the lists above.
  if (NO_BACK.has(pathname) || pathname.startsWith('/campaigns/')) return null;
  const parent = parentOf(pathname, type);
  return <Link className="workspace-back" href={parent.href}><span aria-hidden>‹</span> Back to {parent.label}</Link>;
}
