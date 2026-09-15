import Link from 'next/link';
import { getDashboardData } from '@/lib/read-model';
import { Badge, CommandForm, Empty, Field, availabilityLabel, money, num, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import { FileUploadField } from '@/components/files/file-upload-field';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

export default async function CreatorServicesPage({
  searchParams
}: PageProps) {
  const query = await searchParams;
  const route = "/creator/services";
  const {
    actor,
    prompt
  } = await requireActorOrLoginPrompt(route, query, 'creator');
  if (!actor) return prompt;
  const notices = <Notices query={query} />;
  const d = row(await getDashboardData(actor));
  const workload = row(d.workload);
  const status = availabilityLabel(workload.availability_status);
  const inFlight = num(workload.in_flight_units);
  return <main className="container">
    {notices}
    <div className="section-heading">
      <PageHeading
        eyebrow="Creator workspace"
        title="My services"
        description="Publish only services with complete scope and samples."
      />
      <Link className="button button-dark" href="/creator/services/new">New service</Link>
    </div>
    <section className="panel" aria-labelledby="new-orders-heading">
      <div className="inline-actions">
        <h2 id="new-orders-heading">New orders</h2>
        <span className={status.className}>{status.label}</span>
      </div>
      <p className="muted">
        {inFlight} {inFlight === 1 ? 'order' : 'orders'} in progress. Pause to stop new orders, hires and auctions; work in progress continues.
      </p>
      <div className="order-limit-actions">
        {workload.accepting_orders === false
          ? <CommandForm command="set_accepting_orders" label="Resume new orders" values={{ accepting: 'true' }} returnTo={route} />
          : <CommandForm command="set_accepting_orders" label="Pause new orders" variant="secondary" values={{ accepting: 'false' }} returnTo={route} />}
      </div>
    </section>
    {rows(d.services).length ? <div className="cards">
      {rows(d.services).map(s => <div className="panel" key={str(s.id)}>
        <div className="inline-actions">
          <Badge>
            {str(s.status)}
          </Badge>
        </div>
        <h3>
          {str(s.title)}
        </h3>
        <p>
          {str(s.description)}
        </p>
        <div className="service-bottom">
          <strong>
            {money(s.price_minor)}
          </strong>
          <span>
            {num(s.turnaround_hours)}
            {" hours · "}
            {str(s.taxonomy)}
          </span>
        </div>
        {str(s.taxonomy) === 'DIGITAL' && <div className="digital-releases">
          <p className="muted">
            {s.digital_license === 'EXCLUSIVE' ? 'Exclusive license' : 'Non-exclusive license'}
            {s.digital_stock ? ` · ${num(s.digital_stock)} ${num(s.digital_stock) === 1 ? 'copy' : 'copies'}` : ' · unlimited copies'}
            {` · ${num(row(s.licenses).active)} sold, ${num(row(s.licenses).held)} in checkout`}
          </p>
          {rows(s.releases).length
            ? <ul className="release-list">{rows(s.releases).map((release) => <li key={str(release.version)}>Version {num(release.version)} · {str(release.filename)}</li>)}</ul>
            : <p className="notice">Upload the product file before publishing.</p>}
          {str(s.status) !== 'ARCHIVED' && <CommandForm command="add_digital_release" label={rows(s.releases).length ? 'Add new version' : 'Add product file'} variant="secondary" values={{ service_id: str(s.id) }} returnTo={route}>
            <FileUploadField purpose="DIGITAL" label="Product file" maxFiles={1} help="One file per version: zip up to 100 MB, PDF/DOCX 25 MB, images 10 MB, video 250 MB. Private until purchased." />
            <Field name="notes" label="What changed (optional)" />
          </CommandForm>}
        </div>}
        {str(s.status) !== 'ARCHIVED' && <details className="service-edit">
          <summary>Edit service</summary>
          <CommandForm command="update_service" label="Save changes" values={{ service_id: str(s.id), expected_version: str(s.version) }} returnTo={route}>
            <p className="muted">{str(s.status) === 'DRAFT' ? 'Changes stay in the draft until you publish.' : 'Saving creates a new version of the terms. New checkouts use it; existing orders keep the version they bought.'}</p>
            <Field name="title" label="Service title" value={str(s.title)} required />
            <Field name="description" label="Scope and deliverables" type="textarea" value={str(s.description)} required />
            <Field name="price" label="Price (USD)" type="number" value={(num(s.price_minor) / 100).toFixed(2)} required />
            <Field name="turnaround_hours" label="Delivery time (hours)" type="number" value={String(num(s.turnaround_hours))} required />
          </CommandForm>
        </details>}
        <div className="inline-actions">
          <Link className="text-link" href={`/services/${str(s.id)}`}>Open public page ›</Link>
          {['DRAFT', 'PAUSED'].includes(str(s.status)) && <CommandForm
            command="publish_service"
            label={str(s.status) === 'PAUSED' ? 'Resume selling' : 'Publish'}
            values={{
              service_id: str(s.id)
            }}
            returnTo={route}
          />}
          {" "}
          {str(s.status) === 'PUBLISHED' && <CommandForm
            command="pause_service"
            label="Pause"
            values={{
              service_id: str(s.id)
            }}
            returnTo={route}
          />}
        </div>
      </div>)}
    </div> : <Empty title="No services yet">
      <Link href="/creator/services/new" className="text-link">Create your first service ›</Link>
    </Empty>}
  </main>;
}
