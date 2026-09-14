import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { RUN_DB, ORIGIN, callRoute, commandInstant, createUser, key, runId, sessionState, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const servicesRoute = await import('@/app/api/discovery/services/route');
const creatorsRoute = await import('@/app/api/discovery/creators/route');
const auctionsRoute = await import('@/app/api/discovery/auctions/route');
const trendingRoute = await import('@/app/api/discovery/trending/route');
const viewRoute = await import('@/app/api/services/[id]/view/route');
const { discoveryRoute } = await import('@/modules/discovery/http');
const views = await import('@/modules/discovery/views');
const seo = await import('@/lib/seo');
const robots = (await import('@/app/robots')).default;
const nextConfig = (await import('../../next.config')).default;
const { sql } = await import('@/lib/db');

const command = (actor: TestUser, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const TOKEN = `zq${runId.replace(/-/g, '')}x`;
const NICHE = `niche ${runId}`;

type Json = Record<string, unknown> & { items: Record<string, unknown>[]; next_cursor: string | null };
async function get(handler: (request: Request) => Promise<Response>, path: string): Promise<{ status: number; body: Json }> {
  const response = await handler(new Request(`${ORIGIN}${path}`));
  return { status: response.status, body: (await response.json()) as Json };
}
const services = (query: string) => get(servicesRoute.GET, `/api/discovery/services?${query}`);
const ids = (body: Json) => body.items.map((item) => String(item.id));

async function creatorWithProfile(label: string, niche = NICHE): Promise<TestUser> {
  const user = await createUser(label);
  const handle = `h${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await sql`insert into app.profiles (user_id,handle,bio,niche) values (${user.id},${handle},${`Bio for ${label} creator`},${niche})`;
  return user;
}

async function publish(creator: TestUser, input: { title: string; taxonomy?: string; price: string; turnaround: string; capacity?: string }) {
  const created = await command(creator, {
    command: 'create_service', idempotency_key: key('svc'), title: input.title, description: `Scope for ${input.title} with deliverables and exclusions.`,
    taxonomy: input.taxonomy ?? 'CREATE', price: input.price, turnaround_hours: input.turnaround,
    sample_url_1: 'https://example.com/1', sample_title_1: 'Sample one', sample_url_2: 'https://example.com/2', sample_title_2: 'Sample two',
    sample_url_3: 'https://example.com/3', sample_title_3: 'Sample three',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const serviceId = String(created.body.id);
  expect((await command(creator, { command: 'publish_service', idempotency_key: key('pub'), service_id: serviceId })).status).toBe(200);
  // `capacity` sets the creator's active-order limit, shared by all of their services.
  if (input.capacity) expect((await command(creator, { command: 'set_workload_limit', idempotency_key: key('limit'), max_active_units: input.capacity })).status).toBe(200);
  return { serviceId };
}

async function allPages(query: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await services(`${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(result.status).toBe(200);
    seen.push(...ids(result.body));
    cursor = result.body.next_cursor;
    if (!cursor) break;
  }
  return seen;
}

afterAll(async () => {
  if (RUN_DB) await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('DSC-01/02/05 — service search, filters, pagination and freshness', () => {
  it('DSC-01: filters and sorts return exactly the eligible published services with stable keyset pages', async () => {
    const creator = await creatorWithProfile('dsc01');
    const suspended = await creatorWithProfile('dsc01-suspended');
    const video = await publish(creator, { title: `${TOKEN} launch video`, price: '100', turnaround: '24' });
    const newsletter = await publish(creator, { title: `${TOKEN} newsletter placement`, taxonomy: 'PUBLISH', price: '300', turnaround: '72' });
    const story = await publish(creator, { title: `${TOKEN} brand story`, price: '200', turnaround: '48' });
    const paused = await publish(creator, { title: `${TOKEN} paused access`, taxonomy: 'ACCESS', price: '50', turnaround: '12' });
    await command(creator, { command: 'pause_service', idempotency_key: key('p'), service_id: paused.serviceId });
    const archived = await publish(creator, { title: `${TOKEN} archived thing`, price: '80', turnaround: '12' });
    await command(creator, { command: 'archive_service', idempotency_key: key('a'), service_id: archived.serviceId });
    await command(creator, { command: 'create_service', idempotency_key: key('draft'), title: `${TOKEN} draft only`, description: 'Draft scope that is never published anywhere.', taxonomy: 'CREATE', price: '90', turnaround_hours: '10' });
    await publish(suspended, { title: `${TOKEN} suspended creator`, price: '120', turnaround: '24' });
    await sql`update app.users set status='SUSPENDED' where id=${suspended.id}`;

    const base = `q=${TOKEN}`;
    expect(new Set(ids((await services(base)).body))).toEqual(new Set([video.serviceId, newsletter.serviceId, story.serviceId]));
    expect(ids((await services(`${base}&taxonomy=CREATE&sort=price_asc`)).body)).toEqual([video.serviceId, story.serviceId]);
    expect(ids((await services(`${base}&price_min=150&sort=price_asc`)).body)).toEqual([story.serviceId, newsletter.serviceId]);
    expect(ids((await services(`${base}&price_max=150`)).body)).toEqual([video.serviceId]);
    expect(ids((await services(`${base}&turnaround_max=48&sort=turnaround`)).body)).toEqual([video.serviceId, story.serviceId]);
    expect(ids((await services(`${base}&niche=${encodeURIComponent(NICHE.toUpperCase())}&sort=price_desc`)).body)).toEqual([newsletter.serviceId, story.serviceId, video.serviceId]);
    expect((await services(`${base}&niche=nobody-${runId}`)).body.items).toEqual([]);
    expect(ids((await services(`q=${TOKEN}+launch`)).body)).toEqual([video.serviceId]);
    expect(ids((await services(`q=${TOKEN.slice(0, -1)}`)).body)).toHaveLength(3);
    const relevance = await services(`q=${TOKEN}+story&sort=relevance`);
    expect(ids(relevance.body)[0]).toBe(story.serviceId);
    expect(relevance.body.ranking).toMatch(/ts_rank_cd/);
    const first = (await services(base)).body.items.find((item) => item.id === video.serviceId)!;
    expect(first).toMatchObject({ taxonomy: 'CREATE', price_minor: '10000', turnaround_hours: 24, availability_status: 'ACCEPTING' });
    expect(first).not.toHaveProperty('search_document');
    expect(first).not.toHaveProperty('held_units');

    for (const sort of ['price_asc', 'price_desc', 'turnaround', 'newest']) {
      expect(await allPages(`${base}&sort=${sort}`, 1)).toEqual(ids((await services(`${base}&sort=${sort}`)).body));
    }
    const cursor = (await services(`${base}&sort=price_asc&limit=1`)).body.next_cursor!;
    expect((await services(`${base}&sort=newest&cursor=${cursor}`)).status).toBe(400);
    expect((await services(`${base}&cursor=not-a-cursor`)).status).toBe(400);
    expect((await services(`${base}&sort=popularity`)).status).toBe(400);
    expect((await services('sort=relevance')).status).toBe(400);
    expect((await services(`${base}&taxonomy=NFT`)).status).toBe(400);
    expect((await services(`${base}&limit=0`)).status).toBe(400);
    expect((await services(`${base}&price_min=5&price_max=1`)).status).toBe(400);
    expect((await services(`q=${encodeURIComponent("' or 1=1 --")}`)).status).toBe(200);
  });

  it('DSC-02/05: empty results and outages are explicit; paused, at-capacity and paused-creator listings update at once and stay server-safe', async () => {
    expect((await services(`q=nothing${runId.replace(/-/g, '')}`)).body).toMatchObject({ items: [], next_cursor: null });
    const outage = await discoveryRoute(async () => { throw new Error('connection terminated'); });
    expect(outage.status).toBe(503);
    expect(await outage.json()).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE', retryable: true });

    const creator = await creatorWithProfile('dsc05');
    const buyer = await createUser('dsc05-buyer');
    const token = `${TOKEN}f`;
    const soldOut = await publish(creator, { title: `${token} sold out soon`, price: '150', turnaround: '24', capacity: '1' });
    const pausing = await publish(creator, { title: `${token} pausing soon`, price: '160', turnaround: '24' });
    expect(new Set(ids((await services(`q=${token}&available=true`)).body))).toEqual(new Set([soldOut.serviceId, pausing.serviceId]));

    await command(creator, { command: 'pause_service', idempotency_key: key('p'), service_id: pausing.serviceId });
    expect(ids((await services(`q=${token}`)).body)).toEqual([soldOut.serviceId]);
    // One booking fills the creator's single place: the card turns AT_CAPACITY without exposing counts.
    expect((await command(buyer, { command: 'book', idempotency_key: key('b'), service_id: soldOut.serviceId, brief: 'First booking takes the creator\'s only place.' })).status).toBe(200);
    expect(ids((await services(`q=${token}&available=true`)).body)).toEqual([]);
    expect((await services(`q=${token}`)).body.items[0]).toMatchObject({ id: soldOut.serviceId, availability_status: 'AT_CAPACITY' });
    const stale = await command(await createUser('dsc05-late'), { command: 'book', idempotency_key: key('b'), service_id: soldOut.serviceId, brief: 'Booking from a stale listing card should be refused.' });
    expect(stale.status).toBe(409);
    expect((await command(creator, { command: 'set_accepting_orders', idempotency_key: key('pause'), accepting: 'false' })).status).toBe(200);
    expect((await services(`q=${token}`)).body.items[0]).toMatchObject({ id: soldOut.serviceId, availability_status: 'PAUSED' });
    expect((await services(`q=${token}&available_before=2000-01-01`)).status).toBe(400);
    expect((await services(`q=${token}&sort=availability`)).status).toBe(400);
  });
});

describe.skipIf(!RUN_DB)('DSC-03/04 — ending soon, trending and eligible views', () => {
  it('DSC-03: ending soon lists only live auctions by server time, soonest first', async () => {
    const seller = await creatorWithProfile('dsc03');
    const { serviceId } = await publish(seller, { title: `${TOKEN} auction slot`, price: '100', turnaround: '24', capacity: '5' });
    const create = async (endsInMs: number) => {
      const created = await command(seller, { command: 'create_auction', idempotency_key: key('auc'), service_id: serviceId, starting_price: '100', minimum_increment: '10',
        starts_at: commandInstant(new Date(Date.now() - 60_000)), ends_at: commandInstant(new Date(Date.now() + endsInMs)) });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      return String(created.body.id);
    };
    const later = await create(2 * 3600_000);
    const sooner = await create(30 * 60_000);
    const farAway = await create(100 * 3600_000);
    const ended = await create(3600_000);
    await sql`update app.auctions set ends_at=now() - interval '1 second', starts_at=now() - interval '2 hours' where id=${ended}`;
    expect((await sql`select status from app.auctions where id=${ended}`)[0]!.status).toBe('LIVE');

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 30; page++) {
      const result = await get(auctionsRoute.GET, `/api/discovery/auctions?within_hours=3&limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      expect(result.status).toBe(200);
      expect(result.body.server_now).toBeTruthy();
      seen.push(...ids(result.body));
      cursor = result.body.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toContain(sooner);
    expect(seen).toContain(later);
    expect(seen.indexOf(sooner)).toBeLessThan(seen.indexOf(later));
    expect(seen).not.toContain(ended);
    expect(seen).not.toContain(farAway);
    expect((await get(auctionsRoute.GET, '/api/discovery/auctions?within_hours=500')).status).toBe(400);
  });

  it('DSC-04: without evidence the view is COLD_START; trending needs completed demand and eligible views, ranked by the documented formula', async () => {
    const niche = `trend ${runId}`;
    const creator = await creatorWithProfile('dsc04', niche);
    const buyer = await createUser('dsc04-buyer');
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await publish(creator, { title: `${TOKEN} trend ${i}`, price: String(100 + i), turnaround: '24', capacity: '10' }));
    const trending = (query = '') => get(() => trendingRoute.GET(new Request(`${ORIGIN}/api/discovery/trending?niche=${encodeURIComponent(niche)}${query}`)), '/x');
    const cold = await trending();
    expect(cold.body).toMatchObject({ label: 'COLD_START', formula: expect.objectContaining({ version: 'trending-v1' }) });
    expect(cold.body.items.every((item) => item.badge === 'NEW' && !('score' in item))).toBe(true);

    const evidence = async (serviceId: string, completed: number, viewCount: number, rating?: number) => {
      for (let i = 0; i < completed; i++) {
        const [order] = await sql`insert into app.orders (buyer_id,creator_id,service_id,source,title,status,amount_minor,currency,brief,completed_at,payment_status,settlement_status)
          values (${buyer.id},${creator.id},${serviceId},'BOOK','Trend evidence','COMPLETED',10000,'USD','Completed order used as trending evidence.',now() - interval '2 days','SUCCEEDED','RELEASED') returning id`;
        if (rating && i === 0) await sql`insert into app.reviews (order_id,buyer_id,creator_id,reviewer_id,rating,body) values (${String(order!.id)},${buyer.id},${creator.id},${buyer.id},${rating},'Great work')`;
      }
      for (let i = 0; i < viewCount; i++) {
        await sql`insert into app.service_views (service_id,viewer_hash,view_date) values (${serviceId},${createHash('sha256').update(`${serviceId}:${i}`).digest('hex')},current_date - 1)`;
      }
    };
    await evidence(made[0]!.serviceId, 3, 20);
    await evidence(made[1]!.serviceId, 5, 40, 5);
    expect((await trending()).body.label).toBe('COLD_START');
    await evidence(made[2]!.serviceId, 3, 19, 1);
    await evidence(made[3]!.serviceId, 2, 100);
    expect((await trending()).body.label).toBe('COLD_START');
    await sql`insert into app.service_views (service_id,viewer_hash,view_date) values (${made[2]!.serviceId},${createHash('sha256').update(`${made[2]!.serviceId}:extra`).digest('hex')},current_date)`;
    const hot = await trending();
    expect(hot.body.label).toBe('TRENDING');
    // made[3] has plenty of views but only two completed orders, so it is never trending.
    expect(ids(hot.body)).toEqual([made[1]!.serviceId, made[0]!.serviceId, made[2]!.serviceId]);
    const top = hot.body.items[0]!;
    expect(top).toMatchObject({ completed_30d: 5, views_7d: 40, reviews_30d: 1 });
    expect(Number(top.score)).toBeCloseTo(3 * 5 + 2 * (5 - 3) * (1 / 5) + Math.log(41), 3);
    expect(Number(hot.body.items[2]!.score)).toBeCloseTo(3 * 3 + 2 * (1 - 3) * (1 / 5) + Math.log(21), 3);
    expect((await trending('&taxonomy=PUBLISH')).body.label).toBe('COLD_START');
    // In production the fixture buyer's orders are not demand and the fixture creator is not listed at all.
    vi.stubEnv('APP_ENV', 'production');
    try {
      expect((await trending()).body).toMatchObject({ label: 'COLD_START', items: [] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('counts one eligible view per viewer per day, never the owner, and caps a single viewer', async () => {
    const creator = await creatorWithProfile('views');
    const visitor = await createUser('views-visitor');
    const { serviceId } = await publish(creator, { title: `${TOKEN} viewed`, price: '100', turnaround: '24' });
    const anon = { serviceId, actor: null, clientKey: '203.0.113.9|Mozilla/5.0 test' };
    expect(await views.recordServiceView(anon)).toEqual({ counted: true });
    expect(await views.recordServiceView(anon)).toEqual({ counted: false, reason: 'ALREADY_COUNTED_TODAY' });
    expect(await views.recordServiceView({ ...anon, clientKey: 'x' })).toEqual({ counted: false, reason: 'NO_VIEWER_KEY' });
    const asUser = (user: TestUser) => ({ id: user.id, email: user.email, display_name: 'x', roles: ['buyer', 'creator'], is_test: true, status: 'ACTIVE' as const, timezone: 'UTC' });
    expect(await views.recordServiceView({ serviceId, actor: asUser(creator), clientKey: '' })).toEqual({ counted: false, reason: 'OWNER' });
    expect(await views.recordServiceView({ serviceId, actor: asUser(visitor), clientKey: '' })).toEqual({ counted: true });
    expect(await views.recordServiceView({ serviceId: randomUUID(), actor: null, clientKey: anon.clientKey })).toEqual({ counted: false, reason: 'NOT_FOUND' });
    const stored = await sql`select viewer_hash from app.service_views where service_id=${serviceId}`;
    expect(stored.every((row) => /^[0-9a-f]{64}$/.test(String(row.viewer_hash)) && !String(row.viewer_hash).includes('203'))).toBe(true);

    const busy = { actor: null, clientKey: '198.51.100.7|Busy bot' };
    for (let i = 0; i < views.MAX_COUNTED_SERVICES_PER_VIEWER_PER_DAY; i++) {
      await sql`insert into app.service_views (service_id,viewer_hash,view_date) values (${(await publish(creator, { title: `${TOKEN} cap ${i}`, price: '100', turnaround: '24' })).serviceId},${views.viewerHashFor(`anon:${busy.clientKey}`)},current_date)`;
    }
    expect(await views.recordServiceView({ serviceId, ...busy })).toEqual({ counted: false, reason: 'DAILY_CAP' });

    sessionState.token = null;
    const crossSite = await viewRoute.POST(new Request(`${ORIGIN}/api/services/${serviceId}/view`, { method: 'POST', headers: { origin: 'https://evil.example' } }), { params: Promise.resolve({ id: serviceId }) });
    expect(crossSite.status).toBe(403);
  }, 120_000);
});

describe.skipIf(!RUN_DB)('P5-05/06 — creator discovery and public SEO surfaces', () => {
  it('creators are found by profile, niche, category and availability; ratings need three reviews', async () => {
    const niche = `creators ${runId}`;
    const rated = await creatorWithProfile('dsc-rated', niche);
    const fresh = await creatorWithProfile('dsc-fresh', niche);
    const buyer = await createUser('dsc-creator-buyer');
    await publish(rated, { title: `${TOKEN} rated work`, taxonomy: 'PUBLISH', price: '300', turnaround: '24' });
    await publish(fresh, { title: `${TOKEN} fresh work`, price: '90', turnaround: '24' });
    for (const rating of [5, 4, 5]) {
      const [order] = await sql`insert into app.orders (buyer_id,creator_id,source,title,status,amount_minor,currency,brief,completed_at,payment_status,settlement_status)
        values (${buyer.id},${rated.id},'BOOK','Rated order','COMPLETED',10000,'USD','Completed order with a review for reputation.',now(),'SUCCEEDED','RELEASED') returning id`;
      await sql`insert into app.reviews (order_id,buyer_id,creator_id,reviewer_id,rating,body) values (${String(order!.id)},${buyer.id},${rated.id},${buyer.id},${rating},'Solid delivery')`;
    }
    const search = (query: string) => get(creatorsRoute.GET, `/api/discovery/creators?${query}`);
    const byNiche = await search(`niche=${encodeURIComponent(niche)}&sort=reputation`);
    expect(ids(byNiche.body)).toEqual([rated.id, fresh.id]);
    expect(byNiche.body.items[0]).toMatchObject({ reputation_label: 'RATED', review_count: 3, completed_orders: 3, services_count: 1, min_price_minor: '30000' });
    expect(Number(byNiche.body.items[0]!.avg_rating)).toBeCloseTo(4.67, 2);
    expect(byNiche.body.items[1]).toMatchObject({ reputation_label: 'NEW', avg_rating: null });
    expect(ids((await search(`niche=${encodeURIComponent(niche)}&taxonomy=PUBLISH`)).body)).toEqual([rated.id]);
    expect(ids((await search(`q=${encodeURIComponent(niche.split(' ')[1]!)}&niche=${encodeURIComponent(niche)}`)).body).sort()).toEqual([rated.id, fresh.id].sort());
    expect(ids((await search(`niche=${encodeURIComponent(niche)}&available=true`)).body)).toHaveLength(2);
    expect((await search(`niche=${encodeURIComponent(niche)}`)).body.items[0]).toMatchObject({ availability_status: 'ACCEPTING' });
    expect((await search('sort=availability')).status).toBe(400);
    const page = await search(`niche=${encodeURIComponent(niche)}&sort=reputation&limit=1`);
    expect(ids((await search(`niche=${encodeURIComponent(niche)}&sort=reputation&limit=1&cursor=${page.body.next_cursor}`)).body)).toEqual([fresh.id]);
    expect((await search('sort=followers')).status).toBe(400);
  });

  it('P5-06: the sitemap lists only public eligible records and private surfaces are noindex', async () => {
    const email = `public-${randomUUID().slice(0, 8)}@example.test`;
    const [user] = await sql<{ id: string }[]>`insert into app.users (email,display_name,roles,is_test,status) values (${email},'Public creator',${['buyer', 'creator']},false,'ACTIVE') returning id`;
    const { createSession } = await import('@/lib/auth');
    const publicCreator: TestUser = { id: user!.id, email, token: await createSession(user!.id) };
    const handle = `pub${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await sql`insert into app.profiles (user_id,handle,niche) values (${user!.id},${handle},'Public niche')`;
    const listed = await publish(publicCreator, { title: `${TOKEN} public listing`, price: '100', turnaround: '24' });
    const testOnly = await publish(await creatorWithProfile('seo-test-user'), { title: `${TOKEN} test fixture listing`, price: '100', turnaround: '24' });
    let urls = (await seo.getSitemapEntries()).map((entry) => entry.url);
    expect(urls).toContain(seo.canonicalUrl(`/services/${listed.serviceId}`));
    expect(urls).toContain(seo.canonicalUrl(`/creators/${handle}`));
    expect(urls).not.toContain(seo.canonicalUrl(`/services/${testOnly.serviceId}`));
    expect(urls.some((url) => /\/(orders|dashboard|admin|buyer|settings)\b/.test(url))).toBe(false);

    // Fixture (is_test) supply is discoverable locally but never listed as real supply in production.
    const [fixture] = await sql`select p.handle from app.services s join app.profiles p on p.user_id=s.creator_id where s.id=${testOnly.serviceId}`;
    const listedBy = async (creatorHandle: string) => ids((await services(`creator=${creatorHandle}`)).body);
    expect(await listedBy(String(fixture!.handle))).toEqual([testOnly.serviceId]);
    vi.stubEnv('APP_ENV', 'production');
    try {
      expect(await listedBy(String(fixture!.handle))).toEqual([]);
      expect(await listedBy(handle)).toEqual([listed.serviceId]);
      const found = (await get(creatorsRoute.GET, `/api/discovery/creators?niche=${encodeURIComponent('Public niche')}&limit=48`)).body;
      expect(ids(found)).toContain(publicCreator.id);
      const fixtureCreators = (await get(creatorsRoute.GET, `/api/discovery/creators?niche=${encodeURIComponent(NICHE)}&limit=48`)).body;
      expect(fixtureCreators.items).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }

    await command(publicCreator, { command: 'pause_service', idempotency_key: key('p'), service_id: listed.serviceId });
    urls = (await seo.getSitemapEntries()).map((entry) => entry.url);
    expect(urls).not.toContain(seo.canonicalUrl(`/services/${listed.serviceId}`));

    const rules = robots();
    expect(JSON.stringify(rules.rules)).toContain('"disallow":"/"');
    const headers = await nextConfig.headers!();
    const orders = headers.find((entry) => entry.source === '/orders/:path*');
    expect(orders?.headers).toEqual([{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]);
    expect(headers.some((entry) => entry.source.startsWith('/services'))).toBe(false);
  });
});
