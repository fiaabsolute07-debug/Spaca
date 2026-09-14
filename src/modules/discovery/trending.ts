/**
 * Trending (P5-04, formula trending-v1). A service is eligible only with real demand evidence:
 *   completed orders in the last 30 days ≥ 3  AND  eligible views in the last 7 days ≥ 20.
 *   score = 3·completed_30d + 2·(avg_rating_30d − 3)·min(reviews_30d, 5)/5 + ln(1 + views_7d)
 * In production, is_test creators are not listed and is_test buyers' orders/reviews are not demand evidence.
 * Views are one per viewer, service and day, excluding the owner, and capped per viewer per day (views.ts).
 * With fewer than MIN_TRENDING eligible services the result is labelled COLD_START and lists newest published
 * services as "new" — never as trending, and without invented counts (DSC-04).
 */
import { sql } from '@/lib/db';
import { includeTestData, type Db } from './search';

type Row = Record<string, unknown>;
export const TRENDING_FORMULA = {
  version: 'trending-v1',
  eligibility: { completed_orders_30d_min: 3, eligible_views_7d_min: 20 },
  score: '3*completed_30d + 2*(avg_rating_30d - 3)*least(reviews_30d,5)/5 + ln(1 + views_7d)',
  min_items_for_trending_label: 3,
} as const;

export async function trendingServices(options: { limit?: number; niche?: string | null; taxonomy?: string | null } = {}, db: Db = sql) {
  const limit = options.limit ?? 12;
  const niche = options.niche ?? null;
  const taxonomy = options.taxonomy ?? null;
  const test = includeTestData();
  const rows = await db<Row[]>`
    with completed as (
      select o.service_id, count(*)::int as completed_30d from app.orders o join app.users b on b.id = o.buyer_id and (${test} or not b.is_test)
      where o.status = 'COMPLETED' and o.completed_at > now() - interval '30 days' and o.service_id is not null group by o.service_id
    ), ratings as (
      select o.service_id, count(*)::int as reviews_30d, avg(r.rating) as avg_rating_30d from app.reviews r join app.orders o on o.id = r.order_id
        join app.users b on b.id = o.buyer_id and (${test} or not b.is_test)
      where r.created_at > now() - interval '30 days' and o.service_id is not null group by o.service_id
    ), views as (
      select service_id, count(*)::int as views_7d from app.service_views where view_date > current_date - 7 group by service_id
    )
    select s.id, v.title, v.taxonomy, v.price_minor, v.currency, v.turnaround_hours, u.display_name as creator_name, p.handle,
      c.completed_30d, coalesce(r.reviews_30d, 0) as reviews_30d, round(r.avg_rating_30d, 2) as avg_rating_30d, coalesce(w.views_7d, 0) as views_7d,
      round((3 * c.completed_30d + case when coalesce(r.reviews_30d, 0) > 0 then 2 * (r.avg_rating_30d - 3) * least(r.reviews_30d, 5) / 5.0 else 0 end
        + ln(1 + coalesce(w.views_7d, 0)))::numeric, 4) as score
    from completed c
    join app.services s on s.id = c.service_id and s.status = 'PUBLISHED'
    join app.service_versions v on v.id = s.published_version_id
    join app.users u on u.id = s.creator_id and u.status = 'ACTIVE' and (${test} or not u.is_test)
    left join app.profiles p on p.user_id = s.creator_id
    left join ratings r on r.service_id = s.id
    left join views w on w.service_id = s.id
    where c.completed_30d >= ${TRENDING_FORMULA.eligibility.completed_orders_30d_min} and coalesce(w.views_7d, 0) >= ${TRENDING_FORMULA.eligibility.eligible_views_7d_min}
      and (${niche}::text is null or lower(p.niche) = lower(${niche}::text)) and (${taxonomy}::text is null or v.taxonomy = ${taxonomy}::text)
    order by score desc, s.id asc limit ${limit}`;
  if (rows.length >= TRENDING_FORMULA.min_items_for_trending_label) {
    return { label: 'TRENDING' as const, formula: TRENDING_FORMULA, items: rows };
  }
  const fresh = await db<Row[]>`select s.id, v.title, v.taxonomy, v.price_minor, v.currency, v.turnaround_hours, u.display_name as creator_name, p.handle, v.created_at as published_at
    from app.services s join app.service_versions v on v.id = s.published_version_id join app.users u on u.id = s.creator_id and u.status = 'ACTIVE' and (${test} or not u.is_test)
    left join app.profiles p on p.user_id = s.creator_id where s.status = 'PUBLISHED'
      and (${niche}::text is null or lower(p.niche) = lower(${niche}::text)) and (${taxonomy}::text is null or v.taxonomy = ${taxonomy}::text)
    order by v.created_at desc, s.id desc limit ${limit}`;
  return { label: 'COLD_START' as const, formula: TRENDING_FORMULA, note: 'Not enough completed demand yet to call anything trending; showing newly published services.', items: fresh.map((row) => ({ ...row, badge: 'NEW' })) };
}
