/**
 * Requests v2 (master §9, P2): versioned private quotes, buyer selection as a 24-hour HireOffer that holds request
 * budget and hire count, creator confirmation with an explicit capacity pool, then a canonical order per hire.
 *
 * Lock order: request → offer → application → capacity pool/bucket. Budget and hire totals are also enforced by
 * CHECK constraints on counters maintained by triggers (drizzle/0007).
 */
import { CommandError, UUID_PATTERN, expectedVersion, instantField, integer, money, orderEvent, text, uuid, type CommandHandler, type Row, type Tx } from '@/lib/commands';
import type { Actor } from '@/lib/auth';
import { claimWorkload } from '@/modules/capacity';
import { CHECKOUT_HOLD_MINUTES } from '@/modules/catalog/commands';
import { assertFlags } from '@/modules/admin/policy';
import { enqueueNotification } from '@/modules/notifications/enqueue';
import { applyPoolFunding } from '@/modules/payments/funding';
import { allocateHire, poolTermsFor } from '@/modules/pools/service';
import { assertContentPolicy } from '@/modules/moderation/policy';
import { DELIVERABLE_BY_TAXONOMY } from '@/modules/catalog/commands';
import { EDITORIAL_POLICY_VERSION, channelOf, isSocialPlatform, ownedSocialAccount, publishFields } from '@/modules/publish';
import { baselineFor } from '@/modules/publish/metrics';
import { CAMPAIGN_GOAL_VALUES, type CampaignGoal } from './goals';
import { DEFAULT_MEASURE_AFTER_DAYS, DEFAULT_MEDIAN_MULTIPLIER, DEFAULT_VERIFY_DAYS, MIN_ELIGIBLE_POSTS, PERFORMANCE_POLICY_VERSION, maxPayoutMinor, viewsCap } from '@/modules/publish/performance';

const TAXONOMIES = ['CREATE', 'PUBLISH', 'ACCESS', 'DIGITAL'];
export const HIRE_OFFER_HOURS = 24;
const DEFAULT_QUOTE_VALID_DAYS = 7;

const done = (requestId: string, message: string, id?: string) => ({ path: `/requests/${requestId}`, message, ...(id ? { id } : {}) });

/** Maps the oversell CHECK constraints to the §13.3 error instead of a generic failure. */
async function guardBudget<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const constraint = (error as { constraint_name?: string }).constraint_name ?? '';
    if (constraint === 'requests_budget_not_oversold' || constraint === 'requests_hires_not_oversold') {
      throw new CommandError('This selection would exceed the request budget or the number of creators to hire', 'BUDGET_EXCEEDED');
    }
    throw error;
  }
}

async function lockOwnedRequest(tx: Tx, actor: Actor, requestId: string): Promise<Row> {
  const [request] = await tx<Row[]>`select * from app.requests where id=${requestId} for update`;
  if (!request || String(request.buyer_id) !== actor.id) throw new CommandError('Request not found or not owned by this account', 'NOT_FOUND');
  return request;
}

function budgetFields(form: FormData, existing?: Row) {
  const budgetValue = text(form, 'budget', false);
  const capValue = text(form, 'per_creator_cap', false);
  const target = text(form, 'target_hires', !existing) ? integer(text(form, 'target_hires'), 'target_hires', 1, 100) : Number(existing!.target_hires);
  let cap = capValue ? money(capValue, 'per_creator_cap') : existing?.per_creator_cap_minor != null ? BigInt(existing.per_creator_cap_minor) : null;
  if (capValue === '0') cap = null;
  let budget = budgetValue ? money(budgetValue, 'budget') : existing ? BigInt(existing.budget_minor) : null;
  // §9.1: a cap alone materializes the total ceiling as cap × hires.
  if (budget === null && cap !== null) budget = cap * BigInt(target);
  if (budget === null) throw new CommandError('Set a total budget or a per-creator cap');
  if (budget <= 0n || (cap !== null && cap <= 0n)) throw new CommandError('Budget amounts must be positive');
  if (cap !== null && cap > budget) throw new CommandError('The per-creator cap cannot exceed the total budget');
  return { budget, cap, target };
}

/**
 * §9.6 terms: a fixed fee per post plus a view bonus with a hard cap. PUBLISH only, because a post must exist to
 * measure, and behind its own flag. Defaults follow the spec (7-day checkpoint, 7-day verification, 3× median).
 */
async function performanceFields(tx: Tx, form: FormData, taxonomy: string, existing?: Row) {
  const model = text(form, 'payment_model', false) || (existing ? String(existing.payment_model) : 'FIXED');
  if (model !== 'FIXED' && model !== 'PERFORMANCE') throw new CommandError('Unsupported payment model');
  if (model === 'FIXED') return { model, baseFee: null, rpm: null, bonusCap: null, measureAfterDays: null, verifyDays: null, medianMultiplier: null };
  await assertFlags(tx, ['PERFORMANCE_CAMPAIGNS_ENABLED']);
  if (taxonomy !== 'PUBLISH') throw new CommandError('A performance campaign pays for views on a post, so it needs the PUBLISH category');
  const baseFee = money(text(form, 'base_fee'), 'base_fee');
  const rpm = money(text(form, 'rpm_rate'), 'rpm_rate');
  const bonusCap = money(text(form, 'bonus_cap'), 'bonus_cap');
  const measureAfterDays = text(form, 'measure_after_days', false) ? integer(text(form, 'measure_after_days'), 'measure_after_days', 1, 30) : DEFAULT_MEASURE_AFTER_DAYS;
  const verifyDays = text(form, 'verify_days', false) ? integer(text(form, 'verify_days'), 'verify_days', 1, 30) : DEFAULT_VERIFY_DAYS;
  const multiplierValue = text(form, 'median_multiplier', false);
  const medianMultiplier = multiplierValue ? Number(multiplierValue) : DEFAULT_MEDIAN_MULTIPLIER;
  if (!Number.isFinite(medianMultiplier) || medianMultiplier < 1 || medianMultiplier > 10 || Math.round(medianMultiplier * 100) !== Math.round(medianMultiplier * 10000) / 100) {
    throw new CommandError('The median multiplier must be between 1 and 10, with at most two decimals');
  }
  return { model, baseFee, rpm, bonusCap, measureAfterDays, verifyDays, medianMultiplier };
}

/**
 * Freezes what a performance hire will be judged on: the creator's own recent median, the view cap it implies, and the
 * fee and bonus cap from the campaign. Written as evidence before any money is held, so later view buying cannot
 * change the cap that was agreed.
 */
async function freezePerformanceTerms(tx: Tx, request: Row, application: Row, account: Row | null, quote: bigint) {
  if (!account) throw new CommandError('A performance hire needs the posting account from the application', 'QUOTE_CHANGED');
  const baseFee = BigInt(String(request.base_fee_minor));
  if (quote !== baseFee) throw new CommandError('A performance campaign pays its fixed fee; the creator must re-apply at that amount', 'QUOTE_CHANGED');
  const baseline = baselineFor({ handle: account.handle ? String(account.handle) : null, accountId: String(account.id) });
  if (!baseline.eligible) {
    throw new CommandError(`This creator has ${baseline.eligible_posts} recent qualifying posts; a performance campaign needs at least ${MIN_ELIGIBLE_POSTS}`, 'DOMAIN_RULE');
  }
  const multiplier = Number(request.median_multiplier);
  const [row] = await tx<Row[]>`insert into app.performance_baselines (creator_id,social_account_id,eligible_posts,median_views,window_days,measured_at_days,source)
    values (${String(application.creator_id)},${String(account.id)},${baseline.eligible_posts},${baseline.median_views.toString()},${baseline.window_days},${baseline.measured_at_days},${baseline.source})
    returning id`;
  const bonusCap = BigInt(String(request.bonus_cap_minor));
  return {
    policy_version: PERFORMANCE_POLICY_VERSION,
    baseline_id: String(row!.id),
    baseline_median: baseline.median_views.toString(),
    baseline_posts: baseline.eligible_posts,
    baseline_source: baseline.source,
    median_multiplier: multiplier,
    views_cap: viewsCap(baseline.median_views, multiplier).toString(),
    base_fee_minor: baseFee.toString(),
    rpm_rate_minor: String(request.rpm_rate_minor),
    bonus_cap_minor: bonusCap.toString(),
    max_payout_minor: maxPayoutMinor(baseFee, bonusCap).toString(),
    measure_after_days: Number(request.measure_after_days),
    verify_days: Number(request.verify_days),
  };
}

function deadlines(form: FormData, existing?: Row) {
  const deadline = text(form, 'deadline', !existing) ? instantField(form, 'deadline') : new Date(existing!.deadline);
  const applicationDeadline = text(form, 'application_deadline', false) ? instantField(form, 'application_deadline') : existing ? new Date(existing.application_deadline) : deadline;
  if (applicationDeadline > deadline) throw new CommandError('Applications must close on or before the delivery deadline');
  return { deadline, applicationDeadline };
}

/** PUBLISH requests say where and how creators post; each applicant then names their own account on that platform. */
function requestPublishTerms(taxonomy: string, form: FormData, currentPlatform?: string) {
  if (taxonomy !== 'PUBLISH') return null;
  const platform = String(form.get('publish_platform') ?? '').trim() || currentPlatform || 'X';
  if (!isSocialPlatform(platform)) throw new CommandError('Unsupported posting platform');
  return { platform, ...publishFields(form) };
}

/** ACCESS campaigns say how long the session is; the time itself is agreed in the order messages, as for a booking. */
function requestAccessMinutes(taxonomy: string, form: FormData, existing?: Row): number | null {
  if (taxonomy !== 'ACCESS') return null;
  const value = text(form, 'access_session_minutes', !existing) || String(existing!.access_session_minutes);
  return integer(value, 'access_session_minutes', 15, 480);
}

/**
 * DIGITAL campaigns say what the buyer may do with the files they commission. A commission is not a product listing:
 * there is no stock, no release history and no download limit here, only the rights both sides agree to.
 */
function requestLicense(taxonomy: string, form: FormData, existing?: Row) {
  if (taxonomy !== 'DIGITAL') return null;
  const kind = text(form, 'license_kind', false) || (existing ? String(existing.license_kind) : 'NON_EXCLUSIVE');
  if (kind !== 'NON_EXCLUSIVE' && kind !== 'EXCLUSIVE') throw new CommandError('license_kind must be NON_EXCLUSIVE or EXCLUSIVE');
  const rights = text(form, 'license_rights_text', !existing, 4000) || String(existing!.license_rights_text);
  if (rights.length < 20) throw new CommandError('Say what the buyer may do with the files in at least 20 characters');
  return { kind, rights };
}

/** What the campaign is for. The brief form always asks; campaigns created through the API without one stay unlabelled. */
function campaignGoalOf(form: FormData): CampaignGoal | null {
  const value = text(form, 'campaign_goal', false, 20).toUpperCase();
  if (!value) return null;
  if (!CAMPAIGN_GOAL_VALUES.includes(value as CampaignGoal)) throw new CommandError('Choose what the campaign is for');
  return value as CampaignGoal;
}

const createRequest: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot publish requests', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['REQUESTS_ENABLED']);
  const title = text(form, 'title', true, 160);
  const brief = text(form, 'brief', true, 12000);
  const taxonomy = text(form, 'taxonomy');
  if (!TAXONOMIES.includes(taxonomy)) throw new CommandError('Unsupported request category');
  assertContentPolicy(title, brief);
  const { budget, cap, target } = budgetFields(form);
  const { deadline, applicationDeadline } = deadlines(form);
  if (applicationDeadline <= new Date()) throw new CommandError('Deadlines must be in the future');
  const publish = requestPublishTerms(taxonomy, form);
  const goal = campaignGoalOf(form);
  const sessionMinutes = requestAccessMinutes(taxonomy, form);
  const license = requestLicense(taxonomy, form);
  const performance = await performanceFields(tx, form, taxonomy);
  if (performance.model === 'PERFORMANCE') {
    const perHire = maxPayoutMinor(performance.baseFee!, performance.bonusCap!);
    if (perHire > budget) throw new CommandError('The budget must cover at least one hire at the fixed fee plus the bonus cap', 'BUDGET_EXCEEDED');
    if (cap !== null && cap < perHire) throw new CommandError('The per-creator cap must cover the fixed fee plus the bonus cap', 'BUDGET_EXCEEDED');
  }
  const [request] = await tx<Row[]>`insert into app.requests (buyer_id,title,brief,taxonomy,campaign_goal,budget_minor,per_creator_cap_minor,target_hires,deadline,application_deadline,
      publish_platform,publish_format,min_live_hours,disclosure_text,access_session_minutes,license_kind,license_rights_text,
      payment_model,base_fee_minor,rpm_rate_minor,bonus_cap_minor,measure_after_days,verify_days,median_multiplier)
    values (${actor.id},${title},${brief},${taxonomy},${goal},${budget.toString()},${cap?.toString() ?? null},${target},${deadline.toISOString()},${applicationDeadline.toISOString()},
      ${publish?.platform ?? null},${publish?.format ?? null},${publish?.minLiveHours ?? null},${publish?.disclosure ?? null},
      ${sessionMinutes},${license?.kind ?? null},${license?.rights ?? null},
      ${performance.model},${performance.baseFee?.toString() ?? null},${performance.rpm?.toString() ?? null},${performance.bonusCap?.toString() ?? null},
      ${performance.measureAfterDays},${performance.verifyDays},${performance.medianMultiplier}) returning id`;
  const requestId = String(request!.id);
  const images = text(form, 'image_ids', false, 400);
  if (images) await replaceRequestImages(tx, actor, requestId, images, text(form, 'thumb_ids', false, 400));
  return done(requestId, 'Brief published. Creators can now apply.', requestId);
};

const MAX_REQUEST_IMAGES = 6;

const assetIds = (value: string) => [...new Set(value.split(/[\s,]+/).map((id) => id.trim().toLowerCase()).filter(Boolean))];

/**
 * Replaces a campaign's images with the buyer's own finished REQUEST_IMAGE uploads, in the order given. `thumbs` holds
 * the small copy the browser made for each image, in the same order; a blank entry (or none at all) means the campaign
 * cards fall back to the full-size image.
 */
async function replaceRequestImages(tx: Tx, actor: Actor, requestId: string, value: string, thumbValue = ''): Promise<number> {
  const ids = assetIds(value);
  const thumbs = thumbValue.split(',').map((id) => id.trim().toLowerCase());
  if (ids.some((id) => !UUID_PATTERN.test(id))) throw new CommandError('image_ids must be file ids from finished uploads');
  if (thumbs.some((id) => id && !UUID_PATTERN.test(id))) throw new CommandError('thumb_ids must be file ids from finished uploads');
  if (ids.length > MAX_REQUEST_IMAGES) throw new CommandError(`A campaign can show at most ${MAX_REQUEST_IMAGES} images`);
  const wanted = [...new Set([...ids, ...thumbs.filter(Boolean)])];
  if (wanted.length) {
    const assets = await tx<Row[]>`select id,lifecycle_state from app.storage_assets where id = any(${wanted}::uuid[]) and owner_id=${actor.id} and purpose='REQUEST_IMAGE' for share`;
    if (assets.length !== wanted.length) throw new CommandError('Upload the images first', 'NOT_FOUND');
    if (assets.some((asset) => asset.lifecycle_state !== 'READY')) throw new CommandError('An image did not pass the upload checks', 'DOMAIN_RULE');
  }
  await tx`delete from app.request_images where request_id=${requestId}`;
  for (const [position, id] of ids.entries()) {
    const thumb = thumbs[position] && thumbs[position] !== id ? thumbs[position]! : null;
    await tx`insert into app.request_images (request_id,buyer_id,asset_id,thumb_asset_id,position) values (${requestId},${actor.id},${id},${thumb},${position})`;
  }
  return ids.length;
}

/** Campaign images can change while the campaign takes applications or hires; `clear=true` removes them all. */
const setRequestImages: CommandHandler = async ({ tx, actor, form }) => {
  const requestId = uuid(form, 'request_id');
  const request = await lockOwnedRequest(tx, actor, requestId);
  if (!['OPEN', 'FILLED'].includes(String(request.status))) throw new CommandError('Closed requests cannot be edited', 'REQUEST_CLOSED');
  const clear = text(form, 'clear', false, 10) === 'true';
  const images = clear ? '' : text(form, 'image_ids', false, 400);
  if (!clear && !images) throw new CommandError('Upload at least one image, or remove the current images');
  const count = await replaceRequestImages(tx, actor, requestId, images, clear ? '' : text(form, 'thumb_ids', false, 400));
  return done(requestId, count ? 'Campaign images updated.' : 'Campaign images removed.');
};

/** REQ-10: budget, cap, hires and deadlines may change, never below what is already held or committed. */
const updateRequest: CommandHandler = async ({ tx, actor, form }) => {
  const requestId = uuid(form, 'request_id');
  const request = await lockOwnedRequest(tx, actor, requestId);
  const expected = expectedVersion(form);
  if (expected === null) throw new CommandError('expected_version is required');
  if (Number(request.version) !== expected) throw new CommandError('This request changed since you opened it. Reload and try again.', 'VERSION_CONFLICT');
  if (!['OPEN', 'FILLED'].includes(String(request.status))) throw new CommandError('Closed requests cannot be edited', 'REQUEST_CLOSED');
  const { budget, cap, target } = budgetFields(form, request);
  const { deadline, applicationDeadline } = deadlines(form, request);
  const title = text(form, 'title', false, 160) || String(request.title);
  const brief = text(form, 'brief', false, 12000) || String(request.brief);
  assertContentPolicy(title, brief);
  // Posting terms can change for future offers; offers already sent keep their snapshot.
  const publish = request.taxonomy === 'PUBLISH' && form.has('publish_format') ? requestPublishTerms('PUBLISH', form, String(request.publish_platform)) : null;
  if (publish && publish.platform !== request.publish_platform) throw new CommandError('The posting platform cannot change after publishing the request');
  const sessionMinutes = form.has('access_session_minutes') ? requestAccessMinutes(String(request.taxonomy), form, request) : null;
  const license = form.has('license_rights_text') || form.has('license_kind') ? requestLicense(String(request.taxonomy), form, request) : null;
  const held = BigInt(request.reserved_minor) + BigInt(request.committed_minor);
  const hires = Number(request.reserved_hires) + Number(request.committed_hires);
  if (budget < held || target < hires) {
    throw new CommandError(`Budget and hires cannot go below current offers and hires (${hires} hires holding ${held} minor units)`, 'BUDGET_EXCEEDED');
  }
  await guardBudget(tx`update app.requests set title=${title},brief=${brief},budget_minor=${budget.toString()},per_creator_cap_minor=${cap?.toString() ?? null},
    target_hires=${target},deadline=${deadline.toISOString()},application_deadline=${applicationDeadline.toISOString()},
    publish_platform=coalesce(${publish?.platform ?? null},publish_platform),publish_format=coalesce(${publish?.format ?? null},publish_format),
    min_live_hours=coalesce(${publish?.minLiveHours ?? null}::int,min_live_hours),disclosure_text=coalesce(${publish?.disclosure ?? null},disclosure_text),
    access_session_minutes=coalesce(${sessionMinutes}::int,access_session_minutes),
    license_kind=coalesce(${license?.kind ?? null},license_kind),license_rights_text=coalesce(${license?.rights ?? null},license_rights_text),
    status=case when status='FILLED' and committed_hires < ${target} then 'OPEN' when status='OPEN' and committed_hires >= ${target} then 'FILLED' else status end,
    version=version+1,updated_at=now() where id=${requestId}`);
  return done(requestId, 'Request updated. Existing offers keep their terms.');
};

export async function withdrawOpenOffers(tx: Tx, requestId: string, reason: string) {
  const offers = await tx<Row[]>`update app.hire_offers set status='WITHDRAWN',response_reason=${reason},responded_at=now()
    where request_id=${requestId} and status='OFFERED' returning id,application_id`;
  for (const offer of offers) {
    await tx`update app.request_budget_reservations set state='RELEASED',updated_at=now() where offer_id=${String(offer.id)} and state='HELD'`;
    await tx`update app.applications set status='SUBMITTED',updated_at=now() where id=${String(offer.application_id)} and status='OFFERED'`;
  }
  return offers.length;
}

/** REQ-08: closing stops new applications and pending offers; accepted and funded hires continue untouched. */
const closeRequest: CommandHandler = async ({ tx, actor, form, command }) => {
  const requestId = uuid(form, 'request_id');
  const request = await lockOwnedRequest(tx, actor, requestId);
  if (!['OPEN', 'FILLED'].includes(String(request.status))) throw new CommandError('This request is already closed', 'REQUEST_CLOSED');
  if (command === 'cancel_request') {
    const [active] = await tx<Row[]>`select 1 from app.hire_offers where request_id=${requestId} and status='ACCEPTED' limit 1`;
    if (active) throw new CommandError('Creators have accepted hires on this request. Close it instead; their orders continue.', 'ORDER_STATE_CONFLICT');
  }
  const withdrawn = await withdrawOpenOffers(tx, requestId, command === 'cancel_request' ? 'Request cancelled by buyer' : 'Request closed by buyer');
  await tx`update app.requests set status=${command === 'cancel_request' ? 'CANCELLED' : 'CLOSED'},closed_at=now(),version=version+1,updated_at=now() where id=${requestId}`;
  return done(requestId, `Request ${command === 'cancel_request' ? 'cancelled' : 'closed'}${withdrawn ? `; ${withdrawn} pending offer(s) withdrawn` : ''}. Existing orders continue.`);
};

/** REQ-01/02: one logical application per creator, each edit a new version; quotes stay private (REQ-03). */
const apply: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot apply to requests', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['REQUESTS_ENABLED']);
  const requestId = uuid(form, 'request_id');
  const quote = money(text(form, 'quote'), 'quote');
  const note = text(form, 'note', true, 8000);
  if (note.length < 20) throw new CommandError('Describe your approach in at least 20 characters');
  const turnaround = integer(text(form, 'turnaround_hours'), 'turnaround_hours', 1, 8760);
  const validDays = text(form, 'valid_days', false) ? integer(text(form, 'valid_days'), 'valid_days', 1, 30) : DEFAULT_QUOTE_VALID_DAYS;
  const [request] = await tx<Row[]>`select * from app.requests where id=${requestId} for update`;
  if (!request || !['OPEN'].includes(String(request.status)) || new Date(request.application_deadline) <= new Date()) {
    throw new CommandError('This request is not accepting applications', 'REQUEST_CLOSED');
  }
  if (String(request.buyer_id) === actor.id) throw new CommandError('You cannot apply to your own request', 'FORBIDDEN');
  const ceiling = request.per_creator_cap_minor != null ? BigInt(request.per_creator_cap_minor) : BigInt(request.budget_minor);
  if (quote > ceiling) throw new CommandError('Quote exceeds the per-creator cap for this request', 'BUDGET_EXCEEDED');
  // Pool-backed requests pay the published reward bundle; the quote must equal its CASH value (W5-C2).
  const pool = await poolTermsFor(tx, requestId);
  if (pool && quote !== pool.cashMinor) throw new CommandError(`This request pays a fixed pool reward; quote exactly $${(Number(pool.cashMinor) / 100).toFixed(2)}`, 'DOMAIN_RULE');
  if (Date.now() + turnaround * 3600_000 > new Date(request.deadline).getTime()) {
    throw new CommandError('That turnaround would finish after the request deadline', 'DOMAIN_RULE');
  }
  let publishAccountId: string | null = null;
  if (request.taxonomy === 'PUBLISH') {
    const accountValue = text(form, 'publish_account_id', false);
    if (!accountValue) throw new CommandError(`Choose the ${String(request.publish_platform)} account you will post on`);
    const account = await ownedSocialAccount(tx, actor.id, uuid(form, 'publish_account_id'));
    if (account.platform !== request.publish_platform) throw new CommandError(`This request posts on ${String(request.publish_platform)}; choose an account on that platform`);
    publishAccountId = String(account.id);
  }
  const samples = await tx<Row[]>`select id,title,url,storage_asset_id from app.samples where creator_id=${actor.id} and visibility='PUBLIC' and moderation_status='APPROVED'
    order by created_at desc limit 5`;
  const snapshot = JSON.stringify(samples.map((s) => ({ id: String(s.id), title: s.title, url: s.url ?? null, asset_id: s.storage_asset_id ?? null })));
  const [existing] = await tx<Row[]>`select * from app.applications where request_id=${requestId} and creator_id=${actor.id} for update`;
  if (existing && ['OFFERED', 'ACCEPTED'].includes(String(existing.status))) {
    throw new CommandError('Your application has an offer in progress and cannot be edited', 'ORDER_STATE_CONFLICT');
  }
  const [application] = existing
    ? await tx<Row[]>`update app.applications set quote_minor=${quote.toString()},turnaround_hours=${turnaround},note=${note},status='SUBMITTED',
        valid_until=now() + (${validDays} * interval '1 day'),samples_snapshot=${snapshot}::jsonb,publish_account_id=${publishAccountId},version=version+1,updated_at=now()
        where id=${String(existing.id)} returning *`
    : await tx<Row[]>`insert into app.applications (request_id,creator_id,quote_minor,turnaround_hours,note,status,valid_until,samples_snapshot,publish_account_id)
        values (${requestId},${actor.id},${quote.toString()},${turnaround},${note},'SUBMITTED',now() + (${validDays} * interval '1 day'),${snapshot}::jsonb,${publishAccountId}) returning *`;
  await tx`insert into app.application_versions (application_id,version,quote_minor,turnaround_hours,note,valid_until,samples_snapshot,publish_account_id)
    values (${String(application!.id)},${application!.version},${application!.quote_minor},${turnaround},${note},${application!.valid_until},${snapshot}::jsonb,${publishAccountId})`;
  if (!existing) {
    await enqueueNotification(tx, requestId, `notify:request.application:${application!.id}`, {
      templateId: 'request.application_received', recipientId: String(request.buyer_id), params: { requestRef: requestId },
    });
  }
  return done(requestId, existing ? `Application updated (version ${application!.version})` : 'Application sent', String(application!.id));
};

const withdrawApplication: CommandHandler = async ({ tx, actor, form }) => {
  const applicationId = uuid(form, 'application_id');
  const [application] = await tx<Row[]>`select * from app.applications where id=${applicationId} and creator_id=${actor.id} for update`;
  if (!application) throw new CommandError('Application not found', 'NOT_FOUND');
  if (application.status !== 'SUBMITTED') throw new CommandError('Only an application without an active offer can be withdrawn; decline the offer instead', 'ORDER_STATE_CONFLICT');
  await tx`update app.applications set status='WITHDRAWN',updated_at=now() where id=${applicationId}`;
  return done(String(application.request_id), 'Application withdrawn');
};

/**
 * Buyer selects one application version (REQ-04/05/09/11): holds budget and one hire for 24 hours and asks the
 * creator to confirm. Never automatic; stale, expired or over-budget quotes are refused explicitly.
 */
const selectApplication: CommandHandler = async ({ tx, actor, form }) => {
  const applicationId = uuid(form, 'application_id');
  const shownVersion = integer(text(form, 'application_version'), 'application_version', 1, 100000);
  const [lookup] = await tx<Row[]>`select request_id from app.applications where id=${applicationId}`;
  if (!lookup) throw new CommandError('Application not found or not visible to this account', 'NOT_FOUND');
  const request = await lockOwnedRequest(tx, actor, String(lookup.request_id));
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot hire', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['REQUESTS_ENABLED']);
  if (request.status !== 'OPEN' || new Date(request.deadline) <= new Date()) throw new CommandError('This request is not open for hiring', 'REQUEST_CLOSED');
  const [application] = await tx<Row[]>`select * from app.applications where id=${applicationId} for update`;
  if (Number(application!.version) !== shownVersion) {
    throw new CommandError(`The creator updated this quote (now version ${application!.version}). Review the new terms before selecting.`, 'QUOTE_CHANGED');
  }
  if (application!.status !== 'SUBMITTED') throw new CommandError('This application already has an offer or is no longer active', 'ORDER_STATE_CONFLICT');
  if (new Date(application!.valid_until) <= new Date()) throw new CommandError('This quote has expired. Ask the creator to renew it.', 'QUOTE_EXPIRED');
  // REQ-04: availability can change after applying; an offer to a creator who cannot take it now would only lapse.
  const [creator] = await tx<Row[]>`select u.status, coalesce(w.accepting_orders, true) as accepting from app.users u
    left join app.creator_workloads w on w.creator_id=u.id where u.id=${String(application!.creator_id)}`;
  if (creator?.status !== 'ACTIVE') throw new CommandError('This creator cannot take new work right now', 'ACCOUNT_SUSPENDED');
  if (creator.accepting !== true) throw new CommandError('This creator paused new orders after applying. Ask them to resume before sending an offer.', 'NOT_ACCEPTING_ORDERS');
  const quote = BigInt(application!.quote_minor);
  const pool = await poolTermsFor(tx, String(request.id));
  if (pool && pool.cashMinor !== quote) throw new CommandError('The pool reward changed since this application; the creator must re-apply', 'QUOTE_CHANGED');
  let publish: Record<string, unknown> | null = null;
  let publishAccount: Row | null = null;
  if (request.taxonomy === 'PUBLISH') {
    if (!application!.publish_account_id) throw new CommandError('This application has no posting account; the creator must re-apply with one', 'QUOTE_CHANGED');
    const [account] = await tx<Row[]>`select * from app.social_accounts where id=${String(application!.publish_account_id)} and removed_at is null`;
    if (!account) throw new CommandError('The creator removed the posting account from this application; ask them to re-apply', 'QUOTE_CHANGED');
    publishAccount = account;
    publish = { account_id: String(account.id), ...channelOf(account), format: request.publish_format, min_live_hours: Number(request.min_live_hours),
      disclosure_text: request.disclosure_text, editorial_policy_version: EDITORIAL_POLICY_VERSION };
  }
  // §9.6: a performance hire holds the fixed fee plus the whole bonus cap, and freezes the creator's median now.
  const performance = String(request.payment_model) === 'PERFORMANCE' ? await freezePerformanceTerms(tx, request, application!, publishAccount, quote) : null;
  const amount = performance ? BigInt(performance.max_payout_minor) : quote;
  if (request.per_creator_cap_minor != null && amount > BigInt(request.per_creator_cap_minor)) {
    throw new CommandError('This quote is above the current per-creator cap', 'BUDGET_EXCEEDED');
  }
  if (BigInt(request.reserved_minor) + BigInt(request.committed_minor) + amount > BigInt(request.budget_minor)
    || Number(request.reserved_hires) + Number(request.committed_hires) + 1 > Number(request.target_hires)) {
    throw new CommandError('This selection would exceed the request budget or the number of creators to hire', 'BUDGET_EXCEEDED');
  }
  const expiresAt = new Date(Math.min(Date.now() + HIRE_OFFER_HOURS * 3600_000, new Date(request.deadline).getTime()));
  const terms = {
    schema_version: 1,
    source: 'REQUEST',
    request_id: String(request.id),
    request_version: Number(request.version),
    application_id: applicationId,
    application_version: shownVersion,
    title: request.title,
    scope: request.brief,
    taxonomy: request.taxonomy,
    price_minor: amount.toString(),
    currency: 'USD',
    platform_fee_bps: 0,
    turnaround_hours: Number(application!.turnaround_hours),
    revision_limit: 1,
    review_window_hours: 72,
    auto_accept_consent: false,
    request_deadline: new Date(request.deadline).toISOString(),
    cancellation_policy_version: 'v1',
    deliverable: DELIVERABLE_BY_TAXONOMY[String(request.taxonomy)] ?? 'CONTENT_HANDOFF',
    ...(publish ? { publish } : {}),
    // ACCESS: the session length is hired; the time is agreed in order messages, as it is for a booked session.
    ...(request.taxonomy === 'ACCESS' ? { access: { session_minutes: Number(request.access_session_minutes), scheduling: 'AGREED_IN_MESSAGES' } } : {}),
    // DIGITAL: the rights the buyer commissioned, frozen here so editing the campaign afterwards cannot change them.
    ...(request.taxonomy === 'DIGITAL' ? { license: { kind: String(request.license_kind), rights_text: String(request.license_rights_text), policy_version: 'license-v1' } } : {}),
    ...(performance ? { performance } : {}),
  };
  const [offer] = await tx<Row[]>`insert into app.hire_offers (request_id,application_id,application_version,buyer_id,creator_id,amount_minor,terms_snapshot,expires_at)
    values (${String(request.id)},${applicationId},${shownVersion},${actor.id},${String(application!.creator_id)},${amount.toString()},${JSON.stringify(terms)}::jsonb,${expiresAt.toISOString()})
    returning id`;
  await guardBudget(tx`insert into app.request_budget_reservations (request_id,offer_id,amount_minor) values (${String(request.id)},${String(offer!.id)},${amount.toString()})`);
  await tx`update app.applications set status='OFFERED',updated_at=now() where id=${applicationId}`;
  await enqueueNotification(tx, String(request.id), `notify:request.hire_offer:${offer!.id}`, {
    templateId: 'request.hire_offer', recipientId: String(application!.creator_id), params: { requestRef: String(request.id) },
  });
  return done(String(request.id), 'Offer sent. The creator has 24 hours to confirm capacity.', String(offer!.id));
};

async function lockOffer(tx: Tx, form: FormData): Promise<{ offer: Row; request: Row }> {
  const offerId = text(form, 'offer_id', false);
  const applicationId = text(form, 'application_id', false);
  if (!offerId && !applicationId) throw new CommandError('offer_id is required');
  const [lookup] = offerId
    ? await tx<Row[]>`select id,request_id from app.hire_offers where id=${uuid(form, 'offer_id')}`
    : await tx<Row[]>`select id,request_id from app.hire_offers where application_id=${uuid(form, 'application_id')} order by created_at desc limit 1`;
  if (!lookup) throw new CommandError('Offer not found or not visible to this account', 'NOT_FOUND');
  const [request] = await tx<Row[]>`select * from app.requests where id=${String(lookup.request_id)} for update`;
  const [offer] = await tx<Row[]>`select * from app.hire_offers where id=${String(lookup.id)} for update`;
  return { offer: offer!, request: request! };
}

/** REQ-06/07: accepting holds one unit of the creator's active-order limit for the order's checkout TTL. */
const acceptOffer: CommandHandler = async ({ tx, actor, form }) => {
  const { offer, request } = await lockOffer(tx, form);
  if (String(offer.creator_id) !== actor.id) throw new CommandError('Offer not found or not visible to this account', 'NOT_FOUND');
  if (offer.status !== 'OFFERED') throw new CommandError(`This offer is ${String(offer.status).toLowerCase()}`, 'ORDER_STATE_CONFLICT');
  if (new Date(offer.expires_at) <= new Date()) throw new CommandError('This offer has expired', 'QUOTE_EXPIRED');
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot accept new work', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['REQUESTS_ENABLED', 'CHECKOUT_CREATION_ENABLED']);
  const terms = offer.terms_snapshot as Record<string, unknown>;
  const capacityPlan = { model: 'ACTIVE_ORDERS', units: 1 };
  const campaignPool = await poolTermsFor(tx, String(request.id));
  const orderTerms = { ...terms, offer_id: String(offer.id), capacity: capacityPlan,
    ...(campaignPool ? { pool: { pool_id: campaignPool.poolId, template_version: campaignPool.templateVersion, rewards: campaignPool.items } } : {}) };
  const [order] = await tx<Row[]>`insert into app.orders (buyer_id,creator_id,service_id,source,source_ref,title,status,amount_minor,platform_fee_minor,currency,brief,brief_ready_at,terms,delivery_due_at)
    values (${String(offer.buyer_id)},${actor.id},${null},'REQUEST',${String(request.id)},${String(terms.title)},'AWAITING_PAYMENT',${String(offer.amount_minor)},0,'USD',
      ${String(terms.scope)},now(),${JSON.stringify(orderTerms)}::jsonb,null) returning id`;
  const orderId = String(order!.id);
  await claimWorkload(tx, { creatorId: actor.id, units: capacityPlan.units, origin: 'OFFER', orderId, expiresAt: new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60_000) });
  await tx`update app.hire_offers set status='ACCEPTED',order_id=${orderId},capacity_plan_snapshot=${JSON.stringify(capacityPlan)}::jsonb,responded_at=now() where id=${String(offer.id)}`;
  await tx`update app.request_budget_reservations set order_id=${orderId},updated_at=now() where offer_id=${String(offer.id)} and state='HELD'`;
  await tx`update app.applications set status='ACCEPTED',updated_at=now() where id=${String(offer.application_id)}`;
  await orderEvent(tx, orderId, actor.id, 'ORDER_CREATED', { source: 'REQUEST', request_id: String(request.id), offer_id: String(offer.id), platform_fee_minor: '0' });
  // Pool-backed request: allocate every required reward atomically and fund the order from it (no buyer checkout).
  const allocation = await allocateHire(tx, { requestId: String(request.id), orderId, offerAmountMinor: BigInt(String(offer.amount_minor)), creatorId: actor.id });
  if (allocation) {
    await applyPoolFunding(tx, { orderId, poolId: allocation.poolId, cashMinor: allocation.cashMinor, templateVersion: allocation.templateVersion });
    const skipped = allocation.skippedOptional.length ? ` Optional rewards not available: ${allocation.skippedOptional.join(', ')}.` : '';
    return { path: `/orders/${orderId}`, message: `Offer accepted and funded from the campaign pool.${skipped}`, id: orderId };
  }
  return { path: `/orders/${orderId}`, message: 'Offer accepted. The buyer can now fund this hire.', id: orderId };
};

const declineOffer: CommandHandler = async ({ tx, actor, form, command }) => {
  const { offer, request } = await lockOffer(tx, form);
  const buyerWithdraws = command === 'withdraw_offer';
  if (String(buyerWithdraws ? offer.buyer_id : offer.creator_id) !== actor.id) throw new CommandError('Offer not found or not visible to this account', 'NOT_FOUND');
  if (offer.status !== 'OFFERED') throw new CommandError(`This offer is ${String(offer.status).toLowerCase()}`, 'ORDER_STATE_CONFLICT');
  const reason = text(form, 'reason', false, 1000) || null;
  await tx`update app.hire_offers set status=${buyerWithdraws ? 'WITHDRAWN' : 'DECLINED'},response_reason=${reason},responded_at=now() where id=${String(offer.id)}`;
  await tx`update app.request_budget_reservations set state='RELEASED',updated_at=now() where offer_id=${String(offer.id)} and state='HELD'`;
  await tx`update app.applications set status=${buyerWithdraws ? 'SUBMITTED' : 'DECLINED'},updated_at=now() where id=${String(offer.application_id)}`;
  return done(String(request.id), buyerWithdraws ? 'Offer withdrawn' : 'Offer declined');
};

export const requestCommands: Record<string, CommandHandler> = {
  create_request: createRequest,
  update_request: updateRequest,
  set_request_images: setRequestImages,
  close_request: closeRequest,
  cancel_request: closeRequest,
  apply,
  withdraw_application: withdrawApplication,
  select_application: selectApplication,
  accept_offer: acceptOffer,
  decline_offer: declineOffer,
  withdraw_offer: declineOffer,
};
