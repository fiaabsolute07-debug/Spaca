import Link from 'next/link';
import type { Actor } from '@/lib/auth';
import { accountTypeOf } from '@/lib/account';
import { str } from './ui';

/** Workspace navigation for the account's type: creators sell, buyers hire. */
export function WorkspaceSidebar({
  actor
}: {
  actor: Actor;
}) {
  const type = accountTypeOf(actor);
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
      {type && <span className="account-type">{type === 'creator' ? 'Creator account' : 'Buyer account'}</span>}
    </div>
    <h4>Workspace</h4>
    <Link className="active" href="/dashboard">Overview</Link>
    {type === 'creator' ? <>
      <Link href="/creator/services">My services</Link>
      <Link href="/buyer/orders">Orders</Link>
      <Link href="/creator/requests">My applications</Link>
      <h4>Find work</h4>
      <Link href="/requests">Open campaigns</Link>
      <Link href="/creator/services/new">New service</Link>
      <Link href="/creator/auctions/new">New auction</Link>
    </> : <>
      <Link href="/buyer/orders">Orders</Link>
      <Link href="/buyer/requests">My campaigns</Link>
      <h4>Hire</h4>
      <Link href="/explore">Find creators</Link>
      <Link href="/buyer/requests/new">Post a brief</Link>
      <Link href="/auctions">Auctions</Link>
    </>}
    <h4>Account</h4>
    <Link href="/settings/profile">Profile</Link>
  </aside>;
}
