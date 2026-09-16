'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AccountType } from '@/lib/account';
import { CATEGORIES } from './category';
import { MenuIcon, type MenuIconName } from './menu-icon';
import { CAMPAIGN_GOALS } from '@/modules/requests/goals';

type MenuItem = { href: string; title: string; description: string; icon: ReactNode };
type Menu = {
  key: 'explore' | 'campaigns';
  label: string;
  /** URL prefixes that belong to this section, for marking where the reader is. */
  section: string[];
  featured: { href: string; title: string; description: string };
  items: MenuItem[];
  all: { href: string; label: string };
};

const EXPLORE_LINES: Record<string, string> = {
  CREATE: 'Threads, videos and articles delivered to you',
  PUBLISH: "Posts on the creator's own channel",
  ACCESS: 'Live calls, AMAs and consultations',
  DIGITAL: 'Templates and files you license',
};

function menusFor(type: AccountType | null): Menu[] {
  const creator = type === 'creator';
  return [
    {
      key: 'explore',
      label: 'Explore',
      section: ['/explore', '/services', '/creators'],
      featured: { href: '/explore', title: 'Explore creators', description: 'Every service, one search, with prices and samples up front.' },
      items: CATEGORIES.map((category) => ({
        href: `/explore?category=${category.value}`, title: category.title, description: EXPLORE_LINES[category.value] ?? category.need,
        icon: <MenuIcon name={category.key} />,
      })),
      all: { href: '/explore', label: 'All services' },
    },
    {
      key: 'campaigns',
      label: 'Campaigns',
      section: ['/requests', '/campaigns'],
      featured: creator
        ? { href: '/requests', title: 'Find campaigns', description: 'Open briefs taking applications. Quote your own price.' }
        : { href: '/buyer/requests/new', title: 'Post a brief', description: 'Describe the campaign once and compare quotes from creators.' },
      items: CAMPAIGN_GOALS.map((goal) => ({
        href: `/campaigns/${goal.slug}`, title: goal.title, description: goal.short, icon: <MenuIcon name={goal.slug as MenuIconName} />,
      })),
      all: { href: '/requests', label: 'All campaigns' },
    },
  ];
}

const inSection = (pathname: string, prefixes: string[]) => prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
/** A pointer that hovers (a mouse or trackpad) opens menus on hover, like the rest of the web; touch opens them on tap. */
const HOVER_CLOSE_MS = 160;

/**
 * Header navigation: Explore and Campaigns open a panel with a featured action on the left and the ways in on the right;
 * Auctions stays a plain link. A panel opens on hover or click, and closes on Escape, a click outside, leaving it with
 * the pointer, or following one of its links. The section the page belongs to is marked on its trigger.
 */
export function HeaderNav({ type = null }: { type?: AccountType | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState<Menu['key'] | null>(null);
  const root = useRef<HTMLElement>(null);
  const triggers = useRef<Partial<Record<Menu['key'], HTMLButtonElement | null>>>({});
  const closeTimer = useRef<number | undefined>(undefined);
  const baseId = useId();
  const menus = menusFor(type);

  useEffect(() => setOpen(null), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      triggers.current[open]?.focus();
      setOpen(null);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const hoverOpen = (key: Menu['key'], pointerType: string) => {
    if (pointerType !== 'mouse') return;
    window.clearTimeout(closeTimer.current);
    setOpen(key);
  };
  const hoverClose = (pointerType: string) => {
    if (pointerType !== 'mouse') return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(null), HOVER_CLOSE_MS);
  };
  // With a mouse the menu is already open from the hover, so a click keeps it open rather than shutting it again; a tap
  // or a keyboard press toggles it.
  const trigger = (key: Menu['key'], pointerType: string) => {
    window.clearTimeout(closeTimer.current);
    if (pointerType === 'mouse') setOpen(key);
    else setOpen((current) => (current === key ? null : key));
  };
  const activeSection = menus.find((menu) => inSection(pathname, menu.section))?.key ?? null;
  const auctionsActive = inSection(pathname, ['/auctions']);

  return <nav aria-label="Main navigation" ref={root}>
    {menus.map((menu) => {
      const panelId = `${baseId}-${menu.key}`;
      const expanded = open === menu.key;
      const active = activeSection === menu.key;
      return <div key={menu.key} className="nav-menu" onPointerEnter={(event) => hoverOpen(menu.key, event.pointerType)} onPointerLeave={(event) => hoverClose(event.pointerType)}>
        <button ref={(element) => { triggers.current[menu.key] = element; }} type="button" className={`nav-trigger${active ? ' is-active' : ''}`}
          aria-expanded={expanded} aria-controls={panelId} aria-current={active ? 'page' : undefined} onClick={(event) => trigger(menu.key, (event.nativeEvent as PointerEvent).pointerType ?? '')}>
          {menu.label} <ChevronDown size={14} aria-hidden />
        </button>
        <div id={panelId} className="nav-panel" hidden={!expanded} role="group" aria-label={`${menu.label} menu`}>
          <Link className="nav-featured" href={menu.featured.href} onClick={() => setOpen(null)}>
            <strong>{menu.featured.title}</strong>
            <span>{menu.featured.description}</span>
            <ArrowRight className="nav-featured-go" size={18} aria-hidden />
          </Link>
          <div className="nav-items">
            {menu.items.map((item) => <Link key={item.href} className="nav-item" href={item.href} onClick={() => setOpen(null)}>
              <span className="nav-item-icon">{item.icon}</span>
              <span className="nav-item-text"><strong>{item.title}</strong><small>{item.description}</small></span>
            </Link>)}
            <Link className="nav-all" href={menu.all.href} onClick={() => setOpen(null)}>{menu.all.label} ›</Link>
          </div>
        </div>
      </div>;
    })}
    <Link href="/auctions" className={`nav-link${auctionsActive ? ' is-active' : ''}`} aria-current={auctionsActive ? 'page' : undefined}>Auctions</Link>
  </nav>;
}
