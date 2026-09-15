/**
 * Supply commands (master §5.2, §13.2, P1A): profile, samples, services with immutable versions,
 * the creator's active-order limit, and Book Now with an exact terms snapshot.
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
import { claimWorkload, setAcceptingOrders } from '@/modules/capacity';
import { isValidTimeZone } from '@/modules/capacity/weeks';
import { assertFlags } from '@/modules/admin/policy';
import { lockSampleAsset } from '@/modules/storage/service';
import { assertContentPolicy } from '@/modules/moderation/policy';
import { EDITORIAL_POLICY_VERSION, channelOf, ownedSocialAccount, publishFields } from '@/modules/publish';
import { DIGITAL_POLICY_VERSION, digitalFields, holdEntitlement, latestReleaseVersion } from '@/modules/digital';

const TAXONOMIES = ['CREATE', 'PUBLISH', 'ACCESS', 'DIGITAL'];
export const DELIVERABLE_BY_TAXONOMY: Record<string, string> = { CREATE: 'CONTENT_HANDOFF', PUBLISH: 'PUBLISHED_POST', ACCESS: 'SESSION', DIGITAL: 'DIGITAL_FILE' };
/** Decision 2026-09-15: one approved public sample is enough to publish, so new creators onboard quickly. */
export const MIN_PUBLIC_SAMPLES = 1;
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
    && Number(latest.units_per_order) === Number(service.units_per_order)
    && String(latest.publish_account_id ?? '') === String(service.publish_account_id ?? '') && String(latest.publish_format ?? '') === String(service.publish_format ?? '')
    && String(latest.min_live_hours ?? '') === String(service.min_live_hours ?? '') && String(latest.disclosure_text ?? '') === String(service.disclosure_text ?? '')
    && [...ACCESS_COLUMNS, ...DIGITAL_COLUMNS].every((column) => String(latest[column] ?? '') === String(service[column] ?? ''));
  if (unchanged) return String(latest.id);
  // PUBLISH versions snapshot the channel itself, so a later account change never alters what was sold.
  const channel = service.publish_account_id ? channelOf(await ownedSocialAccount(tx, String(service.creator_id), String(service.publish_account_id))) : null;
  const [created] = await tx<Row[]>`insert into app.service_versions
    (service_id,version,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,units_per_order,
     publish_account_id,publish_platform,publish_handle,publish_url,publish_format,min_live_hours,disclosure_text,
     access_session_minutes,
     digital_license,digital_rights_text,digital_stock,digital_updates,digital_download_limit,created_by)
    values (${String(service.id)},${Number(latest?.version ?? 0) + 1},${service.title},${service.description},${service.taxonomy},${String(service.price_minor)},
      ${service.currency},${Number(service.turnaround_hours)},${Number(service.revision_limit)},${Number(service.units_per_order)},
      ${service.publish_account_id ?? null},${channel?.platform ?? null},${channel?.handle ?? null},${channel?.channel_url ?? null},
      ${service.publish_format ?? null},${service.min_live_hours ?? null},${service.disclosure_text ?? null},
      ${service.access_session_minutes ?? null},
      ${service.digital_license ?? null},${service.digital_rights_text ?? null},${service.digital_stock ?? null},${service.digital_updates ?? null},${service.digital_download_limit ?? null},${actor.id}) returning id`;
  return String(created!.id);
}

const ACCESS_COLUMNS = ['access_session_minutes'] as const;
const DIGITAL_COLUMNS = ['digital_license', 'digital_rights_text', 'digital_stock', 'digital_updates', 'digital_download_limit'] as const;

async function assertPublishable(tx: Tx, actor: Actor, service: Row) {
  const [counts] = await tx<Row[]>`select
      (select count(*)::int from app.samples where creator_id=${actor.id} and visibility='PUBLIC' and moderation_status='APPROVED') as public_samples,
      (select count(*)::int from app.service_samples ss join app.samples sm on sm.id=ss.sample_id
        where ss.service_id=${String(service.id)} and sm.visibility='PUBLIC' and sm.moderation_status='APPROVED') as linked_samples`;
  const errors: string[] = [];
  if (Number(counts!.public_samples) < MIN_PUBLIC_SAMPLES) errors.push(`Add at least ${MIN_PUBLIC_SAMPLES} approved public work sample${MIN_PUBLIC_SAMPLES === 1 ? '' : 's'} before publishing`);
  if (Number(counts!.linked_samples) < 1) errors.push('Link at least one approved sample to this service');
  if (service.taxonomy === 'PUBLISH') {
    const [account] = service.publish_account_id
      ? await tx<Row[]>`select 1 from app.social_accounts where id=${String(service.publish_account_id)} and creator_id=${actor.id} and removed_at is null` : [];
    if (!account) errors.push('Choose the linked account this service posts on');
    if (!service.publish_format || service.min_live_hours == null || !service.disclosure_text) errors.push('Set the post format, minimum live time and disclosure');
  }
  // ACCESS: the buyer and creator agree the session time in messages; the listing only states the length (2026-09-15).
  if (service.taxonomy === 'ACCESS' && service.access_session_minutes == null) errors.push('Set the session length');
  if (service.taxonomy === 'DIGITAL') {
    await assertFlags(tx, ['DIGITAL_PRODUCTS_ENABLED']);
    if (!service.digital_license || !service.digital_rights_text || !service.digital_updates || service.digital_download_limit == null) errors.push('Set the license, usage rights, update policy and download limit');
    if ((await latestReleaseVersion(tx, String(service.id))) === null) errors.push('Upload the product file before publishing');
  }
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
  const assetId = text(form, 'asset_id', false, 60) || null;
  // SEC-14: an uploaded sample must be the creator's own SAMPLE upload; delivery files never become portfolio.
  if (assetId) await lockSampleAsset(tx, actor.id, uuid(form, 'asset_id'));
  const urlValue = text(form, 'url', !assetId, 1000);
  const url = urlValue ? httpUrl(urlValue, 'url') : null;
  const description = text(form, 'description', false, 2000);
  const visibility = text(form, 'visibility', false) || 'PUBLIC';
  if (!['PUBLIC', 'PRIVATE'].includes(visibility)) throw new CommandError('Sample visibility is invalid');
  const [sample] = await tx<Row[]>`insert into app.samples (creator_id,title,url,description,visibility,moderation_status,storage_asset_id)
    values (${actor.id},${title},${url},${description},${visibility},'PENDING',${assetId}) returning id`;
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
  const units = unitsPerOrder(form);
  const publish = await publishTermsFromForm(tx, actor, taxonomy, form);
  const sessionMinutes = taxonomy === 'ACCESS' ? accessSessionMinutes(form) : null;
  const digital = taxonomy === 'DIGITAL' ? digitalFields(form) : null;

  const [service] = await tx<Row[]>`insert into app.services (creator_id,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,units_per_order,
      publish_account_id,publish_format,min_live_hours,disclosure_text,
      access_session_minutes,
      digital_license,digital_rights_text,digital_stock,digital_updates,digital_download_limit,status)
    values (${actor.id},${title},${description},${taxonomy},${price.toString()},'USD',${turnaround},1,${units ?? 1},
      ${publish?.accountId ?? null},${publish?.format ?? null},${publish?.minLiveHours ?? null},${publish?.disclosure ?? null},
      ${sessionMinutes},
      ${digital?.license ?? null},${digital?.rightsText ?? null},${digital?.stock ?? null},${digital?.updates ?? null},${digital?.downloadLimit ?? null},'DRAFT') returning id`;
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

/** PUBLISH listings name the creator's own linked account and the posting terms buyers agree to (P6-02). */
async function publishTermsFromForm(tx: Tx, actor: Actor, taxonomy: string, form: FormData) {
  if (taxonomy !== 'PUBLISH') return null;
  const accountValue = String(form.get('publish_account_id') ?? '').trim();
  if (!accountValue) throw new CommandError('Choose the linked account this service posts on. Add one under Profile → Linked accounts.');
  const account = await ownedSocialAccount(tx, actor.id, uuid(form, 'publish_account_id'));
  return { accountId: String(account.id), ...publishFields(form) };
}

/** ACCESS session length in minutes (15–480, on the 15-minute grid); defaults to a 60-minute call. */
function accessSessionMinutes(form: FormData): number {
  const minutes = integer(String(form.get('access_session_minutes') ?? '').trim() || '60', 'access_session_minutes', 15, 480);
  if (minutes % 15 !== 0) throw new CommandError('Session length must be a multiple of 15 minutes');
  return minutes;
}

/** Optional order weight: how many units of the creator's limit one order of this service uses (default 1). */
function unitsPerOrder(form: FormData): number | null {
  const value = String(form.get('units_per_order') ?? '').trim();
  return value ? integer(value, 'units_per_order', 1, 10) : null;
}

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
  const units = unitsPerOrder(form);
  const publish = form.has('publish_account_id') ? await publishTermsFromForm(tx, actor, String(service.taxonomy), form) : null;
  const sessionMinutes = service.taxonomy === 'ACCESS' && form.has('access_session_minutes') ? accessSessionMinutes(form) : null;
  const digital = service.taxonomy === 'DIGITAL' && form.has('digital_rights_text') ? digitalFields(form) : null;
  const [updated] = await tx<Row[]>`update app.services set title=${title},description=${description},price_minor=${price.toString()},turnaround_hours=${turnaround},
    units_per_order=coalesce(${units}::int,units_per_order),
    publish_account_id=coalesce(${publish?.accountId ?? null}::uuid,publish_account_id),publish_format=coalesce(${publish?.format ?? null},publish_format),
    min_live_hours=coalesce(${publish?.minLiveHours ?? null}::int,min_live_hours),disclosure_text=coalesce(${publish?.disclosure ?? null},disclosure_text),
    access_session_minutes=coalesce(${sessionMinutes}::int,access_session_minutes),
    digital_license=case when ${digital !== null} then ${digital?.license ?? null} else digital_license end,digital_rights_text=case when ${digital !== null} then ${digital?.rightsText ?? null} else digital_rights_text end,
    digital_stock=case when ${digital !== null} then ${digital?.stock ?? null}::int else digital_stock end,digital_updates=case when ${digital !== null} then ${digital?.updates ?? null} else digital_updates end,
    digital_download_limit=case when ${digital !== null} then ${digital?.downloadLimit ?? null}::int else digital_download_limit end,
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

/** CAP-08: pause blocks new orders, hires and auctions at once; work in progress continues. */
const setAcceptingOrdersCommand: CommandHandler = async ({ tx, actor, form }) => {
  if (!actor.roles.includes('creator')) throw new CommandError('Only creators can pause new orders', 'FORBIDDEN');
  const value = text(form, 'accepting');
  if (!['true', 'false'].includes(value)) throw new CommandError('accepting must be true or false');
  await setAcceptingOrders(tx, actor, value === 'true');
  return { path: '/creator/services', message: value === 'true' ? 'You are accepting new orders again' : 'New orders paused. Orders in progress continue.' };
};

const book: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot place new orders', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['BOOKING_ENABLED', 'CHECKOUT_CREATION_ENABLED']);
  const serviceId = text(form, 'service_id');
  const [service] = await tx<Row[]>`select s.id,s.creator_id,s.status,s.published_version_id,s.taxonomy,u.status as creator_status
    from app.services s join app.users u on u.id=s.creator_id where s.id=${serviceId} for share of s`;
  if (!service || service.status !== 'PUBLISHED' || !service.published_version_id) throw new CommandError('Service is no longer available', 'NOT_FOUND');
  if (service.creator_status !== 'ACTIVE') throw new CommandError('This creator is not accepting new orders', 'NOT_FOUND');
  if (String(service.creator_id) === actor.id) throw new CommandError('You cannot book your own service');
  // A DIGITAL purchase needs no brief: the files already exist. Everything else needs one before work can start.
  const isDigital = service.taxonomy === 'DIGITAL';
  const brief = text(form, 'brief', !isDigital, 12000) || (isDigital ? 'Digital product purchase' : '');
  if (brief.length < 20 && !isDigital) throw new CommandError('Share a brief of at least 20 characters', 'BRIEF_INCOMPLETE');
  assertContentPolicy(brief);
  const [version] = await tx<Row[]>`select * from app.service_versions where id=${String(service.published_version_id)}`;
  const requestedVersion = String(form.get('service_version_id') ?? '').trim();
  if (requestedVersion && requestedVersion !== String(version!.id)) {
    throw new CommandError('The creator updated this service. Review the new price and scope before booking.', 'QUOTE_CHANGED');
  }

  const units = Number(version!.units_per_order);
  const creatorId = String(service.creator_id);
  const digital = version!.taxonomy === 'DIGITAL' ? await digitalPurchaseOf(tx, form, String(service.id), version!) : null;
  const publish = version!.taxonomy === 'PUBLISH' ? {
    account_id: String(version!.publish_account_id), platform: String(version!.publish_platform), handle: version!.publish_handle ?? null,
    channel_url: String(version!.publish_url), format: String(version!.publish_format), min_live_hours: Number(version!.min_live_hours),
    disclosure_text: String(version!.disclosure_text), editorial_policy_version: EDITORIAL_POLICY_VERSION,
  } : null;
  // MOD-02: a PUBLISH buyer agrees that the post carries the disclosure and that the creator writes it in their own voice.
  if (publish && !['on', 'true'].includes(String(form.get('accept_publish_terms') ?? ''))) {
    throw new CommandError(`Confirm the posting terms: the post is labelled "${publish.disclosure_text}" and written by the creator in their own words`, 'DOMAIN_RULE');
  }
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
    capacity: digital ? { model: 'DIGITAL_STOCK', units: 0 } : { model: 'ACTIVE_ORDERS', units },
    // SUP-05: CREATE hands content to the buyer; only PUBLISH carries a posting obligation.
    deliverable: DELIVERABLE_BY_TAXONOMY[String(version!.taxonomy)] ?? 'CONTENT_HANDOFF',
    ...(publish ? { publish } : {}),
    // ACCESS: the session length is sold; the time is agreed in order messages.
    ...(version!.taxonomy === 'ACCESS' ? { access: { session_minutes: Number(version!.access_session_minutes), scheduling: 'AGREED_IN_MESSAGES' } } : {}),
    ...(digital ? { digital } : {}),
  };
  // The claim locks the creator's workload and refuses the order when they paused new orders; the transaction then rolls back.
  const expiresAt = new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60_000);
  const [order] = await tx<Row[]>`insert into app.orders
    (buyer_id,creator_id,service_id,service_version_id,source,title,status,amount_minor,platform_fee_minor,currency,brief,brief_ready_at,terms,delivery_due_at)
    values (${actor.id},${creatorId},${String(service.id)},${String(version!.id)},'BOOK',${version!.title},'AWAITING_PAYMENT',
      ${String(version!.price_minor)},0,${version!.currency},${brief},now(),${JSON.stringify(terms)}::jsonb,null) returning id`;
  const orderId = String(order!.id);
  // XPL-04: a digital sale reserves stock through its entitlement and does not count as work in progress.
  if (digital) await holdEntitlement(tx, { orderId, serviceId: String(service.id), versionId: String(version!.id), buyerId: actor.id, creatorId, terms: digital, expiresAt });
  else await claimWorkload(tx, { creatorId, units, origin: 'BOOK', orderId, expiresAt });
  await orderEvent(tx, orderId, actor.id, 'ORDER_CREATED', { source: 'BOOK', service_version: Number(version!.version), platform_fee_minor: '0' });
  return { path: `/orders/${orderId}`, message: version!.taxonomy === 'ACCESS' ? 'Session reserved. Fund the order, then agree the time with the creator in messages.' : digital ? 'Your copy is reserved. Pay to unlock the files.' : 'Order reserved. Fund the order to start work.', id: orderId };
};

async function digitalPurchaseOf(tx: Tx, form: FormData, serviceId: string, version: Row) {
  await assertFlags(tx, ['DIGITAL_PRODUCTS_ENABLED']);
  // The buyer agrees to the license text they saw; the order keeps it verbatim.
  if (!['on', 'true'].includes(String(form.get('accept_license') ?? ''))) throw new CommandError('Confirm the license terms before buying', 'DOMAIN_RULE');
  const releaseVersion = await latestReleaseVersion(tx, serviceId);
  if (releaseVersion === null) throw new CommandError('This product has no file yet', 'NOT_FOUND');
  return {
    license: String(version.digital_license) as 'NON_EXCLUSIVE' | 'EXCLUSIVE',
    rights_text: String(version.digital_rights_text),
    updates_policy: String(version.digital_updates) as 'LATEST' | 'PURCHASED_VERSION',
    download_limit: Number(version.digital_download_limit),
    release_version: releaseVersion,
    policy_version: DIGITAL_POLICY_VERSION,
  };
}

export const catalogCommands: Record<string, CommandHandler> = {
  update_profile: updateProfile,
  add_sample: addSample,
  create_service: createService,
  update_service: updateService,
  publish_service: publishService,
  pause_service: setListingStatus('PAUSED'),
  archive_service: setListingStatus('ARCHIVED'),
  set_accepting_orders: setAcceptingOrdersCommand,
  book,
};
