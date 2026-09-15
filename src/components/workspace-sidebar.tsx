'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { AccountType } from '@/lib/account';

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

const ACCOUNT_NAV: NavGroup = { title: 'Account', links: [{ href: '/settings/profile', label: 'Profile' }] };

/** Pages that belong to a sidebar entry without being under its URL. */
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
 * Workspace navigation (no identity block; the profile opens from Account › Profile), rendered once by the root layout for signed-in accounts. It stays mounted while the pages beside
 * it change, so moving around the workspace happens in one frame.
 */
export function WorkspaceSidebar({ type }: { type: AccountType | null }) {
  const pathname = usePathname();
  const groups = [...(type === 'creator' ? CREATOR_NAV : BUYER_NAV), ACCOUNT_NAV];
  const active = activeHref(pathname, groups);
  return <aside className="sidebar" aria-label="Workspace">
    <nav aria-label="Workspace sections">
      {groups.map((group) => <div key={group.title}>
        <h4>{group.title}</h4>
        {group.links.map((link) => <Link key={link.href} href={link.href} className={active === link.href ? 'active' : undefined} aria-current={active === link.href ? 'page' : undefined}>{link.label}</Link>)}
      </div>)}
    </nav>
  </aside>;
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
const NO_BACK = new Set(['/dashboard', '/explore', '/requests', '/auctions']);

/** Back link above every other workspace page; it goes to the page's parent in the workspace. */
export function WorkspaceBack({ type }: { type: AccountType | null }) {
  const pathname = usePathname();
  if (NO_BACK.has(pathname)) return null;
  const parent = parentOf(pathname, type);
  return <Link className="workspace-back" href={parent.href}><span aria-hidden>‹</span> Back to {parent.label}</Link>;
}
