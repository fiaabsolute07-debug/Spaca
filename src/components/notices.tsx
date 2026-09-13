import Link from 'next/link';
import type { Query } from './page-props';

export function Notices({
  query
}: {
  query: Query;
}) {
  return <>
    {query.error && <div role="alert" className="notice error">
      {String(query.error)}
      {" "}
      <Link href="/support">Get help →</Link>
    </div>}
    {query.message && <div role="status" className="notice success">
      {String(query.message)}
    </div>}
  </>;
}
