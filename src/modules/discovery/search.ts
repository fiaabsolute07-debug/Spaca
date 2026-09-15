/**
 * Service and creator discovery (P5-01/02/05). Only PUBLISHED services of ACTIVE creators, shown with the
 * published immutable version's terms. Availability is a status (ACCEPTING, PAUSED, or SOLD_OUT for DIGITAL), never a
 * count; ranking and ordering use explicit, documented keys with keyset pagination.
 */
import type postgres from 'postgres';
import { sql } from '@/lib/db';
import { encodeCursor, type CreatorSearch, type ServiceSearch } from './params';

type Row = Record<string, unknown>;
type Fragment = postgres.PendingQuery<postgres.Row[]>;
/** Queries run on the pool by default, or inside a caller's transaction (benchmarks roll back generated data). */
export type Db = postgres.Sql | postgres.TransactionSql;
const empty = sql``;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const and = (condition: boolean, fragment: Fragment) => (condition ? sql`and ${fragment}` : empty);
/** Buyers see whether the creator takes new orders; there is no limit on orders at once (drizzle/0017). */
const availabilityStatus = sql`case when coalesce(w.accepting_orders, true) = false then 'PAUSED' else 'ACCEPTING' end`;
/** DIGITAL listings use no creator capacity; they are sold out once stock or an exclusive license is taken (drizzle/0016). */
const digitalStatus = sql`case when exists (select 1 from app.digital_entitlements e where e.service_id = s.id and e.license = 'EXCLUSIVE' and e.state in ('HELD','EXPIRY_RECONCILING','ACTIVE'))
    or (s.digital_stock is not null and (select count(*) from app.digital_entitlements e where e.service_id = s.id and e.state in ('HELD','EXPIRY_RECONCILING','ACTIVE')) >= s.digital_stock)
  then 'SOLD_OUT' else 'ACCEPTING' end`;
/** Fixture accounts (is_test) are listed locally so dev/E2E have data, but never shown as real supply in production. */
export const includeTestData = () => process.env.APP_ENV !== 'production';

/** Relevance weights the published version (title A, description B) and adds half of the profile match. */
export async function searchServices(input: ServiceSearch, db: Db = sql) {
  const query = input.tsquery;
  const keys = input.cursor?.keys ?? [];
  const cursorId = input.cursor?.id ?? null;
  const rows = await db<Row[]>`
    with matched as (
      select s.id, v.id as service_version_id, v.version as service_version, v.title, left(v.description, 280) as summary, v.taxonomy, v.price_minor, v.currency,
        v.turnaround_hours, v.revision_limit, v.created_at as published_at, s.creator_id, u.display_name as creator_name, p.handle, p.niche, p.avatar_color, p.avatar_asset_id,
        ${query ? sql`round((ts_rank_cd(v.search_document, to_tsquery('simple', ${query})) + 0.5 * ts_rank_cd(coalesce(p.search_document, ''::tsvector), to_tsquery('simple', ${query})))::numeric, 6)` : sql`0::numeric`} as rank,
        case when v.taxonomy = 'DIGITAL' then ${digitalStatus} else ${availabilityStatus} end as availability_status
      from app.services s
      join app.service_versions v on v.id = s.published_version_id
      join app.users u on u.id = s.creator_id and u.status = 'ACTIVE' and (${includeTestData()} or not u.is_test)
      left join app.profiles p on p.user_id = s.creator_id
      left join app.creator_workloads w on w.creator_id = s.creator_id
      where s.status = 'PUBLISHED'
        ${and(!!query, sql`(v.search_document @@ to_tsquery('simple', ${query ?? ''}) or p.search_document @@ to_tsquery('simple', ${query ?? ''}))`)}
        ${and(input.taxonomies.length > 0, sql`v.taxonomy = any(${input.taxonomies})`)}
        ${and(!!input.niche, sql`lower(p.niche) = lower(${input.niche ?? ''})`)}
        ${and(input.priceMinMinor !== null, sql`v.price_minor >= ${String(input.priceMinMinor ?? 0)}`)}
        ${and(input.priceMaxMinor !== null, sql`v.price_minor <= ${String(input.priceMaxMinor ?? 0)}`)}
        ${and(input.turnaroundMaxHours !== null, sql`v.turnaround_hours <= ${input.turnaroundMaxHours ?? 0}`)}
        ${and(!!input.creatorHandle, sql`p.handle = ${input.creatorHandle ?? ''}`)}
    )
    select *, count(*) over () as matched_count from matched
    where true
      ${and(input.availableOnly, sql`availability_status = 'ACCEPTING'`)}
      ${cursorId === null ? empty : input.sort === 'relevance' ? sql`and (rank < ${keys[0]}::numeric or (rank = ${keys[0]}::numeric and id > ${cursorId}::uuid))`
        : input.sort === 'newest' ? sql`and (published_at, id) < (${keys[0]}::timestamptz, ${cursorId}::uuid)`
        : input.sort === 'price_asc' ? sql`and (price_minor, id) > (${keys[0]}::bigint, ${cursorId}::uuid)`
        : input.sort === 'price_desc' ? sql`and (price_minor, id) < (${keys[0]}::bigint, ${cursorId}::uuid)`
        : sql`and (turnaround_hours, id) > (${keys[0]}::int, ${cursorId}::uuid)`}
    order by ${input.sort === 'relevance' ? sql`rank desc, id asc`
      : input.sort === 'newest' ? sql`published_at desc, id desc`
      : input.sort === 'price_asc' ? sql`price_minor asc, id asc`
      : input.sort === 'price_desc' ? sql`price_minor desc, id desc`
      : sql`turnaround_hours asc, id asc`}
    limit ${input.limit + 1}`;
  const items = rows.slice(0, input.limit);
  const last = items[items.length - 1];
  const keyOf = (row: Row): string => {
    const value = input.sort === 'relevance' ? row.rank : input.sort === 'newest' ? row.published_at : input.sort.startsWith('price') ? row.price_minor : row.turnaround_hours;
    return input.sort === 'newest' ? iso(value) : String(value);
  };
  return {
    items: items.map(({ matched_count: _count, ...item }) => item),
    // Matches from this page on (the whole result set on the first page).
    matched: rows[0] ? Number(rows[0].matched_count) : 0,
    next_cursor: rows.length > input.limit && last ? encodeCursor({ sort: input.sort, keys: [keyOf(last)], id: String(last.id) }) : null,
    sort: input.sort,
    ranking: input.sort === 'relevance' ? 'ts_rank_cd(title A, description B, taxonomy C) + 0.5 × profile match; ties by id' : `ordered by ${input.sort}; ties by id`,
  };
}

/**
 * Creator discovery (P5-05): samples, niche, availability and reputation. Ratings are shown only with at least
 * three reviews; follower counts do not exist and never rank.
 */
export async function searchCreators(input: CreatorSearch, db: Db = sql) {
  const query = input.tsquery;
  const keys = input.cursor?.keys ?? [];
  const cursorId = input.cursor?.id ?? null;
  const rows = await db<Row[]>`
    with creators as (
      select u.id, p.handle, u.display_name, p.niche, left(p.bio, 200) as bio, p.avatar_color, p.created_at as joined_at,
        svc.services_count, svc.min_price_minor, svc.taxonomies,
        coalesce(done.completed_orders, 0) as completed_orders, coalesce(rev.review_count, 0) as review_count,
        case when coalesce(rev.review_count, 0) >= 3 then round(rev.avg_rating, 2) else null end as avg_rating,
        coalesce(smp.sample_count, 0) as sample_count, ${availabilityStatus} as availability_status,
        ${query ? sql`round(ts_rank_cd(p.search_document, to_tsquery('simple', ${query}))::numeric, 6)` : sql`0::numeric`} as rank
      from app.users u
      join app.profiles p on p.user_id = u.id
      join lateral (
        select count(*)::int as services_count, min(v.price_minor) as min_price_minor, array_agg(distinct v.taxonomy) as taxonomies
        from app.services s join app.service_versions v on v.id = s.published_version_id
        where s.creator_id = u.id and s.status = 'PUBLISHED'
      ) svc on svc.services_count > 0
      left join lateral (select count(*)::int as completed_orders from app.orders o where o.creator_id = u.id and o.status = 'COMPLETED') done on true
      left join lateral (select count(*)::int as review_count, avg(r.rating) as avg_rating from app.reviews r where r.creator_id = u.id) rev on true
      left join lateral (select count(*)::int as sample_count from app.samples sm where sm.creator_id = u.id and sm.visibility = 'PUBLIC' and sm.moderation_status = 'APPROVED') smp on true
      left join app.creator_workloads w on w.creator_id = u.id
      where u.status = 'ACTIVE' and (${includeTestData()} or not u.is_test)
        ${and(!!query, sql`p.search_document @@ to_tsquery('simple', ${query ?? ''})`)}
        ${and(!!input.niche, sql`lower(p.niche) = lower(${input.niche ?? ''})`)}
        ${and(!!input.taxonomy, sql`${input.taxonomy ?? ''} = any(svc.taxonomies)`)}
    )
    select * from creators
    where true
      ${and(input.availableOnly, sql`availability_status = 'ACCEPTING'`)}
      ${cursorId === null ? empty : input.sort === 'relevance' ? sql`and (rank < ${keys[0]}::numeric or (rank = ${keys[0]}::numeric and id > ${cursorId}::uuid))`
        : input.sort === 'reputation' ? sql`and (completed_orders, coalesce(avg_rating, 0), id) < (${keys[0]}::int, ${keys[1]}::numeric, ${cursorId}::uuid)`
        : sql`and (joined_at, id) < (${keys[0]}::timestamptz, ${cursorId}::uuid)`}
    order by ${input.sort === 'relevance' ? sql`rank desc, id asc`
      : input.sort === 'reputation' ? sql`completed_orders desc, coalesce(avg_rating, 0) desc, id desc`
      : sql`joined_at desc, id desc`}
    limit ${input.limit + 1}`;
  const items = rows.slice(0, input.limit).map((row): Row => ({ ...row, reputation_label: Number(row.review_count) >= 3 ? 'RATED' : 'NEW' }));
  const last = items[items.length - 1];
  const keysOf = (row: Row): (string | null)[] => input.sort === 'relevance' ? [String(row.rank)]
    : input.sort === 'reputation' ? [String(row.completed_orders), String(row.avg_rating ?? 0)]
    : [iso(row.joined_at)];
  return { items, next_cursor: rows.length > input.limit && last ? encodeCursor({ sort: input.sort, keys: keysOf(last), id: String(last.id) }) : null, sort: input.sort };
}

/** P5-03: live auctions by server time only; ended ones are excluded even before the close job runs (DSC-03). */
export async function endingSoonAuctions(input: { withinHours: number; cursor: { keys: (string | null)[]; id: string } | null; limit: number }, db: Db = sql) {
  const rows = await db<Row[]>`select a.id,a.title,a.starting_price_minor,a.current_price_minor,a.minimum_increment_minor,a.buy_now_price_minor,a.bid_count,a.starts_at,a.ends_at,
      a.first_valid_bid_at,u.display_name as creator_name,now() as server_now
    from app.auctions a join app.users u on u.id = a.seller_id and u.status = 'ACTIVE' and (${includeTestData()} or not u.is_test)
    where a.status in ('SCHEDULED','LIVE') and a.starts_at <= now() and a.ends_at > now() and a.ends_at <= now() + (${input.withinHours} * interval '1 hour')
      ${input.cursor ? sql`and (a.ends_at, a.id) > (${input.cursor.keys[0]}::timestamptz, ${input.cursor.id}::uuid)` : empty}
    order by a.ends_at asc, a.id asc limit ${input.limit + 1}`;
  const items = rows.slice(0, input.limit).map((row): Row => ({ ...row, buy_now_available: row.buy_now_price_minor != null && row.first_valid_bid_at == null }));
  const last = items[items.length - 1];
  return { items, server_now: rows[0]?.server_now ?? new Date(), next_cursor: rows.length > input.limit && last ? encodeCursor({ sort: 'ending_soon', keys: [iso(last.ends_at)], id: String(last.id) }) : null };
}
