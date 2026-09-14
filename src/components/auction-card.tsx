import Link from 'next/link';
import { Badge, date, money, num, row, str } from './ui';

export function AuctionCard({
  item
}: {
  item: unknown;
}) {
  const a = row(item);
  return <Link className="panel" href={`/auctions/${str(a.id)}`}>
    <Badge>
      {str(a.status)}
    </Badge>
    <h3>
      {str(a.title)}
    </h3>
    <p>
      {"By "}
      {str(a.creator_name)}
      {" · Ends "}
      {date(a.ends_at)}
    </p>
    <div className="service-bottom">
      <strong>
        {money(a.current_price_minor || a.starting_price_minor)}
      </strong>
      <span>
        {num(a.bid_count)}
        {" bids · View auction ›"}
      </span>
    </div>
  </Link>;
}
