import Link from 'next/link';
import { getDashboardData } from '@/lib/read-model';
import { Badge, CommandForm, Empty, Field, availabilityLabel, humanize, money, num, row, rows, str } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { requireActorOrLoginPrompt } from '@/components/require-actor';
import { FileUploadField } from '@/components/files/file-upload-field';
import { SelectField } from '@/components/select';
import { SampleGallery } from '@/components/samples/sample-gallery';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

/**
 * Work the creator still owes someone, counted by whose move it is rather than by the status word: the states they
 * must act on first, the ones they are only waiting on last. Finished orders are not work and are not counted.
 */
const WORK_STAGES = [
  { key: 'yours', title: 'Your move', hint: 'Start the work, or send the revision that was asked for.', statuses: ['FUNDED', 'REVISION_REQUESTED'] },
  { key: 'doing', title: 'In progress', hint: 'Deliver before the deadline you agreed at checkout.', statuses: ['IN_PROGRESS'] },
  { key: 'waiting', title: 'Waiting on the buyer', hint: 'Nothing to do here until they pay or review.', statuses: ['AWAITING_PAYMENT', 'DELIVERED'] },
  { key: 'held', title: 'On hold', hint: 'Payout pauses while a person reviews the dispute.', statuses: ['DISPUTED'] },
] as const;

const ACTIVE_STATUSES = new Set(WORK_STAGES.flatMap((stage) => stage.statuses as readonly string[]));
/** Statuses where the creator is the one who has to move; used for the count on a service row. */
const NEEDS_CREATOR = new Set(['FUNDED', 'REVISION_REQUESTED', 'IN_PROGRESS']);

const SERVICE_FILTERS = [
  { value: '', label: 'All' },
  { value: 'PUBLISHED', label: 'Published' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'ARCHIVED', label: 'Archived' },
] as const;

/** Archived services are history and go last. */
const STATUS_ORDER: Record<string, number> = { DRAFT: 0, PAUSED: 0, PUBLISHED: 0, ARCHIVED: 1 };
const changedAt = (service: Row) => new Date(String(service.updated_at ?? 0)).getTime() || 0;
/** Cards per page: a catalogue of hundreds rendered at once was a page 150,000 px tall. */
const PAGE_SIZE = 20;

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
  const releaseForm = (serviceId: string, label: string) => <CommandForm command="add_digital_release" label={label} variant="secondary" values={{ service_id: serviceId }} returnTo={route}>
    <FileUploadField purpose="DIGITAL" label="Product file" maxFiles={1} help="One file per version: zip up to 100 MB, PDF/DOCX 25 MB, images 10 MB, video 250 MB. Private until purchased." />
    <Field name="notes" label="What changed (optional)" />
  </CommandForm>;
  const d = row(await getDashboardData(actor));
  const workload = row(d.workload);
  const status = availabilityLabel(workload.availability_status);
  const services = rows(d.services);

  // The dashboard read carries both sides of an account's orders; here only the ones this creator has to deliver.
  const active = rows(d.orders).filter((order) => str(order.creator_id) === actor.id && ACTIVE_STATUSES.has(str(order.status)));
  const byService = new Map<string, Row[]>();
  for (const order of active) {
    const key = str(order.service_id);
    if (!key) continue;
    byService.set(key, [...(byService.get(key) ?? []), order]);
  }

  const filter = str(query.status).toUpperCase();
  const chosen = SERVICE_FILTERS.some((option) => option.value === filter) ? filter : '';
  const search = str(query.q).trim().slice(0, 80);
  const needle = search.toLowerCase();
  const counts = Object.fromEntries(SERVICE_FILTERS.map((option) =>
    [option.value, option.value ? services.filter((service) => str(service.status) === option.value).length : services.length]));
  // The service just saved, published or paused is the one the creator is looking for, so the most recently changed
  // come first (the work strip above already counts what is in flight). Ties keep the newest-created order.
  const matching = services
    .filter((service) => (!chosen || str(service.status) === chosen) && (!needle || str(service.title).toLowerCase().includes(needle)))
    .sort((a, b) => (STATUS_ORDER[str(a.status)] ?? 9) - (STATUS_ORDER[str(b.status)] ?? 9) || changedAt(b) - changedAt(a));
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const pageNumber = Math.min(pages, Math.max(1, Math.floor(Number(str(query.page)) || 1)));
  const shown = matching.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
  // Filters, search and pages are plain links and GET forms, so they work without JavaScript and can be bookmarked.
  const listHref = (status: string, page = 1) => {
    const params = new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { q: search } : {}), ...(page > 1 ? { page: String(page) } : {}) });
    return params.size ? `${route}?${params}` : route;
  };
  const chipHref = (value: string) => listHref(value);

  const stages = WORK_STAGES.map((stage) => ({ ...stage, count: active.filter((order) => (stage.statuses as readonly string[]).includes(str(order.status))).length }))
    .filter((stage) => stage.count > 0);
  const paused = workload.accepting_orders === false;

  return <main className="container my-services">
    {notices}
    <div className="section-heading">
      <PageHeading
        eyebrow="Creator workspace"
        title="My services"
        description="Everything you sell, with the orders each one has in flight."
      />
      <Link className="button button-dark" href="/creator/services/new">New service</Link>
    </div>

    {/* One strip for the work and the door: counts only, so no order title repeats a service title below. A count
        opens the overview, where Needs your action lists what is due first; every order is on Orders. */}
    <section className="panel services-strip" aria-label="Work and new orders">
      <div className="services-strip-work">
        <h2 id="work-heading">Work in progress</h2>
        {stages.length
          ? <ul className="services-stages" aria-labelledby="work-heading">
            {stages.map((stage) => <li key={stage.key}>
              <Link href="/dashboard#overview-actions" className="services-stage" data-stage={stage.key} title={stage.hint}>
                <span className="services-stage-count">{stage.count}</span>{stage.title}
              </Link>
            </li>)}
          </ul>
          : <p className="muted">Nothing in flight.</p>}
        <Link className="text-link" href="/buyer/orders">All orders ›</Link>
      </div>
      <div className="services-strip-door">
        <span className={status.className}>{status.label}</span>
        {paused
          ? <CommandForm command="set_accepting_orders" label="Resume new orders" values={{ accepting: 'true' }} returnTo={route} />
          : <CommandForm command="set_accepting_orders" label="Pause new orders" variant="secondary" values={{ accepting: 'false' }} returnTo={route} />}
      </div>
    </section>

    {services.length > 0 && <div className="services-toolbar">
      <h2 id="services-list-heading" className="visually-hidden">Services</h2>
      <nav className="chip-row" aria-label="Filter services">
        {SERVICE_FILTERS.map((option) => (counts[option.value] || !option.value) ? <Link key={option.label} className="chip-link" href={chipHref(option.value)}
          aria-current={chosen === option.value ? 'page' : undefined}>{option.label}<span className="muted">{counts[option.value]}</span></Link> : null)}
      </nav>
      <form className="service-search" role="search" method="get" action={route}>
        {chosen ? <input type="hidden" name="status" value={chosen} /> : null}
        <label htmlFor="service-search-field">Find a service</label>
        <input id="service-search-field" type="search" name="q" defaultValue={search} placeholder="Search by title" />
        <button className="button button-secondary" type="submit">Search</button>
      </form>
    </div>}

    {services.some((s) => str(s.status) !== 'ARCHIVED') && <section className="panel services-sample" aria-labelledby="add-sample-heading">
      <details>
        <summary><h2 id="add-sample-heading">Work samples</h2><span className="services-sample-mark" aria-hidden="true" /><span className="muted">Add a picture, video or link to a service</span></summary>
        <p className="muted">
          Show the work itself: an uploaded picture or video plays on the service page, where a link would only point away
          from it. A sample added here waits for moderation before buyers see it, and appears under the service you pick.
        </p>
        {/* One upload field for the page, not one per service: a busy creator's list would otherwise carry hundreds. */}
        <CommandForm command="add_sample" label="Add work sample" variant="secondary" returnTo={route}>
          <FileUploadField purpose="SAMPLE" name="asset_id" label="Sample file" maxFiles={1} help="One image, video or PDF. Leave this empty if the work only lives online." />
          <Field name="title" label="What this work is" required />
          <Field name="url" label="Link to it online (needed when there is no file)" />
          <Field name="description" label="A line about it (optional)" />
          <SelectField name="service_id" label="Show it on" placeholder="Keep it in my portfolio only"
            options={services.filter((s) => str(s.status) !== 'ARCHIVED').map((s) => ({ value: str(s.id), label: str(s.title) }))} />
        </CommandForm>
      </details>
    </section>}

    {services.length === 0
      ? <Empty title="No services yet">
        <Link href="/creator/services/new" className="text-link">Create your first service ›</Link>
      </Empty>
      : matching.length === 0
        ? <Empty title={search ? `No service matches “${search}”` : 'No services with that status'}>
          <Link href={route} className="text-link">Show every service ›</Link>
        </Empty>
        : <><p className="muted service-board-count">{pages > 1
          ? `${(pageNumber - 1) * PAGE_SIZE + 1}–${(pageNumber - 1) * PAGE_SIZE + shown.length} of ${matching.length} ${matching.length === 1 ? 'service' : 'services'}`
          : matching.length === services.length
            ? `${services.length} ${services.length === 1 ? 'service' : 'services'}`
            : `${matching.length} of ${services.length} services`}</p>
        <div className="cards service-board" aria-labelledby="services-list-heading">
          {shown.map(s => {
            const live = byService.get(str(s.id)) ?? [];
            const mine = live.filter((order) => NEEDS_CREATOR.has(str(order.status))).length;
            const samples = rows(s.samples);
            return <div className="panel service-row" key={str(s.id)}>
              <div className="service-row-head">
                <h3>{str(s.title)}</h3>
                <Badge>{str(s.status)}</Badge>
              </div>
              <p className="service-row-facts">
                <strong>{money(s.price_minor)}</strong>
                <span>{num(s.turnaround_hours)} {num(s.turnaround_hours) === 1 ? 'hour' : 'hours'}</span>
                <span>{humanize(str(s.taxonomy))}</span>
                <span>{samples.length} {samples.length === 1 ? 'sample' : 'samples'}</span>
                {live.length > 0
                  ? <Link className="service-row-live" href="/buyer/orders">{live.length} active {live.length === 1 ? 'order' : 'orders'}{mine > 0 ? ` · ${mine} need${mine === 1 ? 's' : ''} you` : ''}</Link>
                  : null}
              </p>

              {str(s.taxonomy) === 'DIGITAL' && <div className="digital-releases">
                <p className="muted">
                  {s.digital_license === 'EXCLUSIVE' ? 'Exclusive license' : 'Non-exclusive license'}
                  {s.digital_stock ? ` · ${num(s.digital_stock)} ${num(s.digital_stock) === 1 ? 'copy' : 'copies'}` : ' · unlimited copies'}
                  {` · ${num(row(s.licenses).active)} sold, ${num(row(s.licenses).held)} in checkout`}
                </p>
                {rows(s.releases).length
                  ? <ul className="release-list">{rows(s.releases).map((release) => <li key={str(release.version)}>Version {num(release.version)} · {str(release.filename)}</li>)}</ul>
                  : <p className="notice">Upload the product file before publishing.</p>}
                {str(s.status) !== 'ARCHIVED' && (rows(s.releases).length
                  // Once a file is out, a new version is an occasional task: keep its form folded so the list stays a list.
                  ? <details className="service-edit">
                    <summary>Upload a new version</summary>
                    {releaseForm(str(s.id), 'Add new version')}
                  </details>
                  : releaseForm(str(s.id), 'Add product file'))}
              </div>}

              <details className="service-edit">
                <summary>What this service includes</summary>
                <p className="prewrap">{str(s.description)}</p>
              </details>
              <details className="service-edit">
                <summary>Work samples ({samples.length})</summary>
                {samples.length > 0
                  ? <SampleGallery samples={samples} label={`Work samples for ${str(s.title)}`} />
                  : <p className="muted">This service has no samples yet, and it cannot be published without one.</p>}
              </details>
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

              <div className="inline-actions service-row-actions">
                <Link className="text-link" href={`/services/${str(s.id)}`}>Open public page ›</Link>
                {['DRAFT', 'PAUSED'].includes(str(s.status)) && <CommandForm
                  command="publish_service"
                  label={str(s.status) === 'PAUSED' ? 'Resume selling' : 'Publish'}
                  values={{
                    service_id: str(s.id)
                  }}
                  returnTo={route}
                />}
                {str(s.status) === 'PUBLISHED' && <CommandForm
                  command="pause_service"
                  label="Pause"
                  values={{
                    service_id: str(s.id)
                  }}
                  returnTo={route}
                />}
              </div>
            </div>;
          })}
        </div>
        {pages > 1 && <nav className="services-pages" aria-label="Service pages">
          {pageNumber > 1 ? <Link className="button button-outline compact" href={listHref(chosen, pageNumber - 1)}>‹ Previous</Link> : <span />}
          <span className="muted">Page {pageNumber} of {pages}</span>
          {pageNumber < pages ? <Link className="button button-outline compact" href={listHref(chosen, pageNumber + 1)}>Next ›</Link> : <span />}
        </nav>}</>}
  </main>;
}
