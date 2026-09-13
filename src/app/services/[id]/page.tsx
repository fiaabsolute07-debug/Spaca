import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { getServiceData } from '@/lib/read-model';
import { Badge, CommandForm, Empty, Field, money, num, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function ServicePage({
  params,
  searchParams
}: PageProps<{
  id: string;
}>) {
  const query = await searchParams;
  const {
    id
  } = await params;
  const route = `/services/${id}`;
  const actor = await getActor();
  const notices = <Notices query={query} />;
  const result = await getServiceData(id);
  if (!result) notFound();
  const d = row(result),
    s = row(d.service),
    c = row(d.creator);
  return <main className="container">
    {notices}
    <div className="breadcrumbs">
      <Link href="/explore">Explore</Link>
      {" / "}
      {str(s.taxonomy)}
      {" / "}
      {str(s.title)}
    </div>
    <div className="split">
      <div>
        <div className="detail-hero">
          <Badge>
            {str(s.taxonomy)}
          </Badge>
          <h1>
            {str(s.title)}
          </h1>
          <Link className="creator-line" href={`/creators/${str(c.handle)}`}>
            <span className="avatar small">
              {str(c.display_name, 'C')[0]}
            </span>
            {"By "}
            {str(c.display_name ?? s.creator_name)}
            {" ↗"}
          </Link>
        </div>
        <div className="panel">
          <h2>The work, clearly defined.</h2>
          <p className="prewrap">
            {str(s.description)}
          </p>
          <h3>Usage & publishing</h3>
          <p>
            {str(s.taxonomy) === 'PUBLISH'
              ? 'This service involves publishing on the creator’s channel. ' +
                'Confirm channel, disclosure, and posting scope in the brief.'
              : str(s.taxonomy) === 'ACCESS'
                ? 'You are booking access to the creator’s expertise. ' +
                  'Agree on the meeting schedule in the brief.'
                : 'Content is delivered for the buyer to use. Posting to the creator’s channel ' +
                  'is not included unless explicitly agreed in the scope.'}
          </p>
        </div>
        <div className="panel">
          <h2>A look at their work</h2>
          {rows(d.samples).length ? rows(d.samples).map(sample => <div className="record" key={str(sample.id ?? sample.url)}>
            <a href={str(sample.url)} target="_blank" rel="noreferrer" className="text-link">
              {str(sample.title, 'View sample')}
              {" ↗"}
            </a>
            <p>
              {str(sample.description)}
            </p>
          </div>) : <p>No linked work samples.</p>}
        </div>
      </div>
      <aside>
        <div className="panel">
          <div className="eyebrow">One clear price</div>
          <div className="price-big">
            {money(s.price_minor)}
          </div>
          <ul className="facts">
            <li>
              <span>Delivery from complete brief</span>
              <strong>
                {num(s.turnaround_hours)}
                {" hours"}
              </strong>
            </li>
            <li>
              <span>Included revisions</span>
              <strong>
                {num(s.revision_limit)}
              </strong>
            </li>
            <li>
              <span>Available capacity</span>
              <strong>
                {num(s.available_units)}
                {" / "}
                {num(s.total_units)}
              </strong>
            </li>
            <li>
              <span>Platform fee</span>
              <strong>$0.00</strong>
            </li>
          </ul>
          {actor ? num(s.available_units) > 0 ? <CommandForm
            command="book"
            label="Reserve this service"
            values={{
              service_id: str(s.id),
              service_version_id: str(s.service_version_id)
            }}
          >
            <Field
              name="brief"
              label="Tell the creator about your project"
              type="textarea"
              required
              placeholder="Your product, audience, goals, links, and requirements (at least 20 characters)."
            />
            <label className="field">
              <span>
                <input type="checkbox" name="accept_terms" /> I agree that version {str(s.service_version)} of these terms applies, and that a
                valid delivery is approved automatically if I take no action within {num(s.review_window_hours) || 72} hours of opening it.
              </span>
            </label>
          </CommandForm> : (
            <Empty title="Fully booked">Check another creator or post an open brief.</Empty>
          ) : (
            <Link
              className="button button-dark"
              href={`/sign-in?return_to=${encodeURIComponent(route)}`}
            >
              Log in to book ↗
            </Link>
          )}
          <div className="fee-note">
            Local sandbox: checkout uses simulated funds. Your reservation is time limited.
            Delivery begins after funding and a complete brief.
          </div>
        </div>
      </aside>
    </div>
  </main>;
}
