import { sql } from './db';
import { formatAtomic, usdMinorToAtomic } from '@/modules/crypto/registry';
import type { Actor } from './auth';
import { availabilityOf, workloadsFor } from '@/modules/capacity';
import { digitalAvailability, downloadableReleases } from '@/modules/digital';
import { isFlagEnabled } from '@/modules/admin/policy';
import { CommandError } from './commands';
import { parseServiceSearch, toPrefixQuery } from '@/modules/discovery/params';
import { searchServices } from '@/modules/discovery/search';

export type ReadRow = Record<string, unknown>;
const asRows = (value: unknown): ReadRow[] => Array.isArray(value) ? value as ReadRow[] : [];

const SERVICE_COLUMNS_OWNER = sql`s.id,s.title,s.description,s.taxonomy,s.price_minor,s.currency,s.turnaround_hours,s.revision_limit,s.units_per_order,s.status,s.version,s.creator_id,s.published_version_id as service_version_id,s.publish_account_id,s.publish_format,s.min_live_hours,s.disclosure_text,s.access_session_minutes,s.digital_license,s.digital_rights_text,s.digital_stock,s.digital_updates,s.digital_download_limit`;
// Public views always show the published immutable version's terms, never unpublished edits.
const SERVICE_COLUMNS_PUBLIC = sql`s.id,v.title,v.description,v.taxonomy,v.price_minor,v.currency,v.turnaround_hours,v.revision_limit,v.units_per_order,s.status,s.version,s.creator_id,v.id as service_version_id,v.version as service_version,v.publish_platform,v.publish_handle,v.publish_url,v.publish_format,v.min_live_hours,v.disclosure_text,v.access_session_minutes,v.digital_license,v.digital_rights_text,v.digital_stock,v.digital_updates,v.digital_download_limit`;

/**
 * Buyers see a status only, never counts: ACCEPTING or PAUSED (SOLD_OUT for DIGITAL). There is no limit on orders
 * at once (drizzle/0017). The creator's own numbers come from getDashboardData().workload.
 */
async function withAvailability(rows: ReadRow[]): Promise<ReadRow[]> {
  const workloads = await workloadsFor(sql, rows.map((row) => String(row.creator_id)));
  // DIGITAL listings use no creator capacity: they are available until their stock or exclusive license is taken.
  const stock = await digitalAvailability(sql, rows.filter((row) => row.taxonomy === 'DIGITAL').map((row) => String(row.id)));
  return rows.map((row) => ({ ...row, availability_status: row.taxonomy === 'DIGITAL' ? stock.get(String(row.id)) ?? 'ACCEPTING' : availabilityOf(workloads.get(String(row.creator_id))) }));
}

async function serviceRows(options: { ownerId?: string; publicCreatorId?: string } = {}) {
  const actorId = options.ownerId;
  const services = actorId
    ? await sql`select ${SERVICE_COLUMNS_OWNER},u.display_name as creator_name,p.handle,p.niche,p.avatar_color,p.avatar_asset_id
        from app.services s join app.users u on u.id=s.creator_id left join app.profiles p on p.user_id=s.creator_id
        where s.creator_id=${actorId} order by s.created_at desc`
    : await sql`select ${SERVICE_COLUMNS_PUBLIC},u.display_name as creator_name,p.handle,p.niche,p.avatar_color,p.avatar_asset_id
        from app.services s join app.service_versions v on v.id=s.published_version_id join app.users u on u.id=s.creator_id
        left join app.profiles p on p.user_id=s.creator_id
        where s.status='PUBLISHED' and u.status='ACTIVE' and (${options.publicCreatorId ?? null}::uuid is null or s.creator_id=${options.publicCreatorId ?? null}::uuid)
        order by s.created_at desc`;
  // Samples linked to each listed service (service_samples), newest first and capped, instead of every creator sample.
  const serviceIds = asRows(services).map((service) => String(service.id));
  const samples = serviceIds.length ? await sql`select service_id,id,creator_id,title,url,description,visibility,moderation_status,created_at from (
      select ss.service_id,sm.*,row_number() over (partition by ss.service_id order by sm.created_at desc) as rank
      from app.service_samples ss join app.samples sm on sm.id=ss.sample_id
      where ss.service_id = any(${serviceIds}::uuid[]) and (${actorId ?? null}::uuid is not null or (sm.visibility='PUBLIC' and sm.moderation_status='APPROVED'))
    ) ranked where rank <= 6` : [];
  const sampleMap = new Map<string, ReadRow[]>();
  for (const sample of asRows(samples)) {
    const key = String(sample.service_id);
    const current = sampleMap.get(key) ?? [];
    current.push(sample);
    sampleMap.set(key, current);
  }
  // The owner sees each DIGITAL product's releases and how many licenses are live.
  const digitalIds = actorId ? asRows(services).filter((service) => service.taxonomy === 'DIGITAL').map((service) => String(service.id)) : [];
  const releases = digitalIds.length ? asRows(await sql`select r.service_id,r.version,r.notes,r.created_at,a.filename,a.size_bytes from app.digital_releases r
    join app.storage_assets a on a.id=r.asset_id where r.service_id = any(${digitalIds}::uuid[]) order by r.version desc`) : [];
  const sales = digitalIds.length ? asRows(await sql`select service_id,count(*) filter (where state='ACTIVE')::int as active,count(*) filter (where state in ('HELD','EXPIRY_RECONCILING'))::int as held
    from app.digital_entitlements where service_id = any(${digitalIds}::uuid[]) group by service_id`) : [];
  const rows = asRows(services).map((service): ReadRow => ({
    ...service,
    samples: sampleMap.get(String(service.id)) ?? [],
    ...(service.taxonomy === 'DIGITAL' && actorId ? {
      releases: releases.filter((r) => String(r.service_id) === String(service.id)),
      licenses: sales.find((s) => String(s.service_id) === String(service.id)) ?? { active: 0, held: 0 },
    } : {}),
  }));
  return withAvailability(rows);
}

export async function getPublicData(options: { q?: string; category?: string; goal?: string | null } = {}) {
  const [allServices, allRequests, auctions] = await Promise.all([
    serviceRows(),
    sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.campaign_goal,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.status,r.application_deadline,u.display_name as buyer_name,(select count(*) from app.applications a where a.request_id=r.id) as application_count,coalesce((select array_agg(i.asset_id order by i.position) from app.request_images i where i.request_id=r.id),'{}') as image_ids,coalesce((select array_agg(coalesce(i.thumb_asset_id,i.asset_id) order by i.position) from app.request_images i where i.request_id=r.id),'{}') as thumb_ids from app.requests r join app.users u on u.id=r.buyer_id where r.status='OPEN' and r.application_deadline>now() order by r.application_deadline asc`,
    sql`select a.id,a.service_id,a.seller_id,s.title,u.display_name as creator_name,a.starting_price_minor,a.current_price_minor,a.minimum_increment_minor,a.buy_now_price_minor,a.ends_at,a.starts_at,a.status,a.bid_count,a.winner_id from app.auctions a join app.services s on s.id=a.service_id join app.users u on u.id=a.seller_id where a.status in ('SCHEDULED','LIVE') and a.ends_at>now() order by a.ends_at asc`,
  ]);
  const q = options.q?.trim().toLowerCase();
  const category = options.category?.trim().toUpperCase();
  const services = allServices.filter((service) => {
    const matchesCategory = !category || String(service.taxonomy) === category;
    const haystack = `${service.title} ${service.description} ${service.creator_name} ${service.niche}`.toLowerCase();
    return matchesCategory && (!q || haystack.includes(q));
  });
  // Campaigns browse by goal; the counts cover every open campaign so the goal choices can say how many each holds.
  const openRequests = asRows(allRequests);
  const goalCounts: Record<string, number> = {};
  for (const request of openRequests) if (request.campaign_goal) goalCounts[String(request.campaign_goal)] = (goalCounts[String(request.campaign_goal)] ?? 0) + 1;
  const requests = options.goal ? openRequests.filter((request) => request.campaign_goal === options.goal) : openRequests;
  return { services, requests, request_total: openRequests.length, goal_counts: goalCounts, auctions: asRows(auctions) };
}

/**
 * One campaign tab: its open campaigns, campaigns of the same goal that recently filled or closed, and published
 * services of the category the goal usually needs, so the tab shows who could take the work even when nothing is open.
 */
export async function getGoalPageData(goal: string, taxonomy: string) {
  const [publicData, recent] = await Promise.all([
    getPublicData({ goal }),
    sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.campaign_goal,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.status,r.application_deadline,
        u.display_name as buyer_name,(select count(*) from app.applications a where a.request_id=r.id) as application_count,
        coalesce((select array_agg(i.asset_id order by i.position) from app.request_images i where i.request_id=r.id),'{}') as image_ids,
        coalesce((select array_agg(coalesce(i.thumb_asset_id,i.asset_id) order by i.position) from app.request_images i where i.request_id=r.id),'{}') as thumb_ids
      from app.requests r join app.users u on u.id=r.buyer_id
      where r.campaign_goal=${goal} and r.status in ('FILLED','CLOSED') order by r.updated_at desc limit 3`,
  ]);
  const creators = publicData.services.filter((service) => String(service.taxonomy) === taxonomy).slice(0, 3);
  return { requests: publicData.requests, request_total: publicData.request_total, goal_counts: publicData.goal_counts, recent: asRows(recent), creators };
}

export async function getDashboardData(actor: Actor) {
  const [services, orders, applications, requests, auctions, profile, stats] = await Promise.all([
    serviceRows({ ownerId: actor.id }),
    sql`select o.id,o.buyer_id,o.creator_id,o.service_id,o.source,o.title,o.status,o.amount_minor,o.platform_fee_minor,o.provider_fee_minor,o.currency,o.brief,o.delivery_due_at,o.review_due_at,o.revision_count,o.version,o.buyer_name,o.creator_name,o.settlement_status,o.payment_status,o.created_at from (select o.*,bu.display_name as buyer_name,cu.display_name as creator_name from app.orders o join app.users bu on bu.id=o.buyer_id join app.users cu on cu.id=o.creator_id) o where o.buyer_id=${actor.id} or o.creator_id=${actor.id} order by o.created_at desc`,
    sql`select a.id,a.request_id,a.creator_id,r.title as request_title,a.quote_minor,a.status,a.note,a.version,a.valid_until,cu.display_name as creator_name,
      o.id as offer_id,o.status as offer_status,o.expires_at as offer_expires_at,o.amount_minor as offer_amount_minor,o.order_id as offer_order_id
      from app.applications a join app.requests r on r.id=a.request_id join app.users cu on cu.id=a.creator_id
      left join lateral (select * from app.hire_offers h where h.application_id=a.id order by h.created_at desc limit 1) o on true
      where a.creator_id=${actor.id} order by a.created_at desc`,
    sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.campaign_goal,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.status,r.application_deadline,u.display_name as buyer_name,(select count(*) from app.applications a where a.request_id=r.id) as application_count,coalesce((select array_agg(i.asset_id order by i.position) from app.request_images i where i.request_id=r.id),'{}') as image_ids,coalesce((select array_agg(coalesce(i.thumb_asset_id,i.asset_id) order by i.position) from app.request_images i where i.request_id=r.id),'{}') as thumb_ids from app.requests r join app.users u on u.id=r.buyer_id where r.buyer_id=${actor.id} order by r.created_at desc`,
    sql`select a.id,a.service_id,a.seller_id,s.title,u.display_name as creator_name,a.starting_price_minor,a.current_price_minor,a.minimum_increment_minor,a.buy_now_price_minor,a.ends_at,a.starts_at,a.status,a.bid_count,a.winner_id from app.auctions a join app.services s on s.id=a.service_id join app.users u on u.id=a.seller_id where a.seller_id=${actor.id} order by a.created_at desc`,
    sql`select p.handle,p.bio,p.niche,p.avatar_color,p.avatar_asset_id,p.headline,p.location,p.languages,p.social_url,u.display_name,u.email,
      (select count(*)::int from app.samples s where s.creator_id=u.id and s.visibility='PUBLIC' and s.moderation_status='APPROVED') as public_samples,
      coalesce((select json_agg(json_build_object('id',a.id,'platform',a.platform,'handle',a.handle,'url',a.canonical_url,'verification_status',a.verification_status) order by a.created_at)
        from app.social_accounts a where a.creator_id=u.id and a.removed_at is null),'[]') as social_accounts
      from app.users u left join app.profiles p on p.user_id=u.id where u.id=${actor.id}`,
    sql`select count(*) filter (where (buyer_id=${actor.id} or creator_id=${actor.id}) and status='COMPLETED') as completed_orders,count(*) filter (where (buyer_id=${actor.id} or creator_id=${actor.id}) and status not in ('COMPLETED','CANCELLED','REFUNDED')) as active_orders,coalesce(sum(amount_minor) filter (where buyer_id=${actor.id}),0) as gross_minor,coalesce(sum(amount_minor) filter (where creator_id=${actor.id} and status='COMPLETED'),0) as sales_minor,coalesce(sum(amount_minor) filter (where buyer_id=${actor.id} and funded_at is not null and status not in ('CANCELLED','REFUNDED')),0) as funded_minor,coalesce(sum(platform_fee_minor) filter (where buyer_id=${actor.id}),0) as platform_fee_minor from app.orders where buyer_id=${actor.id} or creator_id=${actor.id}`,
  ]);
  const [profileRow] = asRows(profile);
  const [statsRow] = asRows(stats);
  const serviceList = asRows(services);
  const workload = (await workloadsFor(sql, [actor.id])).get(actor.id)!;
  const inFlight = Number(workload.held_units) + Number(workload.active_units);
  return { orders: asRows(orders), services: serviceList, applications: asRows(applications), requests: asRows(requests), auctions: asRows(auctions), profile: profileRow ?? {}, stats: statsRow ?? {},
    workload: { ...workload, in_flight_units: inFlight, availability_status: availabilityOf(workload) } };
}

export async function getOrderData(actor: Actor, id: string) {
  const [order] = asRows(await sql`select o.id,o.buyer_id,o.creator_id,o.service_id,o.service_version_id,o.source,o.title,o.status,o.amount_minor,o.platform_fee_minor,o.provider_fee_minor,
      o.currency,o.brief,o.terms,o.brief_ready_at,o.funded_at,o.work_start_at,o.delivery_due_at,o.review_due_at,o.revision_due_at,o.revision_count,o.approved_at,o.completed_at,
      o.cancelled_at,o.cancellation_refund_minor,o.performance_refund_minor,o.status_before_dispute,o.version,o.settlement_status,o.payment_status,o.payment_rail,o.funding_method,o.created_at,
      bu.display_name as buyer_name,cu.display_name as creator_name
    from app.orders o join app.users bu on bu.id=o.buyer_id join app.users cu on cu.id=o.creator_id
    where o.id=${id} and (o.buyer_id=${actor.id} or o.creator_id=${actor.id})`);
  if (!order) return null;
  const [deliveries, events, messages, reviews, cancellations, holds, assets, proofs, amendments] = await Promise.all([
    sql`select id,order_id,body,url,version,validation_status,buyer_viewed_at,created_at from app.deliveries where order_id=${id} order by version desc`,
    sql`select id,kind,payload,created_at from app.order_events where order_id=${id} order by created_at asc`,
    sql`select m.id,m.body,m.created_at,u.display_name from app.messages m join app.users u on u.id=m.sender_id where m.order_id=${id} order by m.created_at asc`,
    sql`select rating,body,reviewer_id,created_at from app.reviews where order_id=${id} order by created_at desc`,
    sql`select id,requested_by,counterparty_id,reason,refund_amount_minor,status,created_at,responded_at from app.cancellation_requests where order_id=${id} order by created_at desc`,
    sql`select reason,created_at,resolved_at,resolution from app.review_holds where order_id=${id} order by created_at desc`,
    sql`select a.id,a.purpose,a.owner_id,a.filename,a.mime,a.size_bytes,a.lifecycle_state,a.created_at,
        coalesce(json_agg(json_build_object('delivery_id',da.delivery_id,'position',da.position)) filter (where da.delivery_id is not null),'[]') as attachments
      from app.storage_assets a left join app.delivery_assets da on da.asset_id=a.id
      where a.order_id=${id} and a.lifecycle_state <> 'DELETED' group by a.id order by a.created_at`,
    sql`select p.id,p.delivery_id,d.version as delivery_version,p.platform,p.channel_url,p.post_url,p.post_id,p.published_at,p.disclosure_text,p.disclosure_attested,p.link_check,p.late,p.created_at
      from app.publish_proofs p join app.deliveries d on d.id=p.delivery_id where p.order_id=${id} order by d.version desc`,
    sql`select a.id,a.deadline,a.proposed_by,a.counterparty_id,u.display_name as proposed_by_name,a.reason,a.old_due_at,a.new_due_at,a.status,a.created_at,a.responded_at
      from app.order_amendments a join app.users u on u.id=a.proposed_by where a.order_id=${id} order by a.created_at desc`,
  ]);
  const isBuyer = actor.id === String(order.buyer_id);
  // XPL-06: the buyer sees which releases their license includes; files are fetched only through the entitlement route.
  const [entitlement] = asRows(await sql`select * from app.digital_entitlements where order_id=${id}`);
  const digital = entitlement ? {
    entitlement: { id: entitlement.id, state: entitlement.state, license: entitlement.license, release_version: entitlement.release_version, updates_policy: entitlement.updates_policy,
      download_limit: entitlement.download_limit, download_count: entitlement.download_count, first_downloaded_at: entitlement.first_downloaded_at },
    releases: (await downloadableReleases(sql, entitlement)).map((r) => ({ version: r.version, notes: r.notes, created_at: r.created_at, filename: r.filename, size_bytes: r.size_bytes, available: r.lifecycle_state === 'READY' })),
  } : null;
  // Crypto checkout (W5-C1): the buyer sees their latest intent; both parties see how the order was paid.
  const [cryptoIntent] = isBuyer ? asRows(await sql`select i.id,i.status,i.status_reason,i.chain_id,i.network_mode,i.amount_atomic,i.recipient,i.reference,i.escrow_ref,i.expires_at,
      a.symbol,a.decimals,a.kind as asset_kind,a.contract_address as token_address,n.name as network_name,
      (select json_build_object('tx_hash',d.tx_hash,'status',d.status,'reason',d.reason) from app.chain_deposits d where d.intent_id=i.id order by d.created_at desc limit 1) as last_deposit
    from app.crypto_payment_intents i join app.chain_assets a on a.id=i.asset_id join app.chain_networks n on n.chain_id=i.chain_id
    where i.order_id=${id} order by i.created_at desc limit 1`) : [];
  const cryptoEnabled = isBuyer && order.status === 'AWAITING_PAYMENT' && (await sql`select enabled from app.feature_flags where key='CRYPTO_CHECKOUT_ENABLED'`)[0]?.enabled === true;
  const cryptoOptions = cryptoEnabled ? asRows(await sql`select a.id as asset_id,a.symbol,a.decimals,a.kind,n.chain_id,n.name as network_name,n.mode
    from app.chain_assets a join app.chain_networks n on n.chain_id=a.chain_id
    where n.enabled and a.usd_pegged and a.allowlisted and n.mode in ('LOCAL','TESTNET') ${process.env.NODE_ENV === 'production' ? sql`and n.mode <> 'LOCAL'` : sql``}
    order by n.chain_id, (a.kind='NATIVE') desc`) : [];
  const [paymentConfirmed] = asRows(await sql`select payload from app.order_events where order_id=${id} and kind='PAYMENT_CONFIRMED' order by created_at desc limit 1`);
  // §9.6: the checkpoint and what it measured, for a performance hire.
  const [performanceMeasurement] = asRows(await sql`select * from app.performance_measurements where order_id=${id}`);
  // BNK-01: the buyer sees whether bank transfer is offered and their latest transfer with its reservation.
  const bankTransfer = isBuyer ? await (async () => {
    const [op] = asRows(await sql`select provider_reference,outcome->>'fundingStatus' as funding_status from app.provider_operations
      where order_id=${id} and kind='funding.create' and outcome->>'method'='BANK_TRANSFER' and provider_reference is not null order by created_at desc limit 1`);
    const [hold] = asRows(await sql`select expires_at from app.workload_claims where order_id=${id} and state in ('HELD','EXPIRY_RECONCILING')
      union all select expires_at from app.digital_entitlements where order_id=${id} and state in ('HELD','EXPIRY_RECONCILING')`);
    return { enabled: order.status === 'AWAITING_PAYMENT' && await isFlagEnabled(sql, 'BANK_FUNDING_ENABLED'), reference: op?.provider_reference ?? null, funding_status: op?.funding_status ?? null, hold_until: hold?.expires_at ?? null };
  })() : null;
  // Unattached delivery uploads stay private to their uploader until they are part of a submitted delivery.
  const files = asRows(assets).filter((file) => file.purpose !== 'DELIVERY' || String(file.owner_id) === actor.id || (file.attachments as unknown[]).length > 0);
  const terms = (order.terms ?? {}) as Record<string, unknown>;
  const latest = asRows(deliveries)[0];
  return {
    order: { ...order, revision_limit: Number(terms.revision_limit ?? 1), review_window_hours: Number(terms.review_window_hours ?? 72), auto_accept_consent: terms.auto_accept_consent === true } as ReadRow,
    latest_delivery_version: latest ? Number(latest.version) : null,
    deliveries: asRows(deliveries),
    publish_terms: terms.publish ?? null,
    performance_terms: terms.performance ?? null,
    performance_measurement: performanceMeasurement ?? null,
    publish_proofs: asRows(proofs),
    digital,
    events: asRows(events),
    messages: asRows(messages),
    reviews: asRows(reviews),
    cancellation_requests: asRows(cancellations),
    active_cancellation_request: asRows(cancellations).find((c) => c.status === 'REQUESTED') ?? null,
    // ORD-12: agreed deadline changes, newest first, and the proposal waiting for an answer.
    amendments: asRows(amendments),
    active_amendment: asRows(amendments).find((a) => a.status === 'REQUESTED') ?? null,
    active_review_hold: asRows(holds).find((h) => h.resolved_at === null) ?? null,
    files,
    payment_receipt: paymentConfirmed ? paymentConfirmed.payload : null,
    bank_transfer: bankTransfer,
    crypto_payment: cryptoIntent ? { ...cryptoIntent, amount_display: formatAtomic(BigInt(String(cryptoIntent.amount_atomic)), Number(cryptoIntent.decimals)) } : null,
    crypto_options: cryptoOptions.map((option) => ({ ...option, amount_display: formatAtomic(usdMinorToAtomic(BigInt(String(order.amount_minor)), Number(option.decimals)), Number(option.decimals)) })),
  };
}

export async function getServiceData(id: string) {
  const rows = asRows(await sql`select ${SERVICE_COLUMNS_PUBLIC},u.display_name as creator_name,p.handle,p.bio,p.niche,p.avatar_color,p.avatar_asset_id,p.headline,p.location,p.languages
    from app.services s join app.service_versions v on v.id=s.published_version_id join app.users u on u.id=s.creator_id
    left join app.profiles p on p.user_id=s.creator_id where s.id=${id} and s.status='PUBLISHED' and u.status='ACTIVE'`);
  if (!rows[0]) return null;
  const [service] = await withAvailability(rows);
  const [latestRelease] = service!.taxonomy === 'DIGITAL' ? asRows(await sql`select version,created_at from app.digital_releases where service_id=${id} order by version desc limit 1`) : [];
  const digitalInfo = service!.taxonomy === 'DIGITAL' ? { latest_version: latestRelease?.version ?? null, updated_at: latestRelease?.created_at ?? null, purchases_enabled: await isFlagEnabled(sql, 'DIGITAL_PRODUCTS_ENABLED') } : null;
  // The service page shows the samples the creator linked to this service (service_samples), not their whole portfolio.
  const samples = await sql`select sm.id,sm.creator_id,sm.title,sm.url,sm.description,sm.created_at from app.service_samples ss join app.samples sm on sm.id=ss.sample_id
    where ss.service_id=${id} and sm.visibility='PUBLIC' and sm.moderation_status='APPROVED' order by sm.created_at desc limit 12`;
  return { service: service!, digital: digitalInfo, creator: { id: service!.creator_id, display_name: service!.creator_name, bio: service!.bio, niche: service!.niche, handle: service!.handle, avatar_color: service!.avatar_color, avatar_asset_id: service!.avatar_asset_id, headline: service!.headline }, samples: asRows(samples) };
}

export async function getCreatorData(handle: string) {
  const [creator] = asRows(await sql`select u.id,u.display_name,p.handle,p.bio,p.niche,p.avatar_color,p.avatar_asset_id,p.headline,p.location,p.languages,(select count(*) from app.orders o where o.creator_id=u.id and o.status='COMPLETED') as completed_jobs,(select round(avg(r.rating)::numeric,1) from app.reviews r where r.creator_id=u.id) as rating,(select count(*) from app.services s where s.creator_id=u.id and s.status='PUBLISHED') as services_count from app.users u join app.profiles p on p.user_id=u.id where p.handle=${handle} and u.status='ACTIVE'`);
  if (!creator) return null;
  const [services, samples, socialAccounts] = await Promise.all([
    serviceRows({ publicCreatorId: String(creator.id) }),
    sql`select id,creator_id,title,url,description,created_at from app.samples where creator_id=${String(creator.id)} and visibility='PUBLIC' and moderation_status='APPROVED' order by created_at desc limit 24`,
    // XPL-01: every link is shown with its verification status; manual links read "Self-reported".
    sql`select id,platform,handle,canonical_url as url,verification_status from app.social_accounts where creator_id=${String(creator.id)} and removed_at is null order by created_at`,
  ]);
  return { creator, services, samples: asRows(samples), social_accounts: asRows(socialAccounts) };
}

export async function getRequestData(actor: Actor | null, id: string) {
  const [request] = asRows(await sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.campaign_goal,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.application_deadline,
      r.status,r.version,r.currency,r.reserved_minor,r.committed_minor,r.reserved_hires,r.committed_hires,u.display_name as buyer_name,
      r.publish_platform,r.publish_format,r.min_live_hours,r.disclosure_text,r.access_session_minutes,r.license_kind,r.license_rights_text,
      r.payment_model,r.base_fee_minor,r.rpm_rate_minor,r.bonus_cap_minor,r.measure_after_days,r.verify_days,r.median_multiplier,
      coalesce((select array_agg(i.asset_id order by i.position) from app.request_images i where i.request_id=r.id),'{}') as image_ids,
      (select count(*) from app.applications a where a.request_id=r.id and a.status <> 'WITHDRAWN')::int as application_count
    from app.requests r join app.users u on u.id=r.buyer_id where r.id=${id} and (r.status in ('OPEN','FILLED','CLOSED') or r.buyer_id=${actor?.id ?? null})`);
  if (!request) return null;
  const owner = !!actor && actor.id === String(request.buyer_id);
  // REQ-03: a creator reads only their own application and offer; the buyer reads all. Anonymous readers see none.
  const applications = actor
    ? await sql`select a.id,a.creator_id,a.quote_minor,a.note,a.status,a.turnaround_hours,a.version,a.valid_until,a.samples_snapshot,a.created_at,a.updated_at,a.publish_account_id,
          u.display_name as creator_name,p.handle as creator_handle,
          sa.platform as publish_platform,sa.handle as publish_handle,sa.canonical_url as publish_url,sa.verification_status as publish_verification,
          o.id as offer_id,o.status as offer_status,o.expires_at as offer_expires_at,o.amount_minor as offer_amount_minor,o.order_id as offer_order_id
        from app.applications a join app.users u on u.id=a.creator_id left join app.profiles p on p.user_id=a.creator_id
        left join app.social_accounts sa on sa.id=a.publish_account_id
        left join lateral (select * from app.hire_offers h where h.application_id=a.id order by h.created_at desc limit 1) o on true
        where a.request_id=${id} and (a.creator_id=${actor.id} or ${owner}) order by a.created_at asc`
    : [];
  // §9.4 campaign view for the buyer: each hire keeps its own order, payment and status.
  const hires = owner
    ? await sql`select h.id as offer_id,h.status as offer_status,h.amount_minor,h.expires_at,h.order_id,u.display_name as creator_name,
          ord.status as order_status,ord.payment_status,ord.settlement_status,ord.delivery_due_at,b.state as budget_state
        from app.hire_offers h join app.users u on u.id=h.creator_id left join app.orders ord on ord.id=h.order_id
        left join app.request_budget_reservations b on b.offer_id=h.id where h.request_id=${id} order by h.created_at asc`
    : [];
  const hireRows = asRows(hires);
  const sum = (predicate: (row: ReadRow) => boolean) => hireRows.filter(predicate).reduce((total, row) => total + BigInt(String(row.amount_minor)), 0n).toString();
  const campaign = owner ? {
    budget_minor: request.budget_minor,
    offered_minor: sum((h) => h.offer_status === 'OFFERED'),
    awaiting_payment_minor: sum((h) => h.offer_status === 'ACCEPTED' && h.order_status === 'AWAITING_PAYMENT'),
    funded_minor: sum((h) => h.budget_state === 'COMMITTED' && !['COMPLETED', 'REFUNDED'].includes(String(h.order_status))),
    completed_minor: sum((h) => h.order_status === 'COMPLETED'),
    refunded_minor: sum((h) => h.order_status === 'REFUNDED'),
    reserved_minor: request.reserved_minor,
    committed_minor: request.committed_minor,
    reserved_hires: request.reserved_hires,
    committed_hires: request.committed_hires,
    target_hires: request.target_hires,
    hires: hireRows,
  } : null;
  // A creator applying to PUBLISH work picks one of their own accounts on the request's platform.
  const myAccounts = actor && !owner && request.taxonomy === 'PUBLISH'
    ? asRows(await sql`select id,platform,handle,canonical_url as url from app.social_accounts where creator_id=${actor.id} and platform=${String(request.publish_platform)} and removed_at is null order by created_at`)
    : [];
  return { request, applications: asRows(applications), campaign, my_social_accounts: myAccounts };
}

const AUCTION_PUBLIC_STATES = ['SCHEDULED', 'LIVE', 'AWAITING_WINNER_PAYMENT', 'SETTLED', 'NO_BIDS', 'WINNER_DEFAULTED'];

/**
 * §10.6 snapshot: server time, version, highest valid bid, next minimum, Buy Now availability and the viewer's
 * own standing. Bidders appear under a per-auction pseudonym; no ids, emails or payout data.
 */
export async function getAuctionData(actor: Actor | null, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [auction] = asRows(await sql`select a.id,a.service_id,a.seller_id,a.title,u.display_name as creator_name,a.starting_price_minor,a.current_price_minor,a.minimum_increment_minor,
      a.buy_now_price_minor,a.starts_at,a.ends_at,a.status,a.bid_count,a.first_valid_bid_at,a.payment_due_at,a.version,a.closed_at,a.cancel_reason,a.current_bid_id,
      (a.winner_id = ${actor?.id ?? null}::uuid) as viewer_is_winner, now() as server_now
    from app.auctions a join app.users u on u.id=a.seller_id
    where a.id=${id} and (a.status = any(${AUCTION_PUBLIC_STATES}) or a.seller_id=${actor?.id ?? null}::uuid)`);
  if (!auction) return null;
  const bids = asRows(await sql`select concat('Bidder ', upper(substr(md5(b.auction_id::text || ':' || b.bidder_id::text), 1, 6))) as display_name,
      b.amount_minor,b.created_at,b.sequence,(b.bidder_id = ${actor?.id ?? null}::uuid) as mine
    from app.bids b where b.auction_id=${id} and b.status='ACCEPTED' order by b.amount_minor desc, b.sequence asc`);
  const top = bids[0];
  const serverNow = new Date(String(auction.server_now));
  const open = ['SCHEDULED', 'LIVE'].includes(String(auction.status));
  const live = open && serverNow >= new Date(String(auction.starts_at)) && serverNow < new Date(String(auction.ends_at));
  const nextMinimum = top ? (BigInt(String(top.amount_minor)) + BigInt(String(auction.minimum_increment_minor))).toString() : String(auction.starting_price_minor);
  let viewer: ReadRow | null = null;
  if (actor) {
    const [intent] = asRows(await sql`select kind,status,order_id,expires_at from app.auction_purchase_intents where auction_id=${id} and buyer_id=${actor.id} order by created_at desc limit 1`);
    const myBest = bids.find((b) => b.mine === true);
    let standing = 'NONE';
    if (actor.id === String(auction.seller_id)) standing = 'SELLER';
    else if (intent) standing = intent.status === 'ACTIVE' ? (intent.kind === 'BUY_NOW' ? 'BOUGHT_PAY' : 'WON_PAY') : intent.status === 'FUNDED' ? 'WON' : 'DEFAULTED';
    else if (myBest) standing = open ? (top?.mine === true ? 'WINNING' : 'OUTBID') : auction.status === 'CANCELLED' ? 'CANCELLED' : 'LOST';
    viewer = { standing, my_highest_minor: myBest?.amount_minor ?? null, order_id: intent?.order_id ?? null, payment_due_at: intent?.expires_at ?? null };
  }
  return {
    auction: {
      ...auction,
      live,
      accepting_bids: live,
      next_minimum_minor: nextMinimum,
      highest_bid_minor: top?.amount_minor ?? null,
      buy_now_available: live && auction.buy_now_price_minor != null && auction.first_valid_bid_at == null,
    } as ReadRow,
    bids: bids.map(({ mine: _mine, ...bid }) => bid),
    viewer,
  };
}

/** Bidder dashboard (§10.6 My bids): standing per auction the actor bid on or bought. */
export async function getMyBids(actor: Actor) {
  const rows = asRows(await sql`select a.id,a.title,a.status,a.ends_at,a.payment_due_at,max(b.amount_minor) as my_highest_minor,a.current_price_minor,
      (select bb.bidder_id from app.bids bb where bb.auction_id=a.id and bb.status='ACCEPTED' order by bb.amount_minor desc, bb.sequence asc limit 1) = ${actor.id}::uuid as leading,
      i.kind as intent_kind,i.status as intent_status,i.order_id
    from app.auctions a join app.bids b on b.auction_id=a.id and b.bidder_id=${actor.id} and b.status='ACCEPTED'
    left join lateral (select * from app.auction_purchase_intents x where x.auction_id=a.id and x.buyer_id=${actor.id} order by x.created_at desc limit 1) i on true
    group by a.id,i.kind,i.status,i.order_id order by a.ends_at desc limit 100`);
  return rows.map((row): ReadRow => {
    const open = ['SCHEDULED', 'LIVE'].includes(String(row.status));
    const standing = row.intent_status === 'ACTIVE' ? 'WON_PAY' : row.intent_status === 'FUNDED' ? 'WON'
      : row.intent_status ? 'DEFAULTED' : open ? (row.leading ? 'WINNING' : 'OUTBID') : row.status === 'CANCELLED' ? 'CANCELLED' : 'LOST';
    return { ...row, standing };
  });
}

export const EXPLORE_PAGE_SIZE = 20;
export const EXPLORE_PRICES: Record<string, { label: string; min: string | null; max: string | null }> = {
  under_100: { label: 'Under $100', min: null, max: '100' },
  '100_500': { label: '$100 – $500', min: '100', max: '500' },
  '500_1000': { label: '$500 – $1,000', min: '500', max: '1000' },
  over_1000: { label: '$1,000+', min: '1000', max: null },
};
export const EXPLORE_DELIVERY: Record<string, string> = { '24': 'Within 24 hours', '72': 'Within 3 days', '168': 'Within 7 days', '336': 'Within 14 days' };
export const EXPLORE_SORTS: Record<string, string> = { relevance: 'Best match', newest: 'Newest', price_asc: 'Price: low to high', price_desc: 'Price: high to low', turnaround: 'Fastest delivery' };

type QueryInput = Record<string, string | string[] | undefined>;

/**
 * Explore (master-detail): allowlisted filters mapped onto the discovery search, one page of results with everything
 * the detail panel shows, and the niches that currently have published services. Invalid input falls back to defaults.
 */
export async function getExploreData(query: QueryInput) {
  const pick = (key: string) => (typeof query[key] === 'string' ? (query[key] as string).trim() : '');
  const filters = {
    q: pick('q').slice(0, 120),
    category: ['CREATE', 'PUBLISH', 'ACCESS', 'DIGITAL'].includes(pick('category')) ? pick('category') : '',
    niche: pick('niche').slice(0, 80),
    price: EXPLORE_PRICES[pick('price')] ? pick('price') : '',
    delivery: EXPLORE_DELIVERY[pick('delivery')] ? pick('delivery') : '',
    available: pick('available') === '1',
    sort: '',
    cursor: pick('cursor'),
    selected: pick('selected'),
  };
  const sort = EXPLORE_SORTS[pick('sort')] && (pick('sort') !== 'relevance' || filters.q) ? pick('sort') : (filters.q ? 'relevance' : 'newest');
  filters.sort = sort;
  const params = new URLSearchParams({ sort, limit: String(EXPLORE_PAGE_SIZE) });
  if (filters.q) params.set('q', filters.q);
  if (filters.category) params.set('taxonomy', filters.category);
  if (filters.niche) params.set('niche', filters.niche);
  if (filters.price) {
    const range = EXPLORE_PRICES[filters.price]!;
    if (range.min) params.set('price_min', range.min);
    if (range.max) params.set('price_max', range.max);
  }
  if (filters.delivery) params.set('turnaround_max', filters.delivery);
  if (filters.available) params.set('available', 'true');
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (params.get('sort') === 'relevance' && !toPrefixQuery(filters.q)) params.set('sort', 'newest');

  let error: string | null = null;
  let result: Awaited<ReturnType<typeof searchServices>>;
  try {
    result = await searchServices(parseServiceSearch(params));
  } catch (caught) {
    if (!(caught instanceof CommandError)) throw caught;
    error = caught.message;
    result = await searchServices(parseServiceSearch(new URLSearchParams({ sort: 'newest', limit: String(EXPLORE_PAGE_SIZE) })));
  }
  const ids = result.items.map((item) => String(item.id));
  const creatorIds = [...new Set(result.items.map((item) => String(item.creator_id)))];
  const [details, samples, stats, niches] = await Promise.all([
    ids.length ? sql`select s.id,v.description,v.publish_platform,v.publish_handle,v.publish_format,v.min_live_hours,v.disclosure_text,v.access_session_minutes,
        v.digital_license,v.digital_updates,v.digital_download_limit,p.headline
      from app.services s join app.service_versions v on v.id=s.published_version_id left join app.profiles p on p.user_id=s.creator_id where s.id = any(${ids}::uuid[])` : [],
    ids.length ? sql`select service_id,title,url from (
        select ss.service_id,sm.title,sm.url,row_number() over (partition by ss.service_id order by sm.created_at desc) as rank
        from app.service_samples ss join app.samples sm on sm.id=ss.sample_id
        where ss.service_id = any(${ids}::uuid[]) and sm.visibility='PUBLIC' and sm.moderation_status='APPROVED' and sm.url is not null
      ) ranked where rank <= 3` : [],
    creatorIds.length ? sql`select u.id,
        (select count(*)::int from app.orders o where o.creator_id=u.id and o.status='COMPLETED') as completed_jobs,
        (select count(*)::int from app.reviews r where r.creator_id=u.id) as review_count,
        (select round(avg(r.rating)::numeric,1)::text from app.reviews r where r.creator_id=u.id) as rating
      from app.users u where u.id = any(${creatorIds}::uuid[])` : [],
    sql`select distinct p.niche from app.services s join app.profiles p on p.user_id=s.creator_id join app.users u on u.id=s.creator_id
      where s.status='PUBLISHED' and u.status='ACTIVE' and p.niche <> '' and p.niche <> 'Independent creator' order by p.niche limit 40`,
  ]);
  const detailOf = new Map(asRows(details).map((d) => [String(d.id), d]));
  const statOf = new Map(asRows(stats).map((s) => [String(s.id), s]));
  const items = result.items.map((item) => {
    const stat = statOf.get(String(item.creator_id));
    return {
      ...item,
      ...detailOf.get(String(item.id)),
      samples: asRows(samples).filter((sample) => String(sample.service_id) === String(item.id)).map(({ title, url }) => ({ title, url })),
      completed_jobs: Number(stat?.completed_jobs ?? 0),
      // Ratings are shown only with at least three reviews (DSC rule, same as creator discovery).
      rating: Number(stat?.review_count ?? 0) >= 3 ? stat?.rating ?? null : null,
      review_count: Number(stat?.review_count ?? 0),
    } as ReadRow;
  });
  return { items, matched: result.matched, next_cursor: result.next_cursor, filters, niches: asRows(niches).map((n) => String(n.niche)), error };
}
