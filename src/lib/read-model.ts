import { sql } from './db';
import { formatAtomic, usdMinorToAtomic } from '@/modules/crypto/registry';
import type { Actor } from './auth';
import { availabilityOf, workloadsFor } from '@/modules/capacity';

export type ReadRow = Record<string, unknown>;
const asRows = (value: unknown): ReadRow[] => Array.isArray(value) ? value as ReadRow[] : [];

const SERVICE_COLUMNS_OWNER = sql`s.id,s.title,s.description,s.taxonomy,s.price_minor,s.currency,s.turnaround_hours,s.revision_limit,s.units_per_order,s.status,s.version,s.creator_id,s.published_version_id as service_version_id`;
// Public views always show the published immutable version's terms, never unpublished edits.
const SERVICE_COLUMNS_PUBLIC = sql`s.id,v.title,v.description,v.taxonomy,v.price_minor,v.currency,v.turnaround_hours,v.revision_limit,v.units_per_order,s.status,s.version,s.creator_id,v.id as service_version_id,v.version as service_version`;

/**
 * Buyers see a status only, never the counts (§6.1 rule 10): ACCEPTING, AT_CAPACITY or PAUSED for one order of
 * this service. The creator's own numbers come from getDashboardData().workload.
 */
async function withAvailability(rows: ReadRow[]): Promise<ReadRow[]> {
  const workloads = await workloadsFor(sql, rows.map((row) => String(row.creator_id)));
  return rows.map((row) => ({ ...row, availability_status: availabilityOf(workloads.get(String(row.creator_id)), Number(row.units_per_order ?? 1)) }));
}

async function serviceRows(options: { ownerId?: string; publicCreatorId?: string } = {}) {
  const actorId = options.ownerId;
  const services = actorId
    ? await sql`select ${SERVICE_COLUMNS_OWNER},u.display_name as creator_name,p.handle,p.niche,p.avatar_color
        from app.services s join app.users u on u.id=s.creator_id left join app.profiles p on p.user_id=s.creator_id
        where s.creator_id=${actorId} order by s.created_at desc`
    : await sql`select ${SERVICE_COLUMNS_PUBLIC},u.display_name as creator_name,p.handle,p.niche,p.avatar_color
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
  const rows = asRows(services).map((service): ReadRow => ({ ...service, samples: sampleMap.get(String(service.id)) ?? [] }));
  return withAvailability(rows);
}

export async function getPublicData(options: { q?: string; category?: string } = {}) {
  const [allServices, requests, auctions] = await Promise.all([
    serviceRows(),
    sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.status,u.display_name as buyer_name,(select count(*) from app.applications a where a.request_id=r.id) as application_count from app.requests r join app.users u on u.id=r.buyer_id where r.status='OPEN' and r.application_deadline>now() order by r.application_deadline asc`,
    sql`select a.id,a.service_id,a.seller_id,s.title,u.display_name as creator_name,a.starting_price_minor,a.current_price_minor,a.minimum_increment_minor,a.buy_now_price_minor,a.ends_at,a.starts_at,a.status,a.bid_count,a.winner_id from app.auctions a join app.services s on s.id=a.service_id join app.users u on u.id=a.seller_id where a.status in ('SCHEDULED','LIVE') and a.ends_at>now() order by a.ends_at asc`,
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
    sql`select a.id,a.request_id,a.creator_id,r.title as request_title,a.quote_minor,a.status,a.note,a.version,a.valid_until,cu.display_name as creator_name,
      o.id as offer_id,o.status as offer_status,o.expires_at as offer_expires_at,o.amount_minor as offer_amount_minor,o.order_id as offer_order_id
      from app.applications a join app.requests r on r.id=a.request_id join app.users cu on cu.id=a.creator_id
      left join lateral (select * from app.hire_offers h where h.application_id=a.id order by h.created_at desc limit 1) o on true
      where a.creator_id=${actor.id} order by a.created_at desc`,
    sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.status,u.display_name as buyer_name,(select count(*) from app.applications a where a.request_id=r.id) as application_count from app.requests r join app.users u on u.id=r.buyer_id where r.buyer_id=${actor.id} order by r.created_at desc`,
    sql`select a.id,a.service_id,a.seller_id,s.title,u.display_name as creator_name,a.starting_price_minor,a.current_price_minor,a.minimum_increment_minor,a.buy_now_price_minor,a.ends_at,a.starts_at,a.status,a.bid_count,a.winner_id from app.auctions a join app.services s on s.id=a.service_id join app.users u on u.id=a.seller_id where a.seller_id=${actor.id} order by a.created_at desc`,
    sql`select p.handle,p.bio,p.niche,p.avatar_color,p.social_url,u.display_name,u.email from app.users u left join app.profiles p on p.user_id=u.id where u.id=${actor.id}`,
    sql`select count(*) filter (where (buyer_id=${actor.id} or creator_id=${actor.id}) and status='COMPLETED') as completed_orders,count(*) filter (where (buyer_id=${actor.id} or creator_id=${actor.id}) and status not in ('COMPLETED','CANCELLED','REFUNDED')) as active_orders,coalesce(sum(amount_minor) filter (where buyer_id=${actor.id}),0) as gross_minor,coalesce(sum(platform_fee_minor) filter (where buyer_id=${actor.id}),0) as platform_fee_minor from app.orders where buyer_id=${actor.id} or creator_id=${actor.id}`,
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
      o.cancelled_at,o.cancellation_refund_minor,o.status_before_dispute,o.version,o.settlement_status,o.payment_status,o.payment_rail,o.created_at,
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
  const isBuyer = actor.id === String(order.buyer_id);
  // Crypto checkout (W5-C1): the buyer sees their latest intent; both parties see how the order was paid.
  const [cryptoIntent] = isBuyer ? asRows(await sql`select i.id,i.status,i.status_reason,i.chain_id,i.network_mode,i.amount_atomic,i.recipient,i.reference,i.expires_at,
      a.symbol,a.decimals,a.kind as asset_kind,n.name as network_name,
      (select json_build_object('tx_hash',d.tx_hash,'status',d.status,'reason',d.reason) from app.chain_deposits d where d.intent_id=i.id order by d.created_at desc limit 1) as last_deposit
    from app.crypto_payment_intents i join app.chain_assets a on a.id=i.asset_id join app.chain_networks n on n.chain_id=i.chain_id
    where i.order_id=${id} order by i.created_at desc limit 1`) : [];
  const cryptoEnabled = isBuyer && order.status === 'AWAITING_PAYMENT' && (await sql`select enabled from app.feature_flags where key='CRYPTO_CHECKOUT_ENABLED'`)[0]?.enabled === true;
  const cryptoOptions = cryptoEnabled ? asRows(await sql`select a.id as asset_id,a.symbol,a.decimals,a.kind,n.chain_id,n.name as network_name,n.mode
    from app.chain_assets a join app.chain_networks n on n.chain_id=a.chain_id
    where n.enabled and a.usd_pegged and a.allowlisted and n.mode in ('LOCAL','TESTNET') ${process.env.NODE_ENV === 'production' ? sql`and n.mode <> 'LOCAL'` : sql``}
    order by n.chain_id, (a.kind='NATIVE') desc`) : [];
  const [paymentConfirmed] = asRows(await sql`select payload from app.order_events where order_id=${id} and kind='PAYMENT_CONFIRMED' order by created_at desc limit 1`);
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
    payment_receipt: paymentConfirmed ? paymentConfirmed.payload : null,
    crypto_payment: cryptoIntent ? { ...cryptoIntent, amount_display: formatAtomic(BigInt(String(cryptoIntent.amount_atomic)), Number(cryptoIntent.decimals)) } : null,
    crypto_options: cryptoOptions.map((option) => ({ ...option, amount_display: formatAtomic(usdMinorToAtomic(BigInt(String(order.amount_minor)), Number(option.decimals)), Number(option.decimals)) })),
  };
}

export async function getServiceData(id: string) {
  const rows = asRows(await sql`select ${SERVICE_COLUMNS_PUBLIC},u.display_name as creator_name,p.handle,p.bio,p.niche,p.avatar_color
    from app.services s join app.service_versions v on v.id=s.published_version_id join app.users u on u.id=s.creator_id
    left join app.profiles p on p.user_id=s.creator_id where s.id=${id} and s.status='PUBLISHED' and u.status='ACTIVE'`);
  if (!rows[0]) return null;
  const [service] = await withAvailability(rows);
  // The service page shows the samples the creator linked to this service (service_samples), not their whole portfolio.
  const samples = await sql`select sm.id,sm.creator_id,sm.title,sm.url,sm.description,sm.created_at from app.service_samples ss join app.samples sm on sm.id=ss.sample_id
    where ss.service_id=${id} and sm.visibility='PUBLIC' and sm.moderation_status='APPROVED' order by sm.created_at desc limit 12`;
  return { service: service!, creator: { id: service!.creator_id, display_name: service!.creator_name, bio: service!.bio, niche: service!.niche, handle: service!.handle, avatar_color: service!.avatar_color }, samples: asRows(samples) };
}

export async function getCreatorData(handle: string) {
  const [creator] = asRows(await sql`select u.id,u.display_name,p.handle,p.bio,p.niche,p.avatar_color,(select count(*) from app.orders o where o.creator_id=u.id and o.status='COMPLETED') as completed_jobs,(select round(avg(r.rating)::numeric,1) from app.reviews r where r.creator_id=u.id) as rating,(select count(*) from app.services s where s.creator_id=u.id and s.status='PUBLISHED') as services_count from app.users u join app.profiles p on p.user_id=u.id where p.handle=${handle} and u.status='ACTIVE'`);
  if (!creator) return null;
  const [services, samples] = await Promise.all([
    serviceRows({ publicCreatorId: String(creator.id) }),
    sql`select id,creator_id,title,url,description,created_at from app.samples where creator_id=${String(creator.id)} and visibility='PUBLIC' and moderation_status='APPROVED' order by created_at desc limit 24`,
  ]);
  return { creator, services, samples: asRows(samples) };
}

export async function getRequestData(actor: Actor | null, id: string) {
  const [request] = asRows(await sql`select r.id,r.buyer_id,r.title,r.brief,r.taxonomy,r.budget_minor,r.per_creator_cap_minor,r.target_hires,r.deadline,r.application_deadline,
      r.status,r.version,r.currency,r.reserved_minor,r.committed_minor,r.reserved_hires,r.committed_hires,u.display_name as buyer_name,
      (select count(*) from app.applications a where a.request_id=r.id and a.status <> 'WITHDRAWN')::int as application_count
    from app.requests r join app.users u on u.id=r.buyer_id where r.id=${id} and (r.status in ('OPEN','FILLED','CLOSED') or r.buyer_id=${actor?.id ?? null})`);
  if (!request) return null;
  const owner = !!actor && actor.id === String(request.buyer_id);
  // REQ-03: a creator reads only their own application and offer; the buyer reads all. Anonymous readers see none.
  const applications = actor
    ? await sql`select a.id,a.creator_id,a.quote_minor,a.note,a.status,a.turnaround_hours,a.version,a.valid_until,a.samples_snapshot,a.created_at,a.updated_at,
          u.display_name as creator_name,p.handle as creator_handle,
          o.id as offer_id,o.status as offer_status,o.expires_at as offer_expires_at,o.amount_minor as offer_amount_minor,o.order_id as offer_order_id
        from app.applications a join app.users u on u.id=a.creator_id left join app.profiles p on p.user_id=a.creator_id
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
  return { request, applications: asRows(applications), campaign };
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
