import Link from 'next/link';
import type { Actor } from '@/lib/auth';
import { str } from './ui';

export function WorkspaceSidebar({
  actor
}: {
  actor: Actor;
}) {
  return <aside className="sidebar">
    <div className="sidebar-profile">
      <div className="avatar">
        {str(actor.display_name, 'C')[0]}
      </div>
      <strong>
        {actor.display_name}
      </strong>
      <span className="muted">
        {actor.email}
      </span>
    </div>
    <h4>Workspace</h4>
    <Link className="active" href="/dashboard">Overview</Link>
    <Link href="/creator/services">My services</Link>
    <Link href="/buyer/orders">Orders</Link>
    <Link href="/buyer/requests">Open briefs</Link>
    <h4>Create</h4>
    <Link href="/creator/services/new">New service</Link>
    <Link href="/buyer/requests/new">Post a brief</Link>
    <Link href="/creator/auctions/new">New auction</Link>
    <h4>Account</h4>
    <Link href="/settings/profile">Profile</Link>
  </aside>;
}
