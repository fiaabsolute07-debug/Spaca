# W6-D evidence: P5 discovery, trending, eligible views, SEO surfaces (Claude, 2026-09-14)

Scope: master §16.8 P5-01..P5-07 and §18 DSC-01..DSC-06. Backend and HTTP contract only; the discovery UI is built separately by the user (see `docs/UI_CONTRACT.md` "W6-D additions").

Environment: **local only**.
- Embedded PostgreSQL (`creator_marketplace_test`, 127.0.0.1:55432) as `app_server`; Node v24.19.0 on Apple M1 Pro.
- No external search service, no cache layer, no network access. Benchmark data is generated inside one transaction and rolled back.

## What changed

- **Migration `drizzle/0011_discovery.sql`** (applied cleanly to a blank database and to the existing dev/test databases)
  - `service_versions.search_document`: generated `tsvector` (`simple` config; title A, description B, taxonomy C) with a GIN index. `simple` avoids language stemming because content is multilingual.
  - `profiles.search_document`: handle/niche A, bio B, GIN index; `lower(niche)` index.
  - Filter/sort indexes: `service_versions (taxonomy, price_minor, turnaround_hours)`, `(created_at desc, id)`, partial `services_published_idx`, partial `capacity_buckets_free_idx`, completed-order indexes by service and creator, `reviews_creator_idx`, partial `auctions_ending_idx`.
  - `app.service_views (service_id, viewer_hash, view_date)` primary key: one eligible view per viewer per service per day. Only a salted SHA-256 hash is stored (CHECK on 64 hex chars).
- **`src/modules/discovery/params.ts`**: allowlisted filters and sorts, bounded `limit`, search text reduced to AND-ed prefix terms over letters/digits (no tsquery operator injection), opaque base64url keyset cursors bound to the sort they were issued for. Invalid input returns 400 instead of being ignored.
- **`src/modules/discovery/search.ts`**
  - `searchServices`: PUBLISHED services of ACTIVE creators only, with the published immutable version's terms; earliest free capacity bucket that can still fit the turnaround; sorts relevance/newest/price_asc/price_desc/turnaround/availability, ties by id.
  - `searchCreators`: creators with at least one published service; completed orders, review count, rating only with ≥3 reviews (`reputation_label` RATED/NEW), public approved sample count, next availability. No follower metric exists or ranks.
  - `endingSoonAuctions`: SCHEDULED/LIVE auctions filtered by server `now()` (`starts_at <= now() < ends_at`), so an auction past `ends_at` is hidden even before the close job runs.
  - `includeTestData()`: `is_test` fixture accounts are discoverable locally (dev/E2E need data) but excluded when `APP_ENV=production` (master §5 line 128: seeded data must not appear as real in production).
- **`src/modules/discovery/trending.ts`** (formula `trending-v1`, returned with every response)
  - Eligible only with ≥3 completed orders in 30 days AND ≥20 eligible views in 7 days.
  - `score = 3·completed_30d + 2·(avg_rating_30d − 3)·min(reviews_30d,5)/5 + ln(1 + views_7d)`.
  - Fewer than 3 eligible services → `label: COLD_START`, newest published services with `badge: NEW`, no score or counts.
  - In production, orders and reviews from `is_test` buyers are not demand evidence.
- **`src/modules/discovery/views.ts`** + `POST /api/services/[id]/view`: same-origin only; owner views not counted; anonymous viewers need a client key; per-viewer daily cap of 50 counted services under an advisory lock; salt from `VIEW_HASH_SALT` (required when deployed via `scripts/lib/env-rules.ts`).
- **`src/modules/discovery/http.ts`**: `cache-control: no-store`; `CommandError` → 400; any other failure → 503 `TEMPORARILY_UNAVAILABLE`, `retryable: true`, `retry-after: 5`, and no items.
- **Routes**: `GET /api/discovery/{services,creators,auctions,trending}`.
- **SEO** (`src/lib/seo.ts`, `src/app/sitemap.ts`, `src/app/robots.ts`, `next.config.ts`)
  - Sitemap lists only public eligible records of non-test ACTIVE users: published services, creators with a published service, OPEN requests before their deadline, live auctions.
  - Robots disallows everything outside `APP_ENV=production`; in production it disallows the private prefixes.
  - `X-Robots-Tag: noindex, nofollow` on `/orders`, `/dashboard`, `/admin`, `/buyer`, `/creator`, `/settings`, `/api`, sign-in/up and password reset, independent of page metadata.
- **Jobs**: `extend_capacity_horizon` keeps weekly capacity buckets materialized for published services' pools so availability search sees future weeks; added to `runJobsOnce`.

## Review fixes made this session

1. **Test data in production discovery.** The uncommitted draft listed `is_test` creators and counted fixture orders as trending demand in every environment. Added `includeTestData()` and the production guards above, with tests. Mutation check: forcing `includeTestData = () => true` makes DSC-04 and P5-06 fail (2 failed / 5 passed), restored afterwards.
2. **Vacuous benchmark plan checks.** "recent views" only checked that the plan mentioned `service_views`, and the bids seq-scan check (`!A || !B`) could pass with a seq scan present. Replaced with a JSON plan walker (`seqScanOn`), required `service_views_pkey|service_views_recent_idx`, and added a control query that must be detected as a seq scan.

## Tests (`tests/integration/discovery.db.test.ts`, 7 tests)

| Test | Proves |
|---|---|
| DSC-01 filters and sorts | Exactly the published services of active creators; paused, archived, draft and suspended-creator listings excluded; taxonomy, price range, turnaround, niche (case-insensitive), prefix and multi-term search, relevance ordering; every sort paged with `limit=1` equals the single-page order; cursor from another sort, garbage cursor, unknown sort, relevance without q, unknown taxonomy, `limit=0`, inverted price range → 400; SQL-looking text → 200. |
| DSC-02/05 empty, outage, freshness | Empty search returns `items: []`, `next_cursor: null`; a thrown DB error returns 503 retryable with no items; pausing removes a listing at once; capacity set to 0 shows `available_units: 0`, drops out of `available=true`, and booking from the stale card is refused 409. |
| DSC-03 ending soon | Paged by server time soonest first; an auction past `ends_at` still in status LIVE is excluded; auctions beyond the window excluded; `within_hours=500` → 400. |
| DSC-04 trending | COLD_START with `badge: NEW` and no score without evidence; still COLD_START with only 2 eligible; a service with 100 views but 2 completed orders is never trending; 3 eligible → TRENDING in formula order with scores matching the formula; taxonomy filter → COLD_START; with `APP_ENV=production` fixture demand yields `COLD_START` with no items. |
| Eligible views | One per viewer per day, owner not counted, missing client key not counted, unknown service 404 reason, only 64-hex hashes stored, daily cap enforced, cross-origin POST → 403. |
| Creators | Niche, taxonomy, text and availability filters; reputation order; rating shown only at ≥3 reviews; cursor paging; `sort=followers` → 400. |
| P5-06 sitemap/noindex | Public non-test service and creator listed; fixture listing not listed; paused service removed; no private paths; robots disallow in non-production; `X-Robots-Tag` on `/orders/:path*` and not on `/services`. With `APP_ENV=production`, a fixture creator's services and creator card are not discoverable while the public creator still is. |

## Runs (this session)

- `RUN_DB_INTEGRATION=1 vitest run`: **222/222 tests, 22 files** passed.
- `tsc --noEmit -p tsconfig.json --incremental false`: exit 0.
- `tsx scripts/release-check.ts`: no FAIL lines.
- `tsx scripts/discovery-benchmark.ts` (DSC-06): generated on top of the existing test data ≈7.7k services, ≈800 auctions, ≈50.2k bids, ≈7.4k completed orders, ≈2.6k reviews, ≈31.6k views; 20 timed runs per query; rolled back.

| Query | p50 ms | p95 ms | Local target p95 ms |
|---|---:|---:|---:|
| services: full-text relevance | 6.4 | 7.3 | 250 |
| services: taxonomy + price, price_asc | 22.6 | 23.9 | 250 |
| services: available, availability sort | 37.4 | 41.6 | 300 |
| services: newest page 2 (cursor) | 0.9 | 1.1 | 250 |
| creators: reputation | 30.9 | 33.4 | 400 |
| auctions: ending soon 48h | 0.2 | 0.3 | 150 |
| trending-v1 | 11.8 | 13.3 | 400 |

Plan checks (all pass): selective full-text uses `service_versions_search_idx`; highest valid bid uses `bids_ranking_idx`; ending soon uses an auctions index; free bucket uses `capacity_buckets_free_idx`; recent views use `service_views_pkey`; control query is detected as a seq scan; single-auction bid count has no seq scan on bids (`bids_auction_sequence_key`).

These are **local-machine targets**, not a production SLO; no staging or production-scale claim.

- HTTP check against the running local Next dev server (127.0.0.1:3100): all four discovery endpoints 200, `limit=bad` 400 `INVALID_INPUT`; `robots.txt` = `Disallow: /`; sitemap served (empty of fixture records as designed); `X-Robots-Tag: noindex, nofollow` on `/orders`, `/dashboard/x`, `/admin`, `/api/discovery/trending`, absent on `/explore`.

## Not done / gaps

- No discovery UI: empty/error actions (DSC-02), cold-start label rendering (DSC-04) and stale CTA behaviour in the browser (DSC-05) are not browser-verified.
- No public cache layer exists (responses are `no-store`), so "cache revalidation" is satisfied by absence of caching, not by an invalidation mechanism.
- `service_views` has no retention job yet; views older than 7 days are simply unused.
- Benchmark is local only; no staging data volume or concurrent-load test.
- Canonical URLs depend on `APP_BASE_URL`; public page metadata (`<link rel=canonical>`) is for the UI to add.
