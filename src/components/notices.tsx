import Link from 'next/link';
import type { Query } from './page-props';
import { verifiedNotice } from '@/lib/notices';

/** Shows the flash notice from a server redirect; unsigned `?message=`/`?error=` links show nothing. */
export function Notices({
  query
}: {
  query: Query;
}) {
  const error = verifiedNotice(query, 'error');
  const message = verifiedNotice(query, 'message');
  return <>
    {error && <div role="alert" className="notice error">
      {error}
      {" "}
      <Link href="/support">Get help ›</Link>
    </div>}
    {message && <div role="status" className="notice success">
      {message}
    </div>}
  </>;
}
