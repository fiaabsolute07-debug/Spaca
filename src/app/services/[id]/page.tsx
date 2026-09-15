import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { getServiceData } from '@/lib/read-model';
import { Badge, CommandForm, Empty, Field, availabilityLabel, money, num, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { ReportForm } from '@/components/report-form';
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
  const availability = availabilityLabel(s.availability_status);
  const isAccess = str(s.taxonomy) === 'ACCESS';
  const isDigital = str(s.taxonomy) === 'DIGITAL';
  const digital = d.digital ? row(d.digital) : null;
  const salesOpen = !isDigital || (digital?.purchases_enabled === true && digital?.latest_version != null);
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
            {" ›"}
          </Link>
        </div>
        <div className="panel">
          <h2>The work, clearly defined.</h2>
          <p className="prewrap">
            {str(s.description)}
          </p>
          <h3>Usage & publishing</h3>
          {str(s.taxonomy) === 'PUBLISH' ? <>
            <p>
              The creator publishes one {str(s.publish_format).replaceAll('_', ' ').toLowerCase()} on{' '}
              <a className="text-link" href={str(s.publish_url)} target="_blank" rel="noreferrer">{s.publish_handle ? `@${str(s.publish_handle)}` : str(s.publish_url)}</a>{' '}
              ({str(s.publish_platform)}, self-reported), labelled “{str(s.disclosure_text)}”, and keeps it live for at least {num(s.min_live_hours)} hours.
            </p>
            <p className="muted">You share key points in the brief; the creator writes the post in their own voice. The order is delivered with the post link and the time it went live.</p>
          </> : isAccess ? <>
            <p>
              A {num(s.access_session_minutes)}-minute live session with the creator. After you pay, agree the time and meeting link together in the order messages.
            </p>
          </> : isDigital ? <>
            <p>
              {s.digital_license === 'EXCLUSIVE'
                ? 'An exclusive license: only one buyer can hold it at a time. The files unlock as soon as payment is confirmed.'
                : 'A non-exclusive license to ready-made files. The files unlock as soon as payment is confirmed.'}
            </p>
            <h3>License</h3>
            <p className="prewrap">{str(s.digital_rights_text)}</p>
            <p className="muted">
              {str(s.digital_updates) === 'LATEST' ? 'You get every new version the creator releases.' : 'You get the version current at purchase.'}
              {` Up to ${num(s.digital_download_limit)} downloads. You can cancel for a full refund until you first download the files.`}
            </p>
          </> : <p>
            Content is delivered for the buyer to use. Posting to the creator’s channel is not included unless explicitly agreed in the scope.
          </p>}
        </div>
        <div className="panel">
          <h2>A look at their work</h2>
          {rows(d.samples).length ? rows(d.samples).map(sample => <div className="record" key={str(sample.id ?? sample.url)}>
            <a href={str(sample.url)} target="_blank" rel="noreferrer" className="text-link">
              {str(sample.title, 'View sample')}
              {" ›"}
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
            {isDigital ? <>
              <li><span>License</span><strong>{s.digital_license === 'EXCLUSIVE' ? 'Exclusive' : 'Non-exclusive'}</strong></li>
              <li><span>Current version</span><strong>{digital?.latest_version != null ? `v${num(digital.latest_version)}` : '—'}</strong></li>
            </> : isAccess ? <>
              <li><span>Session length</span><strong>{num(s.access_session_minutes)} minutes</strong></li>
            </> : <>
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
            </>}
            <li>
              <span>Status</span>
              <strong className={availability.className}>
                {availability.label}
              </strong>
            </li>
            <li>
              <span>Platform fee</span>
              <strong>$0.00</strong>
            </li>
          </ul>
          {actor ? !salesOpen ? <Empty title="Purchases are paused">This product cannot be bought right now.</Empty> : availability.accepting ? <CommandForm
            command="book"
            label={isAccess ? 'Reserve a session' : isDigital ? 'Buy license' : 'Reserve this service'}
            values={{
              service_id: str(s.id),
              service_version_id: str(s.service_version_id)
            }}
          >
            {isDigital ? <label className="field">
              <span>
                <input type="checkbox" name="accept_license" required /> I accept the license above for version {digital?.latest_version != null ? num(digital.latest_version) : ''} of these files.
              </span>
            </label> : <Field
              name="brief"
              label={isAccess ? 'What do you want to cover, and when are you free?' : 'Tell the creator about your project'}
              type="textarea"
              required
              placeholder="Your product, audience, goals, links, and requirements (at least 20 characters)."
            />}
            {str(s.taxonomy) === 'PUBLISH' && <label className="field">
              <span>
                <input type="checkbox" name="accept_publish_terms" required /> The post is labelled “{str(s.disclosure_text)}” and written by the creator in their own words. My brief does not ask to hide the sponsorship or promise returns.
              </span>
            </label>}
            <label className="field">
              <span>
                <input type="checkbox" name="accept_terms" /> I agree that version {str(s.service_version)} of these terms applies, and that a
                valid delivery is approved automatically if I take no action within {num(s.review_window_hours) || 72} hours of opening it.
              </span>
            </label>
          </CommandForm> : (
            <Empty title={availability.label}>
              {str(s.availability_status) === 'SOLD_OUT' ? (s.digital_license === 'EXCLUSIVE' ? 'The exclusive license is already sold or reserved.' : 'All copies are sold.') : 'This creator paused new orders.'}
              {' '}<Link className="text-link" href="/buyer/requests/new">Post a request ›</Link>
            </Empty>
          ) : (
            <Link
              className="button button-dark"
              href={`/sign-in?return_to=${encodeURIComponent(route)}`}
            >
              Log in to book
            </Link>
          )}
          <div className="fee-note">
            Local sandbox: checkout uses simulated funds. Your reservation is time limited.
            Delivery begins after funding and a complete brief.
          </div>
          {actor && actor.id !== str(s.creator_id) && <ReportForm targetType="SERVICE" targetId={str(s.id)} returnTo={`/services/${str(s.id)}`} label="Report this service" />}
        </div>
      </aside>
    </div>
  </main>;
}
