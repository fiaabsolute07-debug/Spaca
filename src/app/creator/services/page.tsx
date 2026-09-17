import Link from 'next/link';
import { getDashboardData } from '@/lib/read-model';
import { Badge, CommandForm, Empty, Field, availabilityLabel, date, humanize, money, num, row, rows, str, toneOf } from '@/components/ui';
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
 * Work the creator still owes someone, grouped by whose move it is rather than by the status word. A creator
 * opening this page wants one answer first — what do I have to do today — so the states they must act on come
 * first and the ones they are only waiting on come last. Finished orders are not work and are not listed.
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

/** Drafts and paused services need a decision; archived ones are history. Live work outranks everything. */
const STATUS_ORDER: Record<string, number> = { PUBLISHED: 0, DRAFT: 1, PAUSED: 2, ARCHIVED: 3 };

const DAY = 24 * 60 * 60 * 1000;
/** A stage lists the most urgent few; the rest are one link away. A wall of 160 orders is not a to-do list. */
const PER_STAGE = 5;

/** The instant a stage sorts on: the deadline that is actually running, oldest (most urgent) first. */
function deadlineOf(order: Row): number {
  const at = str(order.status) === 'DELIVERED' ? order.review_due_at : order.delivery_due_at;
  const time = at ? new Date(String(at)).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

/** When this order needs something, in the words the creator would use, plus whether it is already late. */
function due(order: Row): { label: string; late: boolean } | null {
  const status = str(order.status);
  if (status === 'AWAITING_PAYMENT') return { label: 'Not funded yet', late: false };
  const at = status === 'DELIVERED' ? order.review_due_at : order.delivery_due_at;
  if (!at) return null;
  const left = new Date(String(at)).getTime() - Date.now();
  if (!Number.isFinite(left)) return null;
  const word = status === 'DELIVERED' ? 'Buyer reviews by' : 'Due';
  if (left <= 0) return { label: status === 'DELIVERED' ? 'Review window closed' : 'Overdue', late: status !== 'DELIVERED' };
  const days = Math.floor(left / DAY);
  if (days >= 1) return { label: `${word} ${date(at)}`, late: false };
  const hours = Math.max(1, Math.round(left / (60 * 60 * 1000)));
  return { label: `${word} ${date(at)}`, late: status !== 'DELIVERED' && hours <= 24 };
}

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
  const inFlight = num(workload.in_flight_units);
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
  const shown = services
    .filter((service) => (!chosen || str(service.status) === chosen) && (!needle || str(service.title).toLowerCase().includes(needle)))
    .sort((a, b) => (byService.get(str(b.id))?.length ?? 0) - (byService.get(str(a.id))?.length ?? 0)
      || (STATUS_ORDER[str(a.status)] ?? 9) - (STATUS_ORDER[str(b.status)] ?? 9)
      || str(a.title).localeCompare(str(b.title)));
  // Filters are plain links and the search is a GET form, so both work without JavaScript and can be bookmarked.
  const chipHref = (value: string) => {
    const params = new URLSearchParams({ ...(value ? { status: value } : {}), ...(search ? { q: search } : {}) });
    return params.size ? `${route}?${params}` : route;
  };

  return <main className="container">
    {notices}
    <div className="section-heading">
      <PageHeading
        eyebrow="Creator workspace"
        title="My services"
        description="What you owe today, then everything you sell."
      />
      <Link className="button button-dark" href="/creator/services/new">New service</Link>
    </div>

    {active.length > 0 && <section className="panel" aria-labelledby="work-heading">
      <div className="inline-actions">
        <h2 id="work-heading">Work in progress</h2>
        <Link className="text-link" href="/buyer/orders">All orders ›</Link>
      </div>
      <div className="work-stages">
        {WORK_STAGES.map((stage) => {
          const items = active.filter((order) => (stage.statuses as readonly string[]).includes(str(order.status)))
            .sort((a, b) => deadlineOf(a) - deadlineOf(b));
          if (!items.length) return null;
          const listed = items.slice(0, PER_STAGE);
          return <section key={stage.key} className="work-stage" data-stage={stage.key} aria-labelledby={`work-${stage.key}`}>
            <h3 className="work-stage-head" id={`work-${stage.key}`}>{stage.title}<span className="work-count">{items.length}</span></h3>
            <p className="muted work-stage-hint">{stage.hint}</p>
            <ul className="work-list">
              {listed.map((order) => {
                const deadline = due(order);
                return <li key={str(order.id)}>
                  <Link className="work-item" href={`/orders/${str(order.id)}`}>
                    {/* Not a heading: a service card is found by its heading, and an order carries the same title. */}
                    <span className="work-item-what">
                      <strong>{str(order.title, 'Order')}</strong>
                      <small>for {str(order.buyer_name, 'a buyer')} · {money(order.amount_minor)}</small>
                    </span>
                    <Badge tone={toneOf(order.status)}>{humanize(str(order.status))}</Badge>
                    {deadline ? <span className="work-item-due" data-late={deadline.late ? 'yes' : 'no'}>{deadline.label}</span> : <span className="work-item-due" />}
                  </Link>
                </li>;
              })}
            </ul>
            {items.length > listed.length
              ? <p className="work-more"><Link className="text-link" href="/buyer/orders">{items.length - listed.length} more in this state ›</Link></p>
              : null}
          </section>;
        })}
      </div>
    </section>}

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

    {services.some((s) => str(s.status) !== 'ARCHIVED') && <section className="panel" aria-labelledby="add-sample-heading">
      <h2 id="add-sample-heading">Work samples</h2>
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
    </section>}

    {services.length > 0 && <div className="section-heading services-heading">
      <h2 id="services-list-heading">Services</h2>
      <form className="service-search" role="search" method="get" action={route}>
        {chosen ? <input type="hidden" name="status" value={chosen} /> : null}
        <label htmlFor="service-search-field">Find a service</label>
        <input id="service-search-field" type="search" name="q" defaultValue={search} placeholder="Search by title" />
        <button className="button button-secondary" type="submit">Search</button>
      </form>
      <nav className="chip-row" aria-label="Filter services">
        {SERVICE_FILTERS.map((option) => (counts[option.value] || !option.value) ? <Link key={option.label} className="chip-link" href={chipHref(option.value)}
          aria-current={chosen === option.value ? 'page' : undefined}>{option.label}<span className="muted">{counts[option.value]}</span></Link> : null)}
      </nav>
    </div>}

    {services.length === 0
      ? <Empty title="No services yet">
        <Link href="/creator/services/new" className="text-link">Create your first service ›</Link>
      </Empty>
      : shown.length === 0
        ? <Empty title={search ? `No service matches “${search}”` : 'No services with that status'}>
          <Link href={route} className="text-link">Show every service ›</Link>
        </Empty>
        : <><p className="muted service-board-count">{shown.length === services.length
          ? `${services.length} ${services.length === 1 ? 'service' : 'services'}`
          : `${shown.length} of ${services.length} services`}</p>
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
        </div></>}
  </main>;
}
