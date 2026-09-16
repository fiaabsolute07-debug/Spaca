import Link from 'next/link';
import { SelectField } from '@/components/select';
import { ReportForm } from '@/components/report-form';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth';
import { getRequestData } from '@/lib/read-model';
import { sql } from '@/lib/db';
import { isFlagEnabled } from '@/modules/admin/policy';
import { getPoolData, listPoolNetworks, type PoolNetwork } from '@/modules/pools/service';
import { PoolPanel } from '@/components/pools/pool-panel';
import { Badge, CommandForm, Empty, Field, date, money, num, row, rows, str, type Row } from '@/components/ui';
import { Notices } from '@/components/notices';
import { PageHeading } from '@/components/page-heading';
import { FileUploadField } from '@/components/files/file-upload-field';
import { categoryOf } from '@/components/category';
import { APPLICATION_FILTERS, APPLICATION_SORTS, compareApplications, parseFilter, parseSort, quoteSummary } from '@/modules/requests/compare';
import type { PageProps } from '@/components/page-props';

export const dynamic = 'force-dynamic';

const OFFER_LABEL: Record<string, string> = {
  OFFERED: 'Offer sent, waiting for the creator',
  ACCEPTED: 'Hired: order created',
  DECLINED: 'Offer declined',
  EXPIRED: 'Offer expired',
  WITHDRAWN: 'Offer withdrawn',
  LAPSED: 'Hire lapsed: payment not completed',
};

function Samples({ items }: { items: Row[] }) {
  if (!items.length) return null;
  return <ul className="facts">
    {items.map((sample) => <li key={str(sample.id)}>
      <span>{str(sample.title)}</span>
      {sample.url ? <a className="text-link" href={str(sample.url)} target="_blank" rel="noreferrer">Open ›</a> : <span className="muted">Uploaded file</span>}
    </li>)}
  </ul>;
}

function ApplicationCard({ application: a, owner, route }: { application: Row; owner: boolean; route: string }) {
  const offerStatus = str(a.offer_status);
  const liveOffer = offerStatus === 'OFFERED';
  return <div className="record">
    <div className="inline-actions">
      <h3>{str(a.creator_name)}</h3>
      <Badge>{str(a.status)}</Badge>
      <span className="muted">Quote v{num(a.version)} · valid until {date(a.valid_until)}</span>
    </div>
    <p className="prewrap">{str(a.note)}</p>
    <ul className="facts">
      <li><span>Quote</span><strong>{money(a.quote_minor)}</strong></li>
      <li><span>Turnaround</span><strong>{num(a.turnaround_hours)} hours</strong></li>
      {a.publish_url ? <li><span>Posts on</span><strong><a className="text-link" href={str(a.publish_url)} target="_blank" rel="noreferrer nofollow">{a.publish_handle ? `@${str(a.publish_handle)}` : str(a.publish_url)}</a> · {str(a.publish_verification) === 'VERIFIED' ? 'verified' : 'self-reported'}</strong></li> : null}
      {offerStatus && <li><span>Offer</span><strong>{OFFER_LABEL[offerStatus] ?? offerStatus}{liveOffer ? ` · until ${date(a.offer_expires_at)}` : ''}</strong></li>}
    </ul>
    <Samples items={rows(a.samples_snapshot)} />
    {a.offer_order_id && offerStatus === 'ACCEPTED' ? <Link className="text-link" href={`/orders/${str(a.offer_order_id)}`}>Open the order ›</Link> : null}
    {owner && str(a.status) === 'SUBMITTED' && <CommandForm
      command="select_application"
      label={`Offer ${money(a.quote_minor)} to this creator`}
      values={{ application_id: str(a.id), application_version: str(a.version) }}
      returnTo={route}
    />}
    {owner && liveOffer && <CommandForm command="withdraw_offer" label="Withdraw offer" values={{ offer_id: str(a.offer_id) }} returnTo={route} />}
    {!owner && liveOffer && <>
      <CommandForm command="accept_offer" label="Accept offer" values={{ offer_id: str(a.offer_id) }} returnTo={route}>
        <p className="muted">Accepting creates the order. The buyer funds it before work starts.</p>
      </CommandForm>
      <CommandForm command="decline_offer" label="Decline offer" values={{ offer_id: str(a.offer_id) }} returnTo={route}>
        <Field name="reason" label="Reason (optional)" />
      </CommandForm>
    </>}
    {!owner && str(a.status) === 'SUBMITTED' && <CommandForm command="withdraw_application" label="Withdraw application" values={{ application_id: str(a.id) }} returnTo={route} />}
  </div>;
}

function CampaignPanel({ campaign: c }: { campaign: Row }) {
  return <div className="panel">
    <h2>Campaign</h2>
    <ul className="facts">
      <li><span>Budget</span><strong>{money(c.budget_minor)}</strong></li>
      <li><span>Offers waiting for creators</span><strong>{money(c.offered_minor)}</strong></li>
      <li><span>Accepted, awaiting your payment</span><strong>{money(c.awaiting_payment_minor)}</strong></li>
      <li><span>Funded</span><strong>{money(c.funded_minor)}</strong></li>
      <li><span>Completed</span><strong>{money(c.completed_minor)}</strong></li>
      <li><span>Refunded</span><strong>{money(c.refunded_minor)}</strong></li>
      <li><span>Hires funded / needed</span><strong>{num(c.committed_hires)} / {num(c.target_hires)}</strong></li>
    </ul>
    {rows(c.hires).length > 0 && <div className="table-wrap">
      <table>
        <thead><tr><th>Creator</th><th>Offer</th><th>Order</th><th>Payment</th><th>Due</th></tr></thead>
        <tbody>
          {rows(c.hires).map((hire) => <tr key={str(hire.offer_id)}>
            <td>{str(hire.creator_name)}<small>{money(hire.amount_minor)}</small></td>
            <td>{str(hire.offer_status)}</td>
            <td>{hire.order_id ? <Link className="text-link" href={`/orders/${str(hire.order_id)}`}>{str(hire.order_status)}</Link> : '—'}</td>
            <td>{str(hire.payment_status, '—')}</td>
            <td>{hire.delivery_due_at ? date(hire.delivery_due_at) : '—'}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}
  </div>;
}

export default async function RequestPage({ params, searchParams }: PageProps<{ id: string }>) {
  const query = await searchParams;
  const { id } = await params;
  const route = `/requests/${id}`;
  const actor = await getActor();
  const result = await getRequestData(actor, id);
  if (!result) notFound();
  const d = row(result),
    r = row(d.request),
    owner = actor?.id === str(r.buyer_id),
    open = str(r.status) === 'OPEN' && new Date(str(r.application_deadline)).getTime() > Date.now(),
    applications = rows(d.applications),
    mine = applications.find((a) => str(a.creator_id) === actor?.id),
    images = Array.isArray(r.image_ids) ? r.image_ids.map(String) : [];
  // A reward pool can be added only before the first application, and only the buyer sees its balances.
  const poolData = await getPoolData(actor, id);
  const canCreatePool = owner && !poolData && applications.length === 0 && ['OPEN', 'FILLED'].includes(str(r.status));
  const [poolNetworks, cryptoEnabled, tokenRewards, nftRewards] = canCreatePool
    ? await Promise.all([listPoolNetworks(), isFlagEnabled(sql, 'CRYPTO_CHECKOUT_ENABLED'), isFlagEnabled(sql, 'TOKEN_REWARDS_ENABLED'), isFlagEnabled(sql, 'NFT_REWARDS_ENABLED')])
    : [[] as PoolNetwork[], false, false, false];
  // REQ-11: the buyer can reorder and filter the comparison; creators only ever see their own application.
  const sort = parseSort(query.sort), filter = parseFilter(query.status);
  const shown = owner ? compareApplications(applications, sort, filter) : applications;
  const summary = owner ? quoteSummary(applications) : null;
  const compareHref = (next: { sort?: string; status?: string }) => {
    const params = new URLSearchParams();
    const nextSort = next.sort ?? sort, nextFilter = next.status ?? filter;
    if (nextSort !== 'received') params.set('sort', nextSort);
    if (nextFilter !== 'all') params.set('status', nextFilter);
    return params.size ? `${route}?${params}` : route;
  };
  return <main className="container">
    <Notices query={query} />
    <Link href="/requests" className="breadcrumbs">← All open briefs</Link>
    <PageHeading eyebrow={categoryOf(r.taxonomy).title} title={str(r.title)} description={`Posted by ${str(r.buyer_name)} · ${str(r.status)}`} />
    <div className="split">
      <div>
        <div className="panel">
          <h2>The brief</h2>
          {images.length > 0 && <div className="campaign-gallery">
            {images.map((imageId, index) => <div key={imageId}><img src={`/api/request-images/${imageId}`} alt={`${str(r.title)}, image ${index + 1} of ${images.length}`} loading="lazy" /></div>)}
          </div>}
          <p className="prewrap">{str(r.brief)}</p>
          <ul className="facts">
            <li><span>Total budget</span><strong>{money(r.budget_minor)}</strong></li>
            {r.per_creator_cap_minor != null && <li><span>Per creator cap</span><strong>{money(r.per_creator_cap_minor)}</strong></li>}
            <li><span>Creators needed</span><strong>{num(r.target_hires)}</strong></li>
            <li><span>Applications close</span><strong>{date(r.application_deadline)}</strong></li>
            <li><span>Delivery deadline</span><strong>{date(r.deadline)}</strong></li>
            <li><span>Applications</span><strong>{num(r.application_count)}</strong></li>
            {str(r.taxonomy) === 'PUBLISH' && <>
              <li><span>Creators post on</span><strong>{str(r.publish_platform)} · {str(r.publish_format).replaceAll('_', ' ').toLowerCase()}</strong></li>
              <li><span>Disclosure</span><strong>“{str(r.disclosure_text)}”</strong></li>
              <li><span>Keep live for</span><strong>{num(r.min_live_hours)} hours</strong></li>
            </>}
          </ul>
          {actor && !owner && <ReportForm targetType="REQUEST" targetId={str(r.id)} returnTo={route} label="Report this brief" />}
        </div>
        <PoolPanel data={poolData} owner={owner} route={route} requestId={str(r.id)} networks={poolNetworks} cryptoEnabled={cryptoEnabled} tokenRewards={tokenRewards} nftRewards={nftRewards} canCreate={canCreatePool} />
        {d.campaign ? <CampaignPanel campaign={row(d.campaign)} /> : null}
        <div className="panel">
          <h2>{owner ? 'Compare applications' : 'Your application'}</h2>
          {owner && <p className="muted">Quotes are private to you. Nothing is awarded automatically: each offer holds budget for 24 hours until the creator confirms capacity.</p>}
          {owner && applications.length > 0 && <div className="compare-controls">
            {summary && <p className="compare-summary">{summary.count} {summary.count === 1 ? 'application' : 'applications'} · quotes {money(String(summary.lowestMinor))}–{money(String(summary.highestMinor))} · median delivery {summary.medianTurnaroundHours} hours</p>}
            <nav aria-label="Sort applications" className="choice-chips">
              {Object.entries(APPLICATION_SORTS).map(([value, label]) => <Link key={value} href={compareHref({ sort: value })} scroll={false} className="chip-link" aria-current={sort === value ? 'true' : undefined}>{label}</Link>)}
            </nav>
            <nav aria-label="Filter applications" className="choice-chips">
              {Object.entries(APPLICATION_FILTERS).map(([value, label]) => <Link key={value} href={compareHref({ status: value })} scroll={false} className="chip-link" aria-current={filter === value ? 'true' : undefined}>{label}</Link>)}
            </nav>
            <p className="muted">Sorting and filters change only this view. No creator is chosen until you send an offer. <a className="text-link" href={`/api/requests/${str(r.id)}/applications`} download>Download CSV</a></p>
          </div>}
          {shown.length ? shown.map((a) => <ApplicationCard key={str(a.id)} application={a} owner={owner} route={route} />) : applications.length ? (
            <Empty title="No applications match this filter"><Link className="text-link" href={compareHref({ status: 'all' })} scroll={false}>Show all applications</Link></Empty>
          ) : (
            <Empty title="No applications to show">Applications are visible to the buyer and their respective creators.</Empty>
          )}
        </div>
      </div>
      <aside className="panel">
        <h2>{owner ? 'Manage your brief' : mine ? (str(mine.status) === 'SUBMITTED' ? 'Update your quote' : 'Your application') : 'Bring your approach'}</h2>
        {owner ? <>
          <p>Review samples and scope before offering. The lowest quote does not automatically win.</p>
          {['OPEN', 'FILLED'].includes(str(r.status)) && <section className="owner-images" aria-labelledby="campaign-images-heading">
            <h3 id="campaign-images-heading">Campaign images</h3>
            <p className="muted">{images.length ? `${images.length} of 6 shown to creators. Saving new images replaces them.` : 'Add product screenshots or brand visuals so creators see the project at a glance.'}</p>
            <CommandForm command="set_request_images" label={images.length ? 'Replace images' : 'Save images'} variant="secondary" values={{ request_id: str(r.id) }} returnTo={route}>
              <FileUploadField purpose="REQUEST_IMAGE" name="image_ids" label="Choose images" help="Up to 6 PNG, JPG, GIF or WebP images, 10 MB each." maxFiles={6} />
            </CommandForm>
            {images.length > 0 && <CommandForm command="set_request_images" label="Remove images" variant="danger" values={{ request_id: str(r.id), clear: 'true' }} returnTo={route} />}
          </section>}
          {['OPEN', 'FILLED'].includes(str(r.status)) && <>
            <CommandForm command="close_request" label="Close to new applications" values={{ request_id: str(r.id) }} returnTo={route} />
            <CommandForm command="cancel_request" label="Cancel request" values={{ request_id: str(r.id) }} returnTo={route} />
          </>}
        </> : !actor ? <Link className="button button-dark" href="/sign-in">Log in to apply</Link> : !actor.roles.includes('creator') ? <p className="muted">Applying needs a creator account. You are signed in with a buyer account.</p> : open && (!mine || str(mine.status) === 'SUBMITTED' || ['DECLINED', 'WITHDRAWN'].includes(str(mine.status))) ? <CommandForm
          command="apply"
          label={mine ? 'Send updated quote' : 'Send application'}
          values={{ request_id: str(r.id) }}
          returnTo={route}
        >
          <Field name="quote" label="Your quote (USD)" type="number" value={mine ? String(Number(mine.quote_minor) / 100) : undefined} required />
          <Field name="turnaround_hours" label="Delivery time (hours)" type="number" value={mine ? str(mine.turnaround_hours) : '48'} required />
          <Field name="valid_days" label="Quote valid for (days)" type="number" value="7" />
          {str(r.taxonomy) === 'PUBLISH' && (rows(d.my_social_accounts).length
            ? <SelectField name="publish_account_id" label={`Account you will post on (${str(r.publish_platform)})`} required
              defaultValue={mine?.publish_account_id ? str(mine.publish_account_id) : str(rows(d.my_social_accounts)[0]?.id)}
              options={rows(d.my_social_accounts).map((account) => ({ value: str(account.id), label: account.handle ? `@${str(account.handle)}` : str(account.url) }))} />
            : <p className="muted">Link your {str(r.publish_platform)} account under <Link className="text-link" href="/settings/profile">Profile › Linked accounts</Link> to apply.</p>)}
          <Field name="note" label="Your approach and relevant samples" type="textarea" value={mine ? str(mine.note) : undefined} required />
          <p className="muted">Your approved public samples are attached as a snapshot. Only the buyer sees your quote.</p>
        </CommandForm> : <p>{open ? 'Your application has an offer in progress.' : 'This request is not accepting applications.'}</p>}
      </aside>
    </div>
  </main>;
}
