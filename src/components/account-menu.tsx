'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Briefcase, ChevronDown, ChevronRight, ClipboardList, LayoutDashboard, LogOut, Megaphone, Send, UserRound, Wallet, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { AccountType } from '@/lib/account';
import type { AccountSummary } from '@/lib/read-model';
import { Avatar } from './avatar';

type NavLink = { href: string; label: string };
type MenuLink = NavLink & { icon: LucideIcon };

/**
 * Only the places an account returns to. Everything the header already offers — Explore, Campaigns (Post a brief,
 * Open campaigns), Auctions and the Fund button — stays out of this menu, and new-item pages are reached from their
 * list pages (2026-09-17, modelled on Binance's account menu).
 */
const CREATOR_LINKS: MenuLink[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/creator/services', label: 'My services', icon: Briefcase },
  { href: '/buyer/orders', label: 'Orders', icon: ClipboardList },
  { href: '/creator/requests', label: 'My applications', icon: Send },
];
const BUYER_LINKS: MenuLink[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/buyer/orders', label: 'Orders', icon: ClipboardList },
  { href: '/buyer/requests', label: 'My campaigns', icon: Megaphone },
];
const PROFILE_LINK: MenuLink = { href: '/settings/profile', label: 'Profile', icon: UserRound };

/** 0x12ab…9f3c: enough to recognise an address without reading all of it. */
const shortAddress = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

/** Pages that belong to a menu entry without being under its URL. */
const ALIASES: [RegExp, string][] = [[/^\/orders\//, '/buyer/orders']];

const within = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

function activeHref(pathname: string, links: MenuLink[]): string | null {
  const alias = ALIASES.find(([pattern]) => pattern.test(pathname));
  if (alias) return alias[1];
  // The most specific entry wins.
  return links.filter((link) => within(pathname, link.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

/**
 * Workspace navigation for signed-in accounts, in the header's top-right corner. A disclosure: the button toggles the
 * panel; Escape, a click outside or navigating closes it. The panel opens on who is signed in — photo, name, and a
 * Buyer / Creator label with the handle — then one short list with icons (the account's own pages, Wallet with its
 * state, Profile) and Log out. No group headings: the list is short enough to read at a glance.
 */
export function AccountMenu({ type, account }: { type: AccountType | null; account: AccountSummary }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const links = type === 'creator' ? CREATOR_LINKS : BUYER_LINKS;
  const active = activeHref(pathname, [...links, PROFILE_LINK]);
  const close = () => setOpen(false);

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

  const item = (link: MenuLink) => <Link key={link.href} className="account-item" href={link.href} aria-current={active === link.href ? 'page' : undefined} onClick={close}>
    <link.icon size={16} aria-hidden />
    <span>{link.label}</span>
  </Link>;

  return <div className="account-menu" ref={root}>
    <button ref={button} type="button" className="button compact account-menu-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <span className="account-menu-face">
        <Avatar name={account.name} assetId={account.avatarAssetId} size={22} />
        {!account.onboarded && <span className="account-menu-dot" aria-hidden />}
      </span>
      Account <ChevronDown size={14} aria-hidden />
    </button>
    <div id={panelId} className="account-menu-panel" hidden={!open}>
      <section className="account-head" aria-label="Signed in as">
        <Avatar name={account.name} assetId={account.avatarAssetId} size={40} />
        <div className="account-head-text">
          <strong>{account.name}</strong>
          <span>
            <span className="account-head-type">{type === 'creator' ? 'Creator' : type === 'buyer' ? 'Buyer' : 'Operator'}</span>
            {account.handle && account.onboarded ? <span className="account-head-handle"> · @{account.handle}</span> : null}
          </span>
        </div>
      </section>
      {!account.onboarded && <Link className="account-setup" href="/welcome" onClick={close}>
        <span className="account-setup-dot" aria-hidden />
        <span>Finish setup</span>
        <ChevronRight size={15} aria-hidden />
      </Link>}
      <nav aria-label="Account menu">
        {links.map(item)}
        <hr />
        <Link className="account-item" href="/settings/profile#wallets" onClick={close}>
          <Wallet size={16} aria-hidden />
          <span>Wallet</span>
          <span className={`account-item-meta${account.wallet ? ' mono' : ' is-action'}`}>{account.wallet ? shortAddress(account.wallet.address) : 'Connect'}</span>
        </Link>
        {item(PROFILE_LINK)}
      </nav>
      <form method="post" action="/api/auth" className="account-menu-logout">
        <input type="hidden" name="action" value="logout" />
        <button className="account-item" type="submit"><LogOut size={16} aria-hidden /><span>Log out</span></button>
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
