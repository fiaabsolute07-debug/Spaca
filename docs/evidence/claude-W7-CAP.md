# W7-CAP evidence: capacity becomes a per-creator active-order limit (Claude, 2026-09-15)

Scope: master §5.2, §6.1–6.4 and §18.2 CAP-01..12 after the 2026-09-14 decision (plan B): a creator declares **how many orders they work on at once**, not weekly slots. Backend, data migration, the creator/buyer UI touched by the change, tests and docs. Not committed at the time of writing; baseline `9c5b157` plus the uncommitted UI/landing/waitlist work already in the tree.

Environment: **local only**.
- Embedded PostgreSQL 18 (127.0.0.1:55432): `creator_marketplace_test` for Vitest and the benchmark, `creator_marketplace` for the Next dev server and Playwright.
- Mock payment provider and simulated devnet in the Next process. No network, no real money, no email.
- Before migrating, both databases were copied with `CREATE DATABASE … TEMPLATE …` to `creator_marketplace_bak_0011` and `creator_marketplace_test_bak_0011` (local rollback point; drop them once this change is committed and accepted).

## What changed

- **Migration `drizzle/0012_active_order_limit.sql`**
  - `app.creator_workloads` (one row per creator): `max_active_units` 1–100 (default 3), `accepting_orders`, `held_units`, `active_units`, `version`. Counters are CHECK ≥ 0; there is deliberately no table CHECK on the total, because lowering the limit or a revision may leave accepted work above it (§6.1 rules 6, 9).
  - `app.reservations` is renamed to `app.workload_claims`, with `creator_id`, `origin` BOOK/OFFER/AUCTION, `units` 1–10 and states HELD / EXPIRY_RECONCILING / ACTIVE / DONE / RELEASED.
  - Backfill:
    - `max_active_units` comes from the creator's largest old `weekly_units`, clamped to 1–100.
    - RECONCILING becomes EXPIRY_RECONCILING.
    - COMMITTED/CONSUMED map by order status: APPROVED/COMPLETED → DONE, CANCELLED/REFUNDED → RELEASED, otherwise ACTIVE.
    - Counters are recomputed from the claims.
  - `workload_claim_guard`: new claims must start HELD. DONE/RELEASED are terminal. Creator, units and origin are immutable, and claims that are not finished cannot be deleted.
  - `workload_claim_counters`: counters follow claim state in the same transaction. On INSERT the UPDATE takes the workload row lock and refuses the claim when the creator is paused (`HINT NOT_ACCEPTING_ORDERS`) or the total would exceed the limit (`HINT CAPACITY_UNAVAILABLE`). This is the database backstop if application locking were wrong.
  - `orders_workload_release` (AFTER UPDATE OF status): APPROVED/COMPLETED turns an ACTIVE claim into DONE; CANCELLED/REFUNDED releases HELD, EXPIRY_RECONCILING or ACTIVE claims. Units are therefore freed exactly once on every path (buyer approval, auto-accept, admin resolution, mutual cancellation, hold expiry), without each caller remembering to do it.
  - `services.units_per_order` and `service_versions.units_per_order` (1–10, default 1). The pool columns on services, versions and orders are dropped, and `capacity_buckets` / `capacity_pools` are dropped.
  - View `app.workload_counter_drift`: creators whose counters differ from the sum of their claims.
- **`src/modules/capacity/index.ts`**: `claimWorkload` (lock workload → status check → insert HELD claim), `activateOrderClaim`, `releaseAuctionClaim`, `setMaxActiveUnits`, `setAcceptingOrders`, `workloadsFor`, `availabilityOf`. Weekly bucket code is removed. `weeks.ts` stays only for timezone validation and future ACCESS scheduling (§6.5).
- **Commands**
  - `book`, `accept_offer` and `create_auction` claim through `claimWorkload`. Their order and auction terms record `capacity: { model: 'ACTIVE_ORDER_LIMIT', units }`.
  - `accept_offer` no longer takes `pool_id`/`bucket_id`.
  - New `set_workload_limit` (`max_active_units`) and `set_accepting_orders` (`accepting` true/false) replace `set_capacity` and `set_pool_timezone`.
  - `create_service`/`update_service` accept optional `units_per_order`.
  - `CAPACITY_REDUCTION_CONFLICT` is gone; `NOT_ACCEPTING_ORDERS` is 409. The command envelope maps the trigger hints to 409.
- **Funding, expiry, auctions**
  - Card, crypto and pool funding activate the claim.
  - The expiry job sets EXPIRY_RECONCILING when payment is unresolved, otherwise cancels the order and lets the trigger release.
  - Buy Now and auction close move the same claim to the order (CAP-09).
  - Auctions ending with no bids, or cancelled, release their claim.
- **Behaviour change (§6.1 rule 8):** mutual cancellation and admin refund of started work now **free** the creator's place. The weekly model kept it consumed.
- **Jobs**: `extend_capacity_horizon` is removed. `check_workload_counters` opens one HIGH `WORKLOAD_COUNTER_DRIFT` case listing affected creators; it never repairs counters.
- **Read side**
  - Public service rows, discovery results and creator results expose `availability_status` ACCEPTING / AT_CAPACITY / PAUSED and no counts (§6.1 rule 10).
  - `getDashboardData().workload` gives the creator their own numbers.
  - Discovery: `available=true` means ACCEPTING. `available_before` and `sort=availability` now return 400, because there is no reopening date to filter or sort by.
  - Admin operations shows EXPIRY_RECONCILING claims (creator, units) and a "Workload counter drift" table.
- **UI**
  - `/creator/services` has an "Order limit" panel: status, "N of M in use", an "Orders at a time" field with Save, and "Pause new orders" / "Resume new orders".
  - The new-service form drops "Available slots".
  - Service cards and the service page show Accepting orders / Currently at capacity / Paused. When not accepting, the page shows "Post a request ›" to `/buyer/requests/new` instead of the booking form.
  - The dashboard stat reads "Order limit in use". The request page accept form no longer asks for a pool.

Deviation from §5.2, recorded here: `ServiceWorkloadRule` is not a separate table. `units_per_order` lives on `services` and is snapshotted on immutable `service_versions`, so each sold version keeps the weight it was sold with.

## Lock order

Aggregate (request/auction row) → creator workload row → order.

- `claimWorkload` locks the workload before the claim insert. New order rows inserted earlier in the same transaction are not contended.
- Order-first paths (funding, expiry, approval, refund) lock an existing order and only then update its claim, whose trigger updates the workload row.
- No caller holds a workload lock while waiting for an existing order, so the two directions cannot form a cycle. Same reasoning as the C3 review of the old pool → bucket → order contract.
- Dedicated simultaneous funding-vs-expiry races remain a follow-up (CAP-10).

## Verification

| Check | Result |
|---|---|
| `tsc --noEmit -p tsconfig.json --incremental false` | exit 0 (app, scripts, tests) |
| `RUN_DB_INTEGRATION=1 vitest run` | **229/229 passed, 24 files**, DB suites enabled. The first run had 1 failure in a new test (a direct `UPDATE orders` without `version=version+1`, correctly refused by the order guard); fixed in the test, then 229/229. |
| Upgrade migration, test DB (populated from earlier runs) | 2,423 claims mapped: ACTIVE 913 (DELIVERED 270, DISPUTED 68, FUNDED 467, IN_PROGRESS 108), DONE 281, EXPIRY_RECONCILING 32, HELD 300, RELEASED 897 (CANCELLED 693, REFUNDED 109, auction-only 95); `workload_counter_drift` 0 rows; 5 creators above their new limit (allowed, no claim was changed). |
| Upgrade migration, dev DB | 46 claims mapped the same way; drift 0 rows; `creator_c` above the backfilled limit until E2E raises it. |
| Blank DB migration 0001–0012 | applied cleanly (temporary `cm_blank_check`, dropped afterwards). |
| Playwright E2E (`TZ=UTC`, dev server 3100, system Chrome) | Run 1: 12/14 (the known timing-sensitive auction outbid test, and request-hire when the first `create_request` navigation did not land on the request page). Runs 2 and 3: **14/14**. The two specs also passed alone. |
| `scripts/discovery-benchmark.ts` (rolled back) | All latency targets pass (p95: available+newest 15.3 ms, creators reputation 19.8 ms, trending 16.3 ms). Plan checks pass, including `creator_workloads_pkey` for workload lookup and `workload_claims_creator_state_idx` (index-only, no seq scan) for open claims per creator. |
| `scripts/release-check.ts` | all static checks PASS |
| Browser check (in-app pane, ~800px) | As `creator_c`, "Pause new orders" shows the success notice and Paused status. The buyer service page shows Status Paused, "This creator paused new orders. Post a request ›" and no booking form. Resumed afterwards. |

New or rewritten DB tests (`tests/integration/supply.db.test.ts` "CAP — active order limit" unless noted):

- **CAP-01**: one free place out of two, 20 concurrent bookings on real connections. Exactly one more claim, 19 × 409 "at capacity", counters held 2, drift 0. The same shape with limit 1 is in `commands.db.test.ts` TEST_PLAN 2.
- **CAP-02**: a creator with a 1-unit and a 2-unit service at limit 3, 10 concurrent mixed bookings. Held units ≤ 3 and equal to the counter. Each service's status reflects its own units; public rows carry no counts; drift 0.
- **CAP-06**: funding makes the claim ACTIVE and blocks a second booking. Approval makes it DONE and frees the unit. DONE → ACTIVE is refused; a later COMPLETED does not change counters; a new booking succeeds.
- **CAP-07**:
  - A limit of 0 is refused (400).
  - Lowering to 1 with 2 funded orders keeps both ACTIVE, and the message says new orders reopen when one finishes.
  - A new booking gets 409 until both orders are cancelled.
- **CAP-08**: pause gives 409 "paused new orders" for booking and `create_auction` and status PAUSED; start and deliver on the funded order still work; resume allows booking. REQ-06 in `requests.db.test.ts` also checks that `accept_offer` is 409 while paused.
- **CAP-09**: auction scheduling holds one AUCTION claim. Buy Now moves the same claim id to the order (auction_id null, HELD) and held stays 1.
- **CAP-12**: cancelling funded work releases once; a later REFUNDED status does not release again; drift 0. ORD-15 (`orders.db.test.ts`) and admin partial refund (`admin.db.test.ts`) now expect RELEASED.
- **DB guard**: a direct over-limit claim insert, a claim inserted ACTIVE, an insert while paused, deletes, creator/units changes and negative counters are all refused.
- Existing CAP-03/04/05 job and payment tests pass on the new tables (RELEASED once; EXPIRY_RECONCILING kept while the provider already captured; late funding opens a case).

## Known gaps and follow-ups

- **CAP-04/05/10**: status unchanged (PARTIAL). No explicit provider-UNKNOWN + competing checkout race, no resold-place refund/rebook consent flow, no simultaneous hire funding vs expiry race.
- **CAP-11**: ACCESS appointment intervals are still NOT_RUN (P6).
- **E2E persona**: `creator_c` in the dev DB accumulates orders left in progress by earlier runs. The E2E helper raises its limit to 100 through the UI before each journey (44 of 100 in use after these runs). A dev DB reseed or a job that finishes old E2E orders will be needed eventually.
- **Old weekly semantics**: evidence for the old model (W1-A CAP-06/07/08, W1-B CAP-12) describes behaviour that no longer exists; the acceptance ledger now points to this file.
- **Open product questions**:
  - Whether an auction should hold a place from scheduling (current) or only from sale.
  - Whether a request should show creators' status.
  - Publish sample count (3 vs 1).
