import { sql } from './db';
import type { Actor } from './auth';
import { poolAvailability } from '@/modules/capacity';

export type ReadRow = Record<string, unknown>;
const asRows = (value: unknown): ReadRow[] => Array.isArray(value) ? value as ReadRow[] : [];

const SERVICE_COLUMNS_OWNER = sql`s.id,s.title,s.description,s.taxonomy,s.price_minor,s.currency,s.turnaround_hours,s.revision_limit,s.status,s.version,s.creator_id,s.published_version_id as service_version_id`;
// Public views always show the published immutable version's terms, never unpublished edits.
const SERVICE_COLUMNS_PUBLIC = sql`s.id,v.title,v.description,v.taxonomy,v.price_minor,v.currency,v.turnaround_hours,v.revision_limit,s.status,s.version,s.creator_id,v.id as service_version_id,v.version as service_version`;

async function withAvailability(rows: ReadRow[]): Promise<ReadRow[]> {
  const availability = await poolAvailability(sql, rows.map((row) => ({ poolId: String(row.pool_id), turnaroundHours: Number(row.turnaround_hours) })));
  return rows.map((row) => {
    const a = availability.get(`${String(row.pool_id)}:${Number(row.turnaround_hours)}`);
    return {
      ...row,
      total_units: a?.weeklyUnits ?? 0,
      weekly_units: a?.weeklyUnits ?? 0,
      available_units: a?.availableUnits ?? 0,
      next_available_starts_at: a?.nextAvailableStartsAt ?? null,
      next_available_ends_at: a?.nextAvailableEndsAt ?? null,
      pool_timezone: a?.timezone ?? 'UTC',
    };
  });
}

async function serviceRows(options: { ownerId?: string; publicCreatorId?: string } = {}) {
  const actorId = options.ownerId;
  const services = actorId
    ? await sql`select ${SERVICE_COLUMNS_OWNER},u.display_name as creator_name,p.handle,p.niche,p.avatar_color,s.pool_id
        from app.services s join app.users u on u.id=s.creator_id left join app.profiles p on p.user_id=s.creator_id
        where s.creator_id=${actorId} order by s.created_at desc`
    : await sql`select ${SERVICE_COLUMNS_PUBLIC},u.display_name as creator_name,p.handle,p.niche,p.avatar_color,v.pool_id
        from app.services s join app.service_versions v on v.id=s.published_version_id join app.users u on u.id=s.creator_id
        left join app.profiles p on p.user_id=s.creator_id
        where s.status='PUBLISHED' and u.status='ACTIVE' and (${options.publicCreatorId ?? null}::uuid is null or s.creator_id=${options.publicCreatorId ?? null}::uuid)
        order by s.created_at desc`;
  const samples = actorId
    ? await sql`select id,creator_id,title,url,description,visibility,moderation_status,created_at from app.samples where creator_id=${actorId} order by created_at desc`
    : await sql`select id,creator_id,title,url,description,visibility,moderation_status,created_at from app.samples where visibility='PUBLIC' and moderation_status='APPROVED' order by created_at desc`;
  const sampleMap = new Map<string, ReadRow[]>();
  for (const sample of asRows(samples)) {
    const key = String(sample.creator_id);
    const current = sampleMap.get(key) ?? [];
    current.push(sample);
    sampleMap.set(key, current);
  }
  const rows = asRows(services).map((service): ReadRow => ({ ...service, samples: sampleMap.get(String(service.creator_id)) ?? [] }));
  return withAvailability(rows);
}

export async function getPublicData(options: { q?: string; category?: string } = {}) {
  const [allServices, requests, auctions] = await Promise.all([
    serviceRows(),
    sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.status,u.display_name as buyer_name,(select count(*) from app.applications a where a.request_id=r.id) as application_count from app.requests r join app.users u on u.id=r.buyer_id where r.status in ('OPEN','SELECTING') and r.deadline>now() order by r.deadline asc`,
    sql`select a.id,a.service_id,a.seller_id,s.title,u.display_name as creator_name,a.starting_price_minor,a.current_price_minor,a.minimum_increment_minor,a.buy_now_price_minor,a.ends_at,a.starts_at,a.status,a.bid_count,a.winner_id from app.auctions a join app.services s on s.id=a.service_id join app.users u on u.id=a.seller_id where a.status in ('SCHEDULED','LIVE','AWAITING_WINNER_PAYMENT') and a.ends_at>now() order by a.ends_at asc`,
  ]);
  const q = options.q?.trim().toLowerCase();
  const category = options.category?.trim().toUpperCase();
  const services = allServices.filter((service) => {
    const matchesCategory = !category || String(service.taxonomy) === category;
    const haystack = `${service.title} ${service.description} ${service.creator_name} ${service.niche}`.toLowerCase();
    return matchesCategory && (!q || haystack.includes(q));
  });
  return { services, requests: asRows(requests), auctions: asRows(auctions) };
}

export async function getDashboardData(actor: Actor) {
  const [services, orders, applications, requests, auctions, profile, stats] = await Promise.all([
    serviceRows({ ownerId: actor.id }),
    sql`select o.id,o.buyer_id,o.creator_id,o.service_id,o.source,o.title,o.status,o.amount_minor,o.platform_fee_minor,o.provider_fee_minor,o.currency,o.brief,o.delivery_due_at,o.review_due_at,o.revision_count,o.version,o.buyer_name,o.creator_name,o.settlement_status,o.payment_status,o.created_at from (select o.*,bu.display_name as buyer_name,cu.display_name as creator_name from app.orders o join app.users bu on bu.id=o.buyer_id join app.users cu on cu.id=o.creator_id) o where o.buyer_id=${actor.id} or o.creator_id=${actor.id} order by o.created_at desc`,
    sql`select a.id,a.request_id,a.creator_id,r.title as request_title,a.quote_minor,a.status,a.note,cu.display_name as creator_name from app.applications a join app.requests r on r.id=a.request_id join app.users cu on cu.id=a.creator_id where a.creator_id=${actor.id} order by a.created_at desc`,
    sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.status,u.display_name as buyer_name,(select count(*) from app.applications a where a.request_id=r.id) as application_count from app.requests r join app.users u on u.id=r.buyer_id where r.buyer_id=${actor.id} order by r.created_at desc`,
    sql`select a.id,a.service_id,a.seller_id,s.title,u.display_name as creator_name,a.starting_price_minor,a.current_price_minor,a.minimum_increment_minor,a.buy_now_price_minor,a.ends_at,a.starts_at,a.status,a.bid_count,a.winner_id from app.auctions a join app.services s on s.id=a.service_id join app.users u on u.id=a.seller_id where a.seller_id=${actor.id} order by a.created_at desc`,
    sql`select p.handle,p.bio,p.niche,p.avatar_color,p.social_url,u.display_name,u.email from app.users u left join app.profiles p on p.user_id=u.id where u.id=${actor.id}`,
    sql`select count(*) filter (where (buyer_id=${actor.id} or creator_id=${actor.id}) and status='COMPLETED') as completed_orders,count(*) filter (where (buyer_id=${actor.id} or creator_id=${actor.id}) and status not in ('COMPLETED','CANCELLED','REFUNDED')) as active_orders,coalesce(sum(amount_minor) filter (where buyer_id=${actor.id}),0) as gross_minor,coalesce(sum(platform_fee_minor) filter (where buyer_id=${actor.id}),0) as platform_fee_minor from app.orders where buyer_id=${actor.id} or creator_id=${actor.id}`,
  ]);
  const [profileRow] = asRows(profile);
  const [statsRow] = asRows(stats);
  const serviceList = asRows(services);
  const available = serviceList.reduce((sum, service) => sum + Number(service.available_units ?? 0), 0);
  return { orders: asRows(orders), services: serviceList, applications: asRows(applications), requests: asRows(requests), auctions: asRows(auctions), profile: profileRow ?? {}, stats: { ...(statsRow ?? {}), available_minor: available } };
}

export async function getOrderData(actor: Actor, id: string) {
  const [order] = asRows(await sql`select o.id,o.buyer_id,o.creator_id,o.service_id,o.service_version_id,o.source,o.title,o.status,o.amount_minor,o.platform_fee_minor,o.provider_fee_minor,
      o.currency,o.brief,o.terms,o.brief_ready_at,o.funded_at,o.work_start_at,o.delivery_due_at,o.review_due_at,o.revision_due_at,o.revision_count,o.approved_at,o.completed_at,
      o.cancelled_at,o.cancellation_refund_minor,o.status_before_dispute,o.version,o.settlement_status,o.payment_status,o.created_at,
      bu.display_name as buyer_name,cu.display_name as creator_name
    from app.orders o join app.users bu on bu.id=o.buyer_id join app.users cu on cu.id=o.creator_id
    where o.id=${id} and (o.buyer_id=${actor.id} or o.creator_id=${actor.id})`);
  if (!order) return null;
  const [deliveries, events, messages, reviews, cancellations, holds, assets] = await Promise.all([
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
  ]);
  // Unattached delivery uploads stay private to their uploader until they are part of a submitted delivery.
  const files = asRows(assets).filter((file) => file.purpose !== 'DELIVERY' || String(file.owner_id) === actor.id || (file.attachments as unknown[]).length > 0);
  const terms = (order.terms ?? {}) as Record<string, unknown>;
  const latest = asRows(deliveries)[0];
  return {
    order: { ...order, revision_limit: Number(terms.revision_limit ?? 1), review_window_hours: Number(terms.review_window_hours ?? 72), auto_accept_consent: terms.auto_accept_consent === true } as ReadRow,
    latest_delivery_version: latest ? Number(latest.version) : null,
    deliveries: asRows(deliveries),
    events: asRows(events),
    messages: asRows(messages),
    reviews: asRows(reviews),
    cancellation_requests: asRows(cancellations),
    active_cancellation_request: asRows(cancellations).find((c) => c.status === 'REQUESTED') ?? null,
    active_review_hold: asRows(holds).find((h) => h.resolved_at === null) ?? null,
    files,
  };
}

export async function getServiceData(id: string) {
  const rows = asRows(await sql`select ${SERVICE_COLUMNS_PUBLIC},u.display_name as creator_name,p.handle,p.bio,p.niche,p.avatar_color,v.pool_id
    from app.services s join app.service_versions v on v.id=s.published_version_id join app.users u on u.id=s.creator_id
    left join app.profiles p on p.user_id=s.creator_id where s.id=${id} and s.status='PUBLISHED' and u.status='ACTIVE'`);
  if (!rows[0]) return null;
  const [service] = await withAvailability(rows);
  const samples = await sql`select id,creator_id,title,url,description,created_at from app.samples where creator_id=${String(service!.creator_id)} and visibility='PUBLIC' and moderation_status='APPROVED' order by created_at desc`;
  return { service: service!, creator: { id: service!.creator_id, display_name: service!.creator_name, bio: service!.bio, niche: service!.niche, handle: service!.handle, avatar_color: service!.avatar_color }, samples: asRows(samples) };
}

export async function getCreatorData(handle: string) {
  const [creator] = asRows(await sql`select u.id,u.display_name,p.handle,p.bio,p.niche,p.avatar_color,(select count(*) from app.orders o where o.creator_id=u.id and o.status='COMPLETED') as completed_jobs,(select round(avg(r.rating)::numeric,1) from app.reviews r where r.creator_id=u.id) as rating,(select count(*) from app.services s where s.creator_id=u.id and s.status='PUBLISHED') as services_count from app.users u join app.profiles p on p.user_id=u.id where p.handle=${handle} and u.status='ACTIVE'`);
  if (!creator) return null;
  const [services, samples] = await Promise.all([
    serviceRows({ publicCreatorId: String(creator.id) }),
    sql`select id,creator_id,title,url,description,created_at from app.samples where creator_id=${String(creator.id)} and visibility='PUBLIC' and moderation_status='APPROVED' order by created_at desc`,
  ]);
  return { creator, services, samples: asRows(samples) };
}

export async function getRequestData(actor: Actor | null, id: string) {
  const [request] = asRows(await sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.status,u.display_name as buyer_name from app.requests r join app.users u on u.id=r.buyer_id where r.id=${id} and (r.status in ('OPEN','SELECTING','FILLED') or r.buyer_id=${actor?.id ?? null})`);
  if (!request) return null;
  const applications = actor
    ? await sql`select a.id,a.creator_id,a.quote_minor,a.note,a.status,a.turnaround_hours,u.display_name as creator_name from app.applications a join app.users u on u.id=a.creator_id where a.request_id=${id} and (a.creator_id=${actor.id} or ${actor.id}=${String(request.buyer_id)}) order by a.created_at asc`
    : [];
  return { request, applications: asRows(applications) };
}

export async function getAuctionData(actor: Actor | null, id: string) {
  const [auction] = asRows(await sql`select a.id,a.service_id,a.seller_id,s.title,u.display_name as creator_name,a.starting_price_minor,a.current_price_minor,a.minimum_increment_minor,a.buy_now_price_minor,a.ends_at,a.starts_at,a.status,a.bid_count,a.winner_id from app.auctions a join app.services s on s.id=a.service_id join app.users u on u.id=a.seller_id where a.id=${id} and (a.status in ('SCHEDULED','LIVE','AWAITING_WINNER_PAYMENT','CLOSED') or a.seller_id=${actor?.id ?? null})`);
  if (!auction) return null;
  const bids = await sql`select b.amount_minor,b.created_at,concat('Bidder ',left(replace(b.bidder_id::text,'-',''),6)) as display_name from app.bids b where b.auction_id=${id} order by b.amount_minor desc,b.created_at asc`;
  return { auction, bids: asRows(bids) };
}
