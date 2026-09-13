# Evidence — W1-A supply engine v2 (P1A)

Date: 2026-09-13 · Owner: Claude · Environment: user's macOS shell, local PostgreSQL 18.4 (127.0.0.1:55432), mock payment provider. Local only; no sandbox/live claim.

## What changed

| Area | Change |
|---|---|
| Migration `drizzle/0003_supply_capacity.sql` | See the four schema rows below. |
| ↳ Capacity buckets | `app.capacity_buckets`: weekly buckets per pool with timezone and `local_week_start`. `CHECK reserved+committed <= total`; `EXCLUDE USING gist` to prevent overlapping intervals per pool; `UNIQUE(pool_id, starts_at)`. |
| ↳ Pools | Weekly units, timezone, name and version. Pool-level counters dropped after backfilling existing reservations into a bucket. |
| ↳ Reservation triggers | `reservations_counters` derives bucket counters from reservation state (reserved = HELD+RECONCILING, committed = COMMITTED+CONSUMED). `reservations_guard` enforces the state machine (CONSUMED and RELEASED are terminal), keeps bucket/pool/units immutable, and refuses deleting active or consumed claims. |
| ↳ Versions and snapshots | `app.service_versions` is immutable (trigger), `platform_fee_bps = 0` CHECK. `services.published_version_id` (FK and a CHECK that listed services have one). `app.service_samples` enforces owner consistency. `orders.service_version_id`, `auctions.service_version_id`. `orders_snapshot_guard` makes sold terms immutable (amount, currency, fee, version, terms, parties). |
| `src/modules/capacity` | `weeks.ts` computes Monday-00:00-local weeks in UTC, handling DST 167h/169h, gaps and repeated midnights. `index.ts` covers bucket materialization, locking pool → bucket in start order, insert/commit/release/consume, `setWeeklyUnits` (all-or-nothing, CAP-07), `setPoolTimezone` (rebuilds only empty future weeks, CAP-08), and read-only `poolAvailability`. |
| `src/modules/catalog/commands.ts` | `create_service` (optional shared `pool_id`), new `update_service` (requires `expected_version`; a live edit creates a new version), `publish_service` (SUP-01 checks, creates a version, materializes buckets), `pause_service`, new `archive_service`, `set_capacity` (weekly units), new `set_pool_timezone`, `update_profile` (timezone, unique handle, validated URL), `add_sample` (PENDING, optional service link). `book` requires a PUBLISHED listing with an ACTIVE creator and uses the published version. An optional `service_version_id` that no longer matches returns 409 QUOTE_CHANGED; an optional `bucket_id` picks the week. It writes the terms snapshot (schema v1), leaves `delivery_due_at` NULL, and holds for 15 minutes (`CHECKOUT_HOLD_MINUTES`). |
| Requests / auctions | `accept_offer` and `create_auction` reserve through buckets and write terms snapshots. Buy Now/close carry the auction's version and the same claim (CAP-09). A no-bid close releases via state. |
| Funding / jobs | Funding commits the reservation by state; `delivery_due_at` is set at verified funding from the turnaround snapshot. Hold expiry releases by state only. |
| Auth + envelope | SUSPENDED sessions stay valid; the command envelope allows only existing-obligation commands (SEC-10). `Actor` gains `status`, `timezone`. |
| Read models | Public views show the **published version's** terms plus real availability (`available_units`, `next_available_starts_at`, `weekly_units`) and hide suspended creators. **Fixed:** public creator pages previously listed the creator's DRAFT/PAUSED services. |
| Errors | `DOMAIN_RULE` (422) added; capacity conflicts return 409. |

## Commands and results

| Command | Result |
|---|---|
| `tsx scripts/migrate.ts` against a fresh `creator_marketplace_blank_test` | `applied 0001`, `applied 0002`, `applied 0003`, exit 0 (blank DB) |
| `tsx scripts/migrate.ts` against `creator_marketplace` (existing data from earlier runs) | `skip 0001`, `skip 0002`, `applied 0003` (upgrade with live reservations backfilled) |
| `tsx scripts/seed.ts` (twice) | exit 0 both times; creator pool in `Asia/Ho_Chi_Minh`, service version 1 published |
| `vitest run tests/unit/weeks.test.ts` | 7/7 (UTC, Berlin 167h/169h, 60 contiguous weeks × 6 zones incl. Lord Howe 30-min DST, Havana midnight gap and repeat) |
| `RUN_DB_INTEGRATION=1 vitest run tests/integration/supply.db.test.ts` | 13/13 |
| `tsc --noEmit -p tsconfig.json --incremental false` | exit 0 |
| `RUN_DB_INTEGRATION=1 vitest run` (all suites) | `Test Files 9 passed (9)` · `Tests 112 passed (112)` |

## Acceptance (local PostgreSQL + mock provider)

| ID | Test | Status |
|---|---|---|
| SUP-01 | publish refused without 3 approved public samples + 1 linked; draft kept; PENDING samples don't count | PASS (local) |
| SUP-02 | new creator: `completed_jobs 0`, `rating null` (UI must render "New creator"/"—") | PASS (read model) |
| SUP-03 | V1 order unchanged after V2 edit; stale `service_version_id` → 409; V2 checkout uses new price/turnaround; DB refuses editing sold terms or versions | PASS (local) |
| SUP-04 | pause/archive stop sales (404) while the funded order starts and delivers; archived cannot republish (422) | PASS (local) |
| CAP-01 | 20 concurrent buyers, same week, 1 unit → 1 claim, 19×409 | PASS (local) |
| CAP-02 | two services on one shared 1-unit pool, 10 concurrent → 1 claim | PASS (local) |
| CAP-06 / CAP-12 | consumed unit stays committed; DB refuses CONSUMED→RELEASED | PASS (local) |
| CAP-07 | reduce below 2 committed → 409, nothing changed; DB CHECK also refuses | PASS (local) |
| CAP-08 | timezone change keeps booked week, rebuilds empty future weeks in new zone, no overlap (exclusion constraint verified); DST unit tests | PASS (local) |
| CAP-09 | Buy Now keeps the same reservation id/bucket, no extra unit | PASS (local) |
| SEC-09 | dual-role self-booking rejected | PASS (local) |
| SEC-10 | suspended creator: no new sales, hidden from catalogue, cannot publish or post requests; can start/message/deliver funded order | PASS (local) |
| FND-02 (migration part) | blank DB + upgrade of populated DB | PASS (local); CI frozen-lock run is C4 |
| FND-07 | seed guard unit tests (W1-S) | PASS (unit) |

Not covered or not claimed:
- **CAP-03/04/05/10** depend on hold-expiry/late-payment flows. They are covered by the jobs suite (RELEASED once, RECONCILING on captured payment, LATE_FUNDING case) but are not yet mapped as separate IDs (C3).
- **CAP-11** (ACCESS appointment overlap) is P6.
- **No per-slot `ServiceSlot` model yet.** Capacity granularity is the weekly bucket, and the latest checkout is `bucket.ends_at − turnaround`.
- **Timezone change can leave a partial week without capacity** between the last booked old-zone week and the next new-zone Monday. This is documented behaviour, not a bridge bucket.

## Requests to Codex (UI, contract updated in `docs/UI_CONTRACT.md`)

1. Book form: add hidden `service_version_id` (from `getServiceData().service.service_version_id`), an `accept_terms` checkbox with review-window/auto-accept copy, and optional week choice (`bucket_id`). Show `next_available_starts_at` in the creator's timezone.
2. Creator services:
   - edit form → `update_service` with `expected_version`
   - `archive_service` action
   - `set_capacity` with `weekly_units`
   - `set_pool_timezone`
   - pool selector (`pool_id`) when creating a second service
   - a "pending moderation" label for samples
3. Profile form: `timezone` field.
4. Render SUP-02 as "New creator" / "—" when `completed_jobs = 0` or `rating = null`.
