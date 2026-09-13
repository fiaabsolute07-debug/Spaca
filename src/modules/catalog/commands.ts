/**
 * Supply commands (master §5.2, §13.2, P1A): profile, samples, services with immutable versions,
 * weekly capacity pools, and Book Now with an exact terms snapshot.
 */
import {
  CommandError,
  expectedVersion,
  httpUrl,
  integer,
  money,
  orderEvent,
  text,
  uuid,
  type CommandHandler,
  type Row,
  type Tx,
} from '@/lib/commands';
import type { Actor } from '@/lib/auth';
import { ensureBuckets, insertReservation, lockAvailableBucket, lockOwnedPool, setPoolTimezone, setWeeklyUnits } from '@/modules/capacity';
import { isValidTimeZone } from '@/modules/capacity/weeks';

const TAXONOMIES = ['CREATE', 'PUBLISH', 'ACCESS', 'DIGITAL'];
export const MIN_PUBLIC_SAMPLES = 3;
export const CHECKOUT_HOLD_MINUTES = Number(process.env.CHECKOUT_HOLD_MINUTES ?? 15);

export async function ownedService(tx: Tx, actor: Actor, id: string): Promise<Row> {
  const [service] = await tx<Row[]>`select * from app.services where id=${id} and creator_id=${actor.id} for update`;
  if (!service) throw new CommandError('Service not found or not owned by this account', 'FORBIDDEN');
  return service;
}

function assertVersion(row: Row, expected: number | null) {
  if (expected !== null && Number(row.version) !== expected) {
    throw new CommandError('This listing changed since you opened it. Reload and review the latest version.', 'VERSION_CONFLICT');
  }
}

/** Creates the next immutable version from the service's current fields when they differ from the latest version. */
async function snapshotVersion(tx: Tx, service: Row, actor: Actor): Promise<string> {
  const [latest] = await tx<Row[]>`select * from app.service_versions where service_id=${String(service.id)} order by version desc limit 1`;
  const unchanged = latest
    && latest.title === service.title && latest.description === service.description && latest.taxonomy === service.taxonomy
    && String(latest.price_minor) === String(service.price_minor) && latest.currency === service.currency
    && Number(latest.turnaround_hours) === Number(service.turnaround_hours) && Number(latest.revision_limit) === Number(service.revision_limit)
    && String(latest.pool_id) === String(service.pool_id);
  if (unchanged) return String(latest.id);
  const [created] = await tx<Row[]>`insert into app.service_versions
    (service_id,version,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,pool_id,created_by)
    values (${String(service.id)},${Number(latest?.version ?? 0) + 1},${service.title},${service.description},${service.taxonomy},${String(service.price_minor)},
      ${service.currency},${Number(service.turnaround_hours)},${Number(service.revision_limit)},${String(service.pool_id)},${actor.id}) returning id`;
  return String(created!.id);
}

async function assertPublishable(tx: Tx, actor: Actor, service: Row) {
  const [counts] = await tx<Row[]>`select
      (select count(*)::int from app.samples where creator_id=${actor.id} and visibility='PUBLIC' and moderation_status='APPROVED') as public_samples,
      (select count(*)::int from app.service_samples ss join app.samples sm on sm.id=ss.sample_id
        where ss.service_id=${String(service.id)} and sm.visibility='PUBLIC' and sm.moderation_status='APPROVED') as linked_samples,
      (select weekly_units from app.capacity_pools where id=${String(service.pool_id)}) as weekly_units`;
  const errors: string[] = [];
  if (Number(counts!.public_samples) < MIN_PUBLIC_SAMPLES) errors.push(`Add at least ${MIN_PUBLIC_SAMPLES} approved public work samples before publishing`);
  if (Number(counts!.linked_samples) < 1) errors.push('Link at least one approved sample to this service');
  if (Number(counts!.weekly_units) < 1) errors.push('Set at least one weekly capacity unit before publishing');
  if (errors.length) throw new CommandError(errors.join('. '), 'INVALID_INPUT');
}

const updateProfile: CommandHandler = async ({ tx, actor, form }) => {
  const displayName = text(form, 'display_name', true, 100);
  const handle = text(form, 'handle').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(handle)) throw new CommandError('Handle must use 3–32 lowercase letters, numbers, _ or -');
  const bio = text(form, 'bio', true, 2000);
  const niche = text(form, 'niche', false, 80) || 'Independent creator';
  const socialValue = text(form, 'social_url', false, 500);
  const social = socialValue ? httpUrl(socialValue, 'social_url') : null;
  const timezone = text(form, 'timezone', false, 64);
  if (timezone && !isValidTimeZone(timezone)) throw new CommandError('Time zone is not a valid IANA time zone');
  const [taken] = await tx<Row[]>`select user_id from app.profiles where handle=${handle} and user_id<>${actor.id}`;
  if (taken) throw new CommandError('That handle is already taken');
  await tx`update app.users set display_name=${displayName}, timezone=coalesce(${timezone || null},timezone) where id=${actor.id}`;
  await tx`insert into app.profiles (user_id,handle,bio,niche,social_url) values (${actor.id},${handle},${bio},${niche},${social})
    on conflict (user_id) do update set handle=excluded.handle,bio=excluded.bio,niche=excluded.niche,social_url=excluded.social_url,updated_at=now()`;
  return { path: '/settings/profile', message: 'Profile saved' };
};

const addSample: CommandHandler = async ({ tx, actor, form }) => {
  const title = text(form, 'title', true, 120);
  const url = httpUrl(text(form, 'url', true, 1000), 'url');
  const description = text(form, 'description', false, 2000);
  const visibility = text(form, 'visibility', false) || 'PUBLIC';
  if (!['PUBLIC', 'PRIVATE'].includes(visibility)) throw new CommandError('Sample visibility is invalid');
  const [sample] = await tx<Row[]>`insert into app.samples (creator_id,title,url,description,visibility,moderation_status)
    values (${actor.id},${title},${url},${description},${visibility},'PENDING') returning id`;
  const serviceId = String(form.get('service_id') ?? '').trim();
  if (serviceId) {
    await ownedService(tx, actor, serviceId);
    await tx`insert into app.service_samples (service_id,sample_id,creator_id) values (${serviceId},${String(sample!.id)},${actor.id}) on conflict do nothing`;
  }
  return { path: '/creator/services', message: 'Sample added and waiting for moderation', id: String(sample!.id) };
};

const createService: CommandHandler = async ({ tx, actor, form }) => {
  const title = text(form, 'title', true, 160);
  const description = text(form, 'description', true, 10000);
  const taxonomy = text(form, 'taxonomy');
  if (!TAXONOMIES.includes(taxonomy)) throw new CommandError('Unsupported service category');
  if (title.length < 3) throw new CommandError('Service title must be at least 3 characters');
  if (description.length < 20) throw new CommandError('Describe the scope in at least 20 characters');
  const price = money(text(form, 'price'), 'price');
  const turnaround = integer(text(form, 'turnaround_hours'), 'turnaround_hours', 1, 8760);

  // Shared pool (CAP-02): reuse an owned pool, or create one with this service's weekly capacity.
  const poolIdInput = String(form.get('pool_id') ?? '').trim();
  let poolId: string;
  if (poolIdInput) {
    poolId = String((await lockOwnedPool(tx, actor, poolIdInput)).id);
  } else {
    const weekly = integer(text(form, 'capacity'), 'capacity', 1, 100000);
    const [pool] = await tx<Row[]>`insert into app.capacity_pools (creator_id,name,timezone,weekly_units)
      values (${actor.id},${title.slice(0, 80)},${actor.timezone ?? 'UTC'},${weekly}) returning id`;
    poolId = String(pool!.id);
  }

  const [service] = await tx<Row[]>`insert into app.services (creator_id,pool_id,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,status)
    values (${actor.id},${poolId},${title},${description},${taxonomy},${price.toString()},'USD',${turnaround},1,'DRAFT') returning id`;
  const serviceId = String(service!.id);

  for (let n = 1; n <= 3; n++) {
    const url = text(form, `sample_url_${n}`, false, 1000);
    const sampleTitle = text(form, `sample_title_${n}`, false, 120);
    if (!url && !sampleTitle) continue;
    if (!url || !sampleTitle) throw new CommandError(`Sample ${n} needs both a title and a URL`);
    // Link samples submitted with the service use the schema default moderation state (APPROVED until the
    // moderation queue in W2-B exists); samples added later via add_sample start PENDING.
    const [sample] = await tx<Row[]>`insert into app.samples (creator_id,title,url,description) values (${actor.id},${sampleTitle},${httpUrl(url, `sample_url_${n}`)},'Linked sample for this service') returning id`;
    await tx`insert into app.service_samples (service_id,sample_id,creator_id) values (${serviceId},${String(sample!.id)},${actor.id})`;
  }
  return { path: '/creator/services', message: 'Draft service created', id: serviceId };
};

const updateService: CommandHandler = async ({ tx, actor, form }) => {
  const service = await ownedService(tx, actor, uuid(form, 'service_id'));
  const expected = expectedVersion(form);
  if (expected === null) throw new CommandError('expected_version is required to edit a service');
  assertVersion(service, expected);
  if (service.status === 'ARCHIVED') throw new CommandError('Archived services cannot be edited', 'DOMAIN_RULE');
  const title = text(form, 'title', true, 160);
  const description = text(form, 'description', true, 10000);
  const price = money(text(form, 'price'), 'price');
  const turnaround = integer(text(form, 'turnaround_hours'), 'turnaround_hours', 1, 8760);
  if (title.length < 3 || description.length < 20) throw new CommandError('Title needs 3+ characters and scope 20+ characters');
  const [updated] = await tx<Row[]>`update app.services set title=${title},description=${description},price_minor=${price.toString()},turnaround_hours=${turnaround},
    version=version+1,updated_at=now() where id=${String(service.id)} returning *`;
  if (updated!.status === 'PUBLISHED' || updated!.status === 'PAUSED') {
    // Live terms change only through a new immutable version; sold orders keep theirs (SUP-03).
    const versionId = await snapshotVersion(tx, updated!, actor);
    await tx`update app.services set published_version_id=${versionId} where id=${String(service.id)}`;
  }
  return { path: '/creator/services', message: 'Service updated. New checkouts use the new terms; existing orders keep theirs.' };
};

const publishService: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot publish services', 'ACCOUNT_SUSPENDED');
  const service = await ownedService(tx, actor, text(form, 'service_id'));
  assertVersion(service, expectedVersion(form));
  if (service.status === 'ARCHIVED') throw new CommandError('Archived services cannot be republished', 'DOMAIN_RULE');
  await assertPublishable(tx, actor, service);
  const versionId = await snapshotVersion(tx, service, actor);
  await tx`update app.services set status='PUBLISHED',published_version_id=${versionId},version=version+1,updated_at=now() where id=${String(service.id)}`;
  await ensureBuckets(tx, String(service.pool_id));
  return { path: '/creator/services', message: 'Service published' };
};

const setListingStatus = (status: 'PAUSED' | 'ARCHIVED'): CommandHandler => async ({ tx, actor, form }) => {
  const service = await ownedService(tx, actor, text(form, 'service_id'));
  assertVersion(service, expectedVersion(form));
  if (service.status === 'ARCHIVED') throw new CommandError('This service is already archived');
  if (status === 'PAUSED' && service.status !== 'PUBLISHED') throw new CommandError('Only a published service can be paused');
  // Pausing/archiving stops new sales only; existing orders, versions and evidence stay intact (SUP-04).
  await tx`update app.services set status=${status},version=version+1,updated_at=now() where id=${String(service.id)}`;
  return { path: '/creator/services', message: status === 'PAUSED' ? 'Service paused' : 'Service archived' };
};

const setCapacity: CommandHandler = async ({ tx, actor, form }) => {
  const poolId = text(form, 'pool_id');
  const weekly = integer(String(form.get('weekly_units') ?? form.get('total_units') ?? ''), 'weekly_units', 0, 100000);
  await setWeeklyUnits(tx, actor, poolId, weekly);
  return { path: '/creator/services', message: 'Weekly capacity updated' };
};

const setPoolTimezoneCommand: CommandHandler = async ({ tx, actor, form }) => {
  const { removed } = await setPoolTimezone(tx, actor, text(form, 'pool_id'), text(form, 'timezone', true, 64));
  return { path: '/creator/services', message: `Time zone updated; ${removed} empty future week(s) rebuilt. Weeks with bookings keep their dates.` };
};

const book: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot place new orders', 'ACCOUNT_SUSPENDED');
  const serviceId = text(form, 'service_id');
  const brief = text(form, 'brief', true, 12000);
  if (brief.length < 20) throw new CommandError('Share a brief of at least 20 characters', 'BRIEF_INCOMPLETE');
  const [service] = await tx<Row[]>`select s.id,s.creator_id,s.status,s.published_version_id,u.status as creator_status
    from app.services s join app.users u on u.id=s.creator_id where s.id=${serviceId} for share of s`;
  if (!service || service.status !== 'PUBLISHED' || !service.published_version_id) throw new CommandError('Service is no longer available', 'NOT_FOUND');
  if (service.creator_status !== 'ACTIVE') throw new CommandError('This creator is not accepting new orders', 'NOT_FOUND');
  if (String(service.creator_id) === actor.id) throw new CommandError('You cannot book your own service');
  const [version] = await tx<Row[]>`select * from app.service_versions where id=${String(service.published_version_id)}`;
  const requestedVersion = String(form.get('service_version_id') ?? '').trim();
  if (requestedVersion && requestedVersion !== String(version!.id)) {
    throw new CommandError('The creator updated this service. Review the new price and scope before booking.', 'QUOTE_CHANGED');
  }

  const preferredBucket = String(form.get('bucket_id') ?? '').trim() || null;
  const bucket = await lockAvailableBucket(tx, String(version!.pool_id), Number(version!.turnaround_hours), preferredBucket);
  const terms = {
    schema_version: 1,
    source: 'BOOK',
    service_version_id: String(version!.id),
    service_version: Number(version!.version),
    title: version!.title,
    scope: version!.description,
    taxonomy: version!.taxonomy,
    price_minor: String(version!.price_minor),
    currency: version!.currency,
    platform_fee_bps: 0,
    turnaround_hours: Number(version!.turnaround_hours),
    revision_limit: Number(version!.revision_limit),
    review_window_hours: Number(version!.review_window_hours),
    auto_accept_consent: form.get('accept_terms') === 'on' || form.get('accept_terms') === 'true',
    cancellation_policy_version: 'v1',
    capacity: { pool_id: String(bucket.pool_id), bucket_id: String(bucket.id), week_starts_at: new Date(bucket.starts_at).toISOString(), week_ends_at: new Date(bucket.ends_at).toISOString() },
  };
  const [order] = await tx<Row[]>`insert into app.orders
    (buyer_id,creator_id,service_id,service_version_id,pool_id,source,title,status,amount_minor,platform_fee_minor,currency,brief,brief_ready_at,terms,delivery_due_at)
    values (${actor.id},${String(service.creator_id)},${String(service.id)},${String(version!.id)},${String(bucket.pool_id)},'BOOK',${version!.title},'AWAITING_PAYMENT',
      ${String(version!.price_minor)},0,${version!.currency},${brief},now(),${JSON.stringify(terms)}::jsonb,null) returning id`;
  const orderId = String(order!.id);
  await insertReservation(tx, bucket, { orderId }, new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60_000));
  await orderEvent(tx, orderId, actor.id, 'ORDER_CREATED', { source: 'BOOK', service_version: Number(version!.version), platform_fee_minor: '0' });
  return { path: `/orders/${orderId}`, message: 'Capacity reserved. Fund the order to start work.', id: orderId };
};

export const catalogCommands: Record<string, CommandHandler> = {
  update_profile: updateProfile,
  add_sample: addSample,
  create_service: createService,
  update_service: updateService,
  publish_service: publishService,
  pause_service: setListingStatus('PAUSED'),
  archive_service: setListingStatus('ARCHIVED'),
  set_capacity: setCapacity,
  set_pool_timezone: setPoolTimezoneCommand,
  book,
};
