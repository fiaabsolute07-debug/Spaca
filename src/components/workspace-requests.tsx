import Link from 'next/link';
import { getDashboardData } from '@/lib/read-model';
import { Badge, Empty, date, money, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { CampaignBoard } from '@/components/campaign/campaign-board';
import type { Query } from '@/components/page-props';
import type { Actor } from '@/lib/auth';
import type { AccountType } from '@/lib/account';

const OFFER_LABEL: Record<string, string> = {
  OFFERED: 'Offer waiting for you',
  ACCEPTED: 'Hired',
  DECLINED: 'Offer declined',
  EXPIRED: 'Offer expired',
  WITHDRAWN: 'Offer withdrawn',
  LAPSED: 'Hire lapsed',
};

/** Buyers see the briefs they posted; creators see the applications they sent. */
export async function WorkspaceRequests({
  actor,
  query,
  view
}: {
  actor: Actor;
  query: Query;
  view: AccountType;
}) {
  const notices = <Notices query={query} />;
  const d = row(await getDashboardData(actor));
  if (view === 'creator') {
    const applications = rows(d.applications);
    return <main className="container">
      {notices}
      <div className="section-heading">
        <PageHeading
          eyebrow="Campaigns"
          title="My applications"
          description="Quotes you sent to project briefs, and any offer that came back."
        />
        <Link className="button button-dark" href="/requests">Find campaigns</Link>
      </div>
      {applications.length ? <div className="cards">
        {applications.map((a) => {
          const offer = str(a.offer_status);
          return <Link key={str(a.id)} className="panel" href={offer === 'ACCEPTED' && a.offer_order_id ? `/orders/${str(a.offer_order_id)}` : `/requests/${str(a.request_id)}`}>
            <div className="inline-actions">
              <Badge>{str(a.status).toLowerCase()}</Badge>
              {offer && <Badge>{OFFER_LABEL[offer] ?? offer.toLowerCase()}</Badge>}
            </div>
            <h3>{str(a.request_title)}</h3>
            <div className="service-bottom">
              <strong>{money(a.quote_minor)} quote</strong>
              <span>{offer === 'OFFERED' ? `Answer by ${date(a.offer_expires_at)}` : `Valid until ${date(a.valid_until)}`}</span>
            </div>
          </Link>;
        })}
      </div> : <Empty title="No applications yet">
        <Link href="/requests" className="text-link">Browse open campaigns ›</Link>
      </Empty>}
    </main>;
  }
  return <main className="container">
    {notices}
    <div className="section-heading">
      <PageHeading
        eyebrow="Campaigns"
        title="My campaigns"
        description="Briefs you posted. Applications stay visible only to you and the creator who sent them."
      />
      <Link className="button button-dark" href="/buyer/requests/new">Post a brief</Link>
    </div>
    {rows(d.requests).length ? <CampaignBoard items={d.requests} label="My campaigns" /> : <Empty title="No briefs yet">
      <Link href="/buyer/requests/new" className="text-link">Share a project brief ›</Link>
    </Empty>}
  </main>;
}
