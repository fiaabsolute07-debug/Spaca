/**
 * DSC-06 / P5-07 discovery benchmark. Generates 5,000 published services (1,000 creators, 8 weekly buckets each),
 * 500 live auctions with 50,000 bids, 5,000 completed orders, 2,500 reviews and 30,000 eligible views inside ONE
 * transaction on a local database, runs the real discovery queries, checks critical plans, then ROLLS BACK.
 *
 *   tsx scripts/discovery-benchmark.ts            (defaults to the local test database)
 *
 * Refuses non-local targets (FND-07 guard). Latency targets are for this local machine only, not a production SLO.
 */
import postgres from 'postgres';
import { assertLocalDatabaseTarget } from '../src/lib/fixtures';

const url = process.env.BENCHMARK_DATABASE_URL ?? 'postgres://postgres:local_dev_only@127.0.0.1:55432/creator_marketplace_test';
process.env.DATABASE_URL ??= url;
const target = assertLocalDatabaseTarget(url);

const { parseCreatorSearch, parseEndingSoon, parseServiceSearch } = await import('../src/modules/discovery/params');
const { endingSoonAuctions, searchCreators, searchServices } = await import('../src/modules/discovery/search');
const { trendingServices } = await import('../src/modules/discovery/trending');
const { sql: poolSql } = await import('../src/lib/db');

const TARGET_P95_MS: Record<string, number> = {
  'services: full-text relevance': 250, 'services: taxonomy + price, price_asc': 250, 'services: available, availability sort': 300,
  'services: newest page 2 (cursor)': 250, 'creators: reputation': 400, 'auctions: ending soon 48h': 150, 'trending-v1': 400,
};

class Rollback extends Error {}
const client = postgres(url, { max: 1, connect_timeout: 10 });
type Timing = { name: string; p50: number; p95: number; target: number; pass: boolean; rows: number };
const timings: Timing[] = [];
const plans: { name: string; pass: boolean; detail: string }[] = [];
const counts: Record<string, number> = {};

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

try {
  await client.begin(async (tx) => {
    const t0 = performance.now();
    await tx`insert into app.users (email,display_name,roles,is_test,status)
      select 'bench-creator-'||g||'@example.test','Bench creator '||g,array['buyer','creator'],true,'ACTIVE' from generate_series(1,1000) g`;
    await tx`insert into app.users (email,display_name,roles,is_test,status)
      select 'bench-buyer-'||g||'@example.test','Bench buyer '||g,array['buyer'],true,'ACTIVE' from generate_series(1,2000) g`;
    await tx`create temp table bench_creators on commit drop as select id, row_number() over (order by email) as n from app.users where email like 'bench-creator-%'`;
    await tx`create temp table bench_buyers on commit drop as select id, row_number() over (order by email) as n from app.users where email like 'bench-buyer-%'`;
    await tx`insert into app.profiles (user_id,handle,bio,niche)
      select id,'bench'||n,'Independent creator focused on launches, video and newsletters #'||n,
        (array['launch writing','video editing','podcast production','newsletter','ux copy','illustration','community','tutorials','reviews','brand strategy'])[1 + (n % 10)]
      from bench_creators`;
    await tx`insert into app.capacity_pools (creator_id,name,timezone,weekly_units) select id,'Bench pool '||n,'UTC',5 from bench_creators`;
    await tx`create temp table bench_pools on commit drop as select p.id as pool_id, c.id as creator_id, c.n from app.capacity_pools p join bench_creators c on c.id=p.creator_id`;
    await tx`insert into app.capacity_buckets (pool_id,starts_at,ends_at,local_week_start,timezone,total_units)
      select pool_id, date_trunc('week', now()) + w * interval '1 week', date_trunc('week', now()) + (w + 1) * interval '1 week',
        (date_trunc('week', now()) + w * interval '1 week')::date, 'UTC', 5
      from bench_pools cross join generate_series(0, 7) w on conflict do nothing`;
    await tx`create temp table bench_services on commit drop as
      select gen_random_uuid() as id, p.creator_id, p.pool_id, g,
        'Bench ' || (array['launch','story','video','podcast','thread','newsletter','review','tutorial','design','copy'])[1 + (g % 10)] || ' '
          || (array['package','sprint','series','audit','kit','plan','campaign','session','pack','draft'])[1 + ((g / 7) % 10)] || ' ' || g as title,
        (array['CREATE','PUBLISH','ACCESS','DIGITAL'])[1 + (g % 4)] as taxonomy, (5000 + (g * 37) % 200000)::bigint as price_minor, (12 + (g % 20) * 12) as turnaround_hours
      from generate_series(1, 5000) g join bench_pools p on p.n = 1 + (g % 1000)`;
    await tx`insert into app.services (id,creator_id,pool_id,title,description,taxonomy,price_minor,currency,turnaround_hours,status)
      select id,creator_id,pool_id,title,'Scope for '||title||' including deliverables, revisions and usage notes.',taxonomy,price_minor,'USD',turnaround_hours,'DRAFT' from bench_services`;
    await tx`insert into app.service_versions (service_id,version,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,pool_id,created_by,created_at)
      select id,1,title,'Scope for '||title||' including deliverables, revisions and usage notes.',taxonomy,price_minor,'USD',turnaround_hours,1,pool_id,creator_id,now() - (g * interval '1 minute') from bench_services`;
    await tx`update app.services s set status='PUBLISHED',published_version_id=v.id from app.service_versions v where v.service_id=s.id and s.id in (select id from bench_services)`;
    await tx`create temp table bench_auctions on commit drop as
      select gen_random_uuid() as id, s.id as service_id, s.creator_id, s.title, series.n as g from generate_series(1, 500) as series(n) join bench_services s on s.g = series.n * 10`;
    await tx`insert into app.auctions (id,service_id,seller_id,title,starting_price_minor,minimum_increment_minor,starts_at,ends_at,status)
      select id,service_id,creator_id,title,10000,500,now() - interval '1 hour',now() + ((g % 48) + 1) * interval '1 hour','LIVE' from bench_auctions`;
    await tx`insert into app.bids (auction_id,bidder_id,amount_minor,sequence,request_key,created_at)
      select a.id, b.id, 10000 + k * 500, k, gen_random_uuid()::text, now() - interval '30 minutes' + k * interval '1 second'
      from bench_auctions a cross join generate_series(1, 100) k join bench_buyers b on b.n = 1 + ((a.g * 100 + k) % 2000)`;
    await tx`create temp table bench_orders on commit drop as
      select gen_random_uuid() as id, s.id as service_id, s.creator_id, b.id as buyer_id, o as n
      from generate_series(1, 5000) o join bench_services s on s.g = 1 + ((o * 13) % 500) * 10 join bench_buyers b on b.n = 1 + (o % 2000)`;
    await tx`insert into app.orders (id,buyer_id,creator_id,service_id,source,title,status,amount_minor,currency,brief,completed_at,payment_status,settlement_status)
      select id,buyer_id,creator_id,service_id,'BOOK','Bench order','COMPLETED',10000,'USD','Benchmark completed order for trending inputs.',now() - ((n % 29) * interval '1 day'),'SUCCEEDED','RELEASED' from bench_orders`;
    await tx`insert into app.reviews (order_id,buyer_id,creator_id,reviewer_id,rating,body)
      select id,buyer_id,creator_id,buyer_id,1 + (n % 5),'Benchmark review' from bench_orders where n % 2 = 0`;
    await tx`insert into app.service_views (service_id,viewer_hash,view_date)
      select s.id, encode(sha256(convert_to(s.id::text || ':' || v, 'UTF8')), 'hex'), current_date - (v % 6)
      from generate_series(1, 30000) v join bench_services s on s.g = 1 + ((v * 7) % 5000) on conflict do nothing`;
    // Bulk inserts sit in the GIN pending lists until autovacuum flushes them; flush now so plans reflect steady state.
    await tx`select gin_clean_pending_list('app.service_versions_search_idx'::regclass), gin_clean_pending_list('app.profiles_search_idx'::regclass)`;
    await tx`analyze`;
    for (const table of ['services', 'service_versions', 'auctions', 'bids', 'orders', 'reviews', 'service_views', 'capacity_buckets']) {
      counts[table] = Number((await tx.unsafe(`select count(*)::int as n from app.${table}`))[0]!.n);
    }
    console.log(`generated in ${Math.round(performance.now() - t0)} ms`, counts);

    const nextCursor = (await searchServices(parseServiceSearch(new URLSearchParams('limit=24')), tx)).next_cursor;
    const cases: [string, () => Promise<{ items: unknown[] }>][] = [
      ['services: full-text relevance', () => searchServices(parseServiceSearch(new URLSearchParams('q=launch package')), tx)],
      ['services: taxonomy + price, price_asc', () => searchServices(parseServiceSearch(new URLSearchParams('taxonomy=CREATE,PUBLISH&price_min=100&price_max=900&sort=price_asc')), tx)],
      ['services: available, availability sort', () => searchServices(parseServiceSearch(new URLSearchParams('available=true&sort=availability')), tx)],
      ['services: newest page 2 (cursor)', () => searchServices(parseServiceSearch(new URLSearchParams(`limit=24&cursor=${nextCursor}`)), tx)],
      ['creators: reputation', () => searchCreators(parseCreatorSearch(new URLSearchParams('sort=reputation')), tx)],
      ['auctions: ending soon 48h', () => endingSoonAuctions(parseEndingSoon(new URLSearchParams('within_hours=48')), tx)],
      ['trending-v1', () => trendingServices({}, tx)],
    ];
    for (const [name, run] of cases) {
      for (let i = 0; i < 3; i++) await run();
      const samples: number[] = [];
      let rows = 0;
      for (let i = 0; i < 25; i++) {
        const start = performance.now();
        rows = (await run()).items.length;
        samples.push(performance.now() - start);
      }
      const p95 = percentile(samples, 95);
      timings.push({ name, p50: Math.round(percentile(samples, 50) * 10) / 10, p95: Math.round(p95 * 10) / 10, target: TARGET_P95_MS[name]!, pass: p95 <= TARGET_P95_MS[name]! && rows > 0, rows });
    }

    type PlanNode = { 'Node Type': string; 'Relation Name'?: string; Plans?: PlanNode[] };
    const seqScanOn = (plan: string, relation: string) => {
      const walk = (node: PlanNode): boolean => (node['Node Type'] === 'Seq Scan' && node['Relation Name'] === relation) || (node.Plans ?? []).some(walk);
      return (JSON.parse(plan) as { 'QUERY PLAN': { Plan: PlanNode }[] }[]).some((row) => row['QUERY PLAN'].some((q) => walk(q.Plan)));
    };
    const planOf = async (query: string) => JSON.stringify(await tx.unsafe(`explain (format json) ${query}`));
    const checks: [string, string, (plan: string) => boolean][] = [
      // A selective term must use the GIN index; broad prefixes over a few thousand small rows may legitimately scan.
      ['selective full-text match uses the GIN index', `select v.id from app.service_versions v where v.search_document @@ to_tsquery('simple','4242')`, (p) => p.includes('service_versions_search_idx')],
      ['highest valid bid uses the ranking index', `select id from app.bids where auction_id=(select id from app.auctions where status='LIVE' limit 1) and status='ACCEPTED' order by amount_minor desc, sequence asc limit 1`, (p) => p.includes('bids_ranking_idx')],
      ['ending soon uses the partial ends_at index', `select id from app.auctions where status in ('SCHEDULED','LIVE') and ends_at > now() and ends_at <= now() + interval '48 hours' order by ends_at, id limit 13`, (p) => p.includes('auctions_ending_idx') || p.includes('auctions_due_idx') || p.includes('auctions_public_idx')],
      ['free bucket lookup uses a bucket index', `select starts_at from app.capacity_buckets b where b.pool_id=(select pool_id from app.capacity_pools limit 1) and b.reserved_units + b.committed_units < b.total_units order by starts_at limit 1`, (p) => /capacity_buckets_(free|pool_window)_idx|capacity_buckets_pool/.test(p)],
      ['recent views use a service_views index', `select service_id, count(*) from app.service_views where view_date > current_date - 7 and service_id=(select id from app.services where status='PUBLISHED' limit 1) group by service_id`, (p) => /service_views_(pkey|recent_idx)/.test(p) && !seqScanOn(p, 'service_views')],
      // Control: proves seqScanOn detects a seq scan, so the negative checks cannot pass vacuously.
      ['control: full bids count is detected as a seq scan', `select count(*) from app.bids where amount_minor + 0 >= 0`, (p) => seqScanOn(p, 'bids')],
      ['no sequential scan on bids for a single auction', `select count(*) from app.bids where auction_id=(select id from app.auctions limit 1)`, (p) => !seqScanOn(p, 'bids')],
    ];
    for (const [name, query, ok] of checks) {
      const plan = await planOf(query);
      const nodes = [...plan.matchAll(/"Node Type":"([^"]+)"(?:,"[^"]+":[^,]+)*?,"Relation Name":"([^"]+)"|"Index Name":"([^"]+)"/g)].map((m) => m[3] ?? `${m[1]}:${m[2]}`).slice(0, 6).join(', ');
      plans.push({ name, pass: ok(plan), detail: nodes || plan.slice(0, 160) });
    }
    throw new Rollback('benchmark data rolled back');
  });
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
} finally {
  await client.end();
  await poolSql.end({ timeout: 5 });
}

console.log(`\nDSC-06 discovery benchmark on ${target.host}/${target.database} (rolled back)`);
console.table(timings);
console.table(plans);
const failed = timings.filter((t) => !t.pass).length + plans.filter((p) => !p.pass).length;
console.log(failed ? `RESULT: ${failed} check(s) FAILED` : 'RESULT: all latency and plan checks passed (local machine targets)');
process.exitCode = failed ? 1 : 0;
