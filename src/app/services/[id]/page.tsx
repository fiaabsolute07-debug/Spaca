import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { getServiceData } from '@/lib/read-model';
import { Badge, CommandForm, Empty, Field, availabilityLabel, money, num, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { ReportForm } from '@/components/report-form';
import { SlotPicker } from '@/components/access/slot-picker';
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
  const access = d.access ? row(d.access) : null;
  const sessionsOpen = !isAccess || access?.booking_enabled === true;
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
              A {num(s.access_session_minutes)}-minute live session at a time you pick. The creator adds a private meeting link after payment.
            </p>
            <p className="muted">
              Cancel for a full refund up to {num(s.access_cancel_notice_hours)} hours before the start; after that the creator must agree.
              If either side does not join within {num(s.access_no_show_minutes)} minutes, it can be recorded as a no-show and reviewed.
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
            {isAccess ? <>
              <li><span>Session length</span><strong>{num(s.access_session_minutes)} minutes</strong></li>
              <li><span>Free cancellation</span><strong>Up to {num(s.access_cancel_notice_hours)} hours before</strong></li>
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
          {actor ? !sessionsOpen ? <Empty title="Session booking is paused">New sessions cannot be booked right now.</Empty> : availability.accepting ? <CommandForm
            command="book"
            label={isAccess ? 'Reserve this time' : 'Reserve this service'}
            values={{
              service_id: str(s.id),
              service_version_id: str(s.service_version_id)
            }}
          >
            {isAccess && <SlotPicker serviceId={str(s.id)} sessionMinutes={num(s.access_session_minutes)} creatorTimeZone={access?.time_zone ? str(access.time_zone) : null} />}
            <Field
              name="brief"
              label={isAccess ? 'What do you want to cover?' : 'Tell the creator about your project'}
              type="textarea"
              required
              placeholder="Your product, audience, goals, links, and requirements (at least 20 characters)."
            />
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
              {str(s.availability_status) === 'PAUSED' ? 'This creator paused new orders.' : 'This creator is working on as many orders as they take at once.'}
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
