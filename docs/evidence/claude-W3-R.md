# W3-R evidence: P2 requests, quotes, multi-hire (Claude, 2026-09-14)

**Scope:** master §5.3, §9 and §16.5 (P2-01..08), and REQ-01..11 in §18.5.
**Environment:** local only. Embedded PostgreSQL 18.4 (`creator_marketplace_test`) as `app_server`, with MockPaymentProvider as the local test provider. No sandbox and no live.

## What changed

| Area | Change |
|---|---|
| Migration `drizzle/0007_requests_v2.sql` | **Requests.** Statuses are now OPEN/FILLED/CLOSED/CANCELLED. The per-creator cap is optional; the total budget is materialized as cap × hires when only a cap is given. Added `application_deadline ≤ deadline`, `version`, and trigger-derived `reserved/committed` minor-unit and hire counters. CHECKs make `reserved + committed ≤ budget` and `≤ target_hires` hold in the database. |
| | **Applications.** Added `version`, `valid_until` and `samples_snapshot`, plus an append-only `application_versions` history. |
| | **`hire_offers`.** Terms are immutable. There is at most one active offer per application, and an order can belong to only one offer. A capacity plan is required once accepted. Status is one of OFFERED/ACCEPTED/DECLINED/EXPIRED/WITHDRAWN/LAPSED. |
| | **`request_budget_reservations`.** States are HELD/COMMITTED/RELEASED and can only move forward. Deletes are refused. |
| | **Trigger on `orders` (`source = REQUEST`).** FUNDED commits the reservation. CANCELLED while still AWAITING_PAYMENT releases it, sets the offer to LAPSED and reopens the application. REFUNDED releases it. The request toggles FILLED ⇄ OPEN from the counters. |
| `src/modules/requests/commands.ts` | Commands: `create_request`, `update_request` (expected_version; never below held + committed), `close_request` and `cancel_request` (cancel is refused once hires were accepted; closing withdraws pending offers but orders continue), `apply` (one versioned application; cap, deadline and turnaround checks; samples snapshot), `withdraw_application`, `select_application` (needs `application_version`; returns QUOTE_CHANGED or QUOTE_EXPIRED; holds budget and one hire for up to 24 h), `accept_offer` (explicit own `pool_id`, optional `bucket_id`; creates an AWAITING_PAYMENT order with no service and a capacity HELD for the checkout TTL), `decline_offer` and `withdraw_offer`. Lock order is request → offer → application → pool/bucket. |
| Jobs | `expireHireOffers`: OFFERED past expiry becomes EXPIRED and its budget is released; OPEN requests past their deadline close. Added to `runJobsOnce`. |
| Read models | `getRequestData`: a creator sees only their own application and offer; the buyer sees all, plus a campaign aggregate (offered / awaiting payment / funded / completed / refunded, and a per-hire order table); anonymous users see no applications. Also added `getCreatorPools`, and the dashboard applications now include the latest offer. |
| UI | Request page: compare cards (quote version, validity, samples, offer state), offer and withdraw, creator accept with a pool selector or decline, application update and withdraw, campaign panel, close/cancel. The new-request form gains an optional cap, optional total and an application deadline. |
| Notifications | Links for `request.application_received` and `request.hire_offer` now point to `/requests/{id}` (the previous paths did not exist). |

## Test evidence

- `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run`: **17 files, 182/182 passed**. This includes the new `tests/integration/requests.db.test.ts` (8 tests) and the rewritten TEST_PLAN 6 in `commands.db.test.ts`.
- After the notification link change, `tests/providers.test.ts` passed 44/44.
- `tsc --noEmit` exit 0.

| ID | Test | Result |
|---|---|---|
| REQ-01 | A cap of $100 × 3 hires materializes a $300 budget. An application deadline after the delivery deadline returns 400. A quote over the cap returns 422. A buyer applying to their own request gets 403. A turnaround past the deadline returns 422. Applying after the application deadline returns 422. | PASS (local-mock) |
| REQ-02 | Applying twice leaves one application at version 2. The history table holds v1 $250 and v2 $240, and history rows cannot be updated. | PASS (local-mock) |
| REQ-03 | Creator B's read model contains only B's application and no campaign. Anonymous users see none. The buyer sees both. | PASS (local-mock) |
| REQ-04 | Selecting with version 1 after the creator changed the quote returns 409 naming version 2. An expired quote returns 422. No offer is created in either case. | PASS (local-mock) |
| REQ-05 | Budget $150 with three concurrent $70 selections gives [200, 200, 422]. Target 2 with three concurrent selections gives [200, 200, 422]. Counters match the HELD rows. | PASS (local-mock) |
| REQ-06 | Another creator gets 404. No `pool_id` returns 400. Another creator's pool returns 403. With its own pool, the order has no service, the pool set, a terms capacity plan with units 1, capacity HELD, and the budget reservation linked to the order. | PASS (local-mock) |
| REQ-07 | After acceptance the offer timer passes; the expiry job changes nothing and the budget stays HELD. The buyer pays, so the offer stays ACCEPTED, the budget becomes COMMITTED and the request is FILLED at 1/1. | PASS (local-mock) |
| REQ-08 | Three hires. Hire 1 is funded. Hire 2 is funded, then cancelled and fully refunded, so REFUNDED releases its budget. Hire 3 is never paid; its hold expires, so the offer is LAPSED and the application reopens. Hire 1 stays FUNDED and COMMITTED, and the campaign shows funded $100 and refunded $120. Cancel is refused (409) once hires were accepted. Closing withdraws a pending offer and keeps the funded order, and applying afterwards returns 422. | PASS (local-mock) |
| REQ-09 | Two concurrent selections of the same quote give [200, 409]. Two concurrent accepts give [200, 409]. The result is one order and one budget reservation. | PASS (local-mock) |
| REQ-10 | A stale expected_version returns 409. Lowering the budget below held returns 422, and a direct SQL write is refused by `requests_budget_not_oversold`. Raising the budget and lowering hires to the committed count works, and the version increments. | PASS (local-mock) |
| REQ-11 | Applications never create offers by themselves (0 offers until the buyer selects). The UI says the lowest quote does not win automatically. | PARTIAL: no sort/filter controls on the compare view yet |
| Offers | Decline, buyer withdraw (a creator trying to withdraw gets 404), and expiry via the job each release the budget. Accepting an expired offer returns 422. Offer terms cannot be updated. | PASS (local-mock) |

**Browser check** (Next dev on 127.0.0.1:3100 against the dev DB, with dev personas):
1. buyer_a published a cap-only request with 2 hires, so the budget showed as $600.
2. creator_c applied. buyer_a clicked "Offer $250.00", and the campaign showed "Offers waiting for creators $250.00".
3. creator_c saw only their own application and no campaign, chose a pool, and clicked "Accept and schedule". The REQUEST order was created with AWAITING_PAYMENT and a $0.00 platform fee.
4. buyer_a paid through the local test provider. The campaign then showed "Funded $250.00", "Hires funded / needed 1 / 2", and the request stayed OPEN.

## Not done / limits

- **Compare view.** No sort/filter controls (P2-03); the order is by application time.
- **Missing features.** No CSV export (§9.4), no hires-vs-applications analytics (P2-07), and no E2E for multi-hire (P2-08 → C5).
- **Legacy data.** Requests created before migration 0007 have no offer/reservation rows. Their counters start at 0, so old FILLED requests stay FILLED but are not budget-accounted.
- **Partial refunds.** A partially refunded hire keeps its budget COMMITTED; only a full refund releases it.
- **Legacy form fallback.** `accept_offer` still accepts `application_id` in place of `offer_id` (it uses the latest offer) for older forms.
