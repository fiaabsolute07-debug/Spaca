import { CommandError, instant, integer, money, orderEvent, text, type CommandHandler, type Row } from '@/lib/commands';
import { insertReservation, lockAvailableBucket } from '@/modules/capacity';
import { CHECKOUT_HOLD_MINUTES } from '@/modules/catalog/commands';

const TAXONOMIES = ['CREATE', 'PUBLISH', 'ACCESS', 'DIGITAL'];

const createRequest: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot publish requests', 'ACCOUNT_SUSPENDED');
  const title = text(form, 'title');
  const brief = text(form, 'brief');
  const taxonomy = text(form, 'taxonomy');
  if (!TAXONOMIES.includes(taxonomy)) throw new CommandError('Unsupported request category');
  const budget = money(text(form, 'budget'), 'budget');
  const capValue = text(form, 'per_creator_cap', false);
  const cap = capValue ? money(capValue, 'per_creator_cap') : budget;
  const target = integer(text(form, 'target_hires'), 'target_hires', 1, 100);
  const deadline = instant(text(form, 'deadline'), 'deadline');
  if (deadline <= new Date()) throw new CommandError('Deadline must be in the future');
  const [request] = await tx<Row[]>`insert into app.requests (buyer_id,title,brief,taxonomy,budget_minor,per_creator_cap_minor,target_hires,deadline)
    values (${actor.id},${title},${brief},${taxonomy},${budget.toString()},${cap.toString()},${target},${deadline.toISOString()}) returning id`;
  return { path: `/requests/${request!.id}`, message: 'Brief published. Creators can now apply.', id: String(request!.id) };
};

const apply: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot apply to requests', 'ACCOUNT_SUSPENDED');
  const requestId = text(form, 'request_id');
  const quote = money(text(form, 'quote'), 'quote');
  const note = text(form, 'note');
  const turnaround = integer(text(form, 'turnaround_hours'), 'turnaround_hours', 1, 8760);
  const [request] = await tx<Row[]>`select * from app.requests where id=${requestId} and status in ('OPEN','SELECTING') and deadline>now() for update`;
  if (!request) throw new CommandError('Request is closed or unavailable');
  if (String(request.buyer_id) === actor.id) throw new CommandError('You cannot apply to your own request');
  if (quote > BigInt(request.per_creator_cap_minor)) throw new CommandError('Quote exceeds the request cap');
  await tx`insert into app.applications (request_id,creator_id,quote_minor,turnaround_hours,note,status)
    values (${requestId},${actor.id},${quote.toString()},${turnaround},${note},'SUBMITTED')
    on conflict (request_id,creator_id) do update set quote_minor=excluded.quote_minor,turnaround_hours=excluded.turnaround_hours,note=excluded.note,status='SUBMITTED',updated_at=now()`;
  return { path: `/requests/${requestId}`, message: 'Application sent' };
};

const selectApplication: CommandHandler = async ({ tx, actor, form }) => {
  const appId = text(form, 'application_id');
  const [application] = await tx<Row[]>`select a.*,r.buyer_id,r.status as request_status from app.applications a join app.requests r on r.id=a.request_id
    where a.id=${appId} and r.buyer_id=${actor.id} for update`;
  if (!application) throw new CommandError('Application not found or not owned by this buyer', 'FORBIDDEN');
  await tx`update app.applications set status='SELECTED',updated_at=now() where id=${appId} and status='SUBMITTED'`;
  await tx`update app.requests set status='SELECTING',updated_at=now() where id=${application.request_id}`;
  return { path: `/requests/${application.request_id}`, message: 'Creator selected. They can accept the offer.' };
};

const respondToOffer: CommandHandler = async ({ tx, actor, form, command }) => {
  const appId = text(form, 'application_id');
  const [application] = await tx<Row[]>`select a.*,r.title,r.brief,r.buyer_id,r.taxonomy,r.deadline,r.status as request_status from app.applications a
    join app.requests r on r.id=a.request_id where a.id=${appId} and a.creator_id=${actor.id} for update`;
  if (!application) throw new CommandError('Offer not found or not visible to this account', 'FORBIDDEN');
  if (command === 'decline_offer') {
    await tx`update app.applications set status='DECLINED',updated_at=now() where id=${appId}`;
    return { path: `/requests/${application.request_id}`, message: 'Offer declined' };
  }
  if (String(application.status) !== 'SELECTED') throw new CommandError('This application is not selected');
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot accept new work', 'ACCOUNT_SUSPENDED');
  const [service] = await tx<Row[]>`select s.id,s.pool_id,s.published_version_id from app.services s
    where s.creator_id=${actor.id} and s.status='PUBLISHED' and s.taxonomy=${application.taxonomy} order by s.created_at desc limit 1`;
  if (!service) throw new CommandError('Publish a matching service before accepting this offer');
  const bucket = await lockAvailableBucket(tx, String(service.pool_id), Number(application.turnaround_hours));
  const terms = {
    schema_version: 1,
    source: 'REQUEST',
    request_id: String(application.request_id),
    application_id: String(application.id),
    title: application.title,
    scope: application.brief,
    taxonomy: application.taxonomy,
    price_minor: String(application.quote_minor),
    currency: 'USD',
    platform_fee_bps: 0,
    turnaround_hours: Number(application.turnaround_hours),
    revision_limit: 1,
    review_window_hours: 72,
    auto_accept_consent: false,
    cancellation_policy_version: 'v1',
    capacity: { pool_id: String(bucket.pool_id), bucket_id: String(bucket.id), week_starts_at: new Date(bucket.starts_at).toISOString(), week_ends_at: new Date(bucket.ends_at).toISOString() },
  };
  const [order] = await tx<Row[]>`insert into app.orders (buyer_id,creator_id,service_id,pool_id,source,source_ref,title,status,amount_minor,platform_fee_minor,currency,brief,brief_ready_at,terms,delivery_due_at)
    values (${application.buyer_id},${actor.id},${String(service.id)},${String(bucket.pool_id)},'REQUEST',${application.request_id},${application.title},'AWAITING_PAYMENT',${application.quote_minor},0,'USD',
      ${application.brief},now(),${JSON.stringify(terms)}::jsonb,null) returning id`;
  await insertReservation(tx, bucket, { orderId: String(order!.id) }, new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60_000));
  await tx`update app.applications set status='ACCEPTED',updated_at=now() where id=${appId}`;
  await tx`update app.requests set status='FILLED',updated_at=now() where id=${application.request_id}`;
  await orderEvent(tx, String(order!.id), actor.id, 'ORDER_CREATED', { source: 'REQUEST', platform_fee_minor: '0' });
  return { path: `/orders/${order!.id}`, message: 'Offer accepted. Buyer must fund the order.', id: String(order!.id) };
};

export const requestCommands: Record<string, CommandHandler> = {
  create_request: createRequest,
  apply,
  select_application: selectApplication,
  accept_offer: respondToOffer,
  decline_offer: respondToOffer,
};
