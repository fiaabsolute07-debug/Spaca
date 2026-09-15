'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SECTIONS = [
  { href: '/explore', label: 'Explore' },
  { href: '/requests', label: 'Campaigns' },
  { href: '/auctions', label: 'Auctions' },
] as const;

/** Header links mark the marketplace section the page belongs to. */
export function HeaderNav() {
  const pathname = usePathname();
  const active = SECTIONS.find((section) => pathname === section.href || pathname.startsWith(`${section.href}/`))?.href;
  return <nav aria-label="Main navigation">
    {SECTIONS.map((section) => <Link key={section.href} href={section.href} className={active === section.href ? 'is-active' : undefined} aria-current={active === section.href ? 'page' : undefined}>{section.label}</Link>)}
  </nav>;
}
