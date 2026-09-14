/**
 * Requests v2 (master §9, P2): versioned private quotes, buyer selection as a 24-hour HireOffer that holds request
 * budget and hire count, creator confirmation with an explicit capacity pool, then a canonical order per hire.
 *
 * Lock order: request → offer → application → capacity pool/bucket. Budget and hire totals are also enforced by
 * CHECK constraints on counters maintained by triggers (drizzle/0007).
 */
import { CommandError, expectedVersion, instant, integer, money, orderEvent, text, uuid, type CommandHandler, type Row, type Tx } from '@/lib/commands';
import type { Actor } from '@/lib/auth';
import { claimWorkload } from '@/modules/capacity';
import { CHECKOUT_HOLD_MINUTES } from '@/modules/catalog/commands';
import { assertFlags } from '@/modules/admin/policy';
import { enqueueNotification } from '@/modules/notifications/enqueue';
import { applyPoolFunding } from '@/modules/payments/funding';
import { allocateHire, poolTermsFor } from '@/modules/pools/service';

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

function deadlines(form: FormData, existing?: Row) {
  const deadline = text(form, 'deadline', !existing) ? instant(text(form, 'deadline'), 'deadline') : new Date(existing!.deadline);
  const applicationValue = text(form, 'application_deadline', false);
  const applicationDeadline = applicationValue ? instant(applicationValue, 'application_deadline') : existing ? new Date(existing.application_deadline) : deadline;
  if (applicationDeadline > deadline) throw new CommandError('Applications must close on or before the delivery deadline');
  return { deadline, applicationDeadline };
}

const createRequest: CommandHandler = async ({ tx, actor, form }) => {
  if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot publish requests', 'ACCOUNT_SUSPENDED');
  await assertFlags(tx, ['REQUESTS_ENABLED']);
  const title = text(form, 'title', true, 160);
  const brief = text(form, 'brief', true, 12000);
  const taxonomy = text(form, 'taxonomy');
  if (!TAXONOMIES.includes(taxonomy)) throw new CommandError('Unsupported request category');
  const { budget, cap, target } = budgetFields(form);
  const { deadline, applicationDeadline } = deadlines(form);
  if (applicationDeadline <= new Date()) throw new CommandError('Deadlines must be in the future');
  const [request] = await tx<Row[]>`insert into app.requests (buyer_id,title,brief,taxonomy,budget_minor,per_creator_cap_minor,target_hires,deadline,application_deadline)
    values (${actor.id},${title},${brief},${taxonomy},${budget.toString()},${cap?.toString() ?? null},${target},${deadline.toISOString()},${applicationDeadline.toISOString()}) returning id`;
  return done(String(request!.id), 'Brief published. Creators can now apply.', String(request!.id));
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
  const held = BigInt(request.reserved_minor) + BigInt(request.committed_minor);
  const hires = Number(request.reserved_hires) + Number(request.committed_hires);
  if (budget < held || target < hires) {
    throw new CommandError(`Budget and hires cannot go below current offers and hires (${hires} hires holding ${held} minor units)`, 'BUDGET_EXCEEDED');
  }
  await guardBudget(tx`update app.requests set title=${title},brief=${brief},budget_minor=${budget.toString()},per_creator_cap_minor=${cap?.toString() ?? null},
    target_hires=${target},deadline=${deadline.toISOString()},application_deadline=${applicationDeadline.toISOString()},
    status=case when status='FILLED' and committed_hires < ${target} then 'OPEN' when status='OPEN' and committed_hires >= ${target} then 'FILLED' else status end,
    version=version+1,updated_at=now() where id=${requestId}`);
  return done(requestId, 'Request updated. Existing offers keep their terms.');
};

async function withdrawOpenOffers(tx: Tx, requestId: string, reason: string) {
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
  const samples = await tx<Row[]>`select id,title,url,storage_asset_id from app.samples where creator_id=${actor.id} and visibility='PUBLIC' and moderation_status='APPROVED'
    order by created_at desc limit 5`;
  const snapshot = JSON.stringify(samples.map((s) => ({ id: String(s.id), title: s.title, url: s.url ?? null, asset_id: s.storage_asset_id ?? null })));
  const [existing] = await tx<Row[]>`select * from app.applications where request_id=${requestId} and creator_id=${actor.id} for update`;
  if (existing && ['OFFERED', 'ACCEPTED'].includes(String(existing.status))) {
    throw new CommandError('Your application has an offer in progress and cannot be edited', 'ORDER_STATE_CONFLICT');
  }
  const [application] = existing
    ? await tx<Row[]>`update app.applications set quote_minor=${quote.toString()},turnaround_hours=${turnaround},note=${note},status='SUBMITTED',
        valid_until=now() + (${validDays} * interval '1 day'),samples_snapshot=${snapshot}::jsonb,version=version+1,updated_at=now()
        where id=${String(existing.id)} returning *`
    : await tx<Row[]>`insert into app.applications (request_id,creator_id,quote_minor,turnaround_hours,note,status,valid_until,samples_snapshot)
        values (${requestId},${actor.id},${quote.toString()},${turnaround},${note},'SUBMITTED',now() + (${validDays} * interval '1 day'),${snapshot}::jsonb) returning *`;
  await tx`insert into app.application_versions (application_id,version,quote_minor,turnaround_hours,note,valid_until,samples_snapshot)
    values (${String(application!.id)},${application!.version},${application!.quote_minor},${turnaround},${note},${application!.valid_until},${snapshot}::jsonb)`;
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
  const amount = BigInt(application!.quote_minor);
  const pool = await poolTermsFor(tx, String(request.id));
  if (pool && pool.cashMinor !== amount) throw new CommandError('The pool reward changed since this application; the creator must re-apply', 'QUOTE_CHANGED');
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
  const capacityPlan = { model: 'ACTIVE_ORDER_LIMIT', units: 1 };
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
  close_request: closeRequest,
  cancel_request: closeRequest,
  apply,
  withdraw_application: withdrawApplication,
  select_application: selectApplication,
  accept_offer: acceptOffer,
  decline_offer: declineOffer,
  withdraw_offer: declineOffer,
};
