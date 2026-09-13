import Link from 'next/link';
import type { Actor } from '@/lib/auth';

const links = [
  { href: '/admin', label: 'Overview', roles: [] },
  { href: '/admin/disputes', label: 'Disputes', roles: [] },
  { href: '/admin/cases', label: 'Cases', roles: ['finance', 'support', 'admin'] },
  { href: '/admin/operations', label: 'Operations', roles: ['finance', 'support', 'admin'] },
  { href: '/admin/moderation', label: 'Moderation', roles: ['moderator', 'admin'] },
  { href: '/admin/users', label: 'Users', roles: ['moderator', 'admin'] },
  { href: '/admin/flags', label: 'Feature flags', roles: [] },
  { href: '/admin/audit', label: 'Audit log', roles: ['finance', 'admin'] },
];

export function AdminNav({ actor, route }: { actor: Actor; route: string }) {
  return <nav className="admin-nav" aria-label="Operator navigation">
    {links.filter(link => !link.roles.length || link.roles.some(role => actor.roles.includes(role)))
      .map(link => <Link
        key={link.href}
        href={link.href}
        aria-current={route === link.href ? 'page' : undefined}
      >
        {link.label}
      </Link>)}
  </nav>;
}
