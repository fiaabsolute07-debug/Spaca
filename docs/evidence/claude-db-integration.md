# Evidence — PostgreSQL bring-up, DB integration tests, provider-backed funding

Date: 2026-09-13 · Author: Claude (desktop Code) · Environment: the user's normal macOS shell (arm64), outside the Codex managed runner.
No live payments, credentials, network providers, email or deployment were used. Everything ran against local PostgreSQL and the in-memory `MockPaymentProvider`.

## 1. PostgreSQL runtime

`PATH=/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH` (Node v24.19.0).

| Command | Result |
|---|---|
| `./node_modules/.bin/tsx scripts/postgres.ts start` (first run) | `initdb` **succeeded**: SysV `shmget` is not blocked here. Postmaster then failed with `Unix-domain socket path ".../.local/postgres/.s.PGSQL.55432" is too long (maximum 103 bytes)`. |
| One-line fix to `scripts/postgres.ts` (`unix_socket_directories=` so TCP only; the app uses `127.0.0.1:55432`), then start again | `PostgreSQL 18.4 … listening on IPv4 address "127.0.0.1", port 55432` · `Local PostgreSQL ready at 127.0.0.1:55432.` |
| `./node_modules/.bin/tsx scripts/migrate.ts` | `applied 0001_marketplace.sql`, exit 0 |
| `./node_modules/.bin/tsx scripts/seed.ts` | `seeded local creator-marketplace fixtures`, exit 0 |
| Re-run migrate, then seed | `skip 0001_marketplace.sql`, exit 0 · seed exit 0 (idempotent) |

## 2. Automated gates

| Command | Result |
|---|---|
| `./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false` | exit 0 |
| `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run` | `Test Files 4 passed (4)`, `Tests 68 passed (68)`. Two consecutive runs on the same database both pass, because fixtures are unique per run. |
| `./node_modules/.bin/vitest run` (no DB flag) | `2 passed, 2 skipped` files · `49 passed, 19 skipped` tests. DB suites are reported as skipped, not passed. |
| `DATABASE_URL=… NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=build-placeholder ./node_modules/.bin/next build --webpack` | `✓ Compiled successfully`. Routes: `/[[...path]]`, `/api/auth`, `/api/commands`, `/api/dev/mock-checkout`, `/api/webhooks/mock-payment`. |

Integration tests call the real route handlers (`POST` from `src/app/api/**/route.ts`) and read models against real PostgreSQL. Only `next/headers` cookies are substituted, to carry a real DB session token.

## 3. TEST_PLAN coverage (`tests/integration/commands.db.test.ts`, `tests/integration/payments.db.test.ts`)

| TEST_PLAN / master case | Test | Result |
|---|---|---|
| 1 Authorization / isolation | anonymous 401, cross-origin 403, foreign order/service/pool 403, `getOrderData` isolation, catalogue shows only PUBLISHED + PUBLIC/APPROVED | PASS |
| 2 Capacity race | 8 concurrent buyers, 1 unit → exactly 1 reservation, `reserved_units=1`; capacity cannot drop below held units | PASS |
| 3 Idempotency | same key+body replays identical result; different body → conflict; **6 concurrent same-key submits → 1 order, all 200 with the same id** | PASS (after fix B) |
| 4 Order lifecycle | skips rejected; pay → start → deliver → revision → deliver → second revision rejected → approve → review; exact event sequence; fee 0 | PASS |
| 5 Payment adapter | PAY-06, PAY-07 (20 deliveries incl. 10 concurrent → 1 ledger tx/event/outbox), PAY-08 (reverse order + stale failure, no regression), PAY-09 (tampered/forged/unsigned/other account rejected before inbox), PAY-10 (accept-then-timeout → UNKNOWN journal → same-op retry → one charge), amount mismatch case, capture-before-cancel, late funding case, provider-confirmed full refund applied once | PASS |
| 6 Requests | cap enforced, self-apply rejected, foreign select 403, foreign accept 403, unselected accept rejected, order from quote, other application stays SUBMITTED, anonymous request page readable | PASS (after fix D) |
| 7 Auctions | seller cannot bid, min increment, buy-now disabled after first bid, concurrent equal bids → 1 wins, early close rejected, no retract endpoint, bids after deadline rejected, close → winner order at 12000, second close rejected, anonymous auction page readable | PASS (after fixes C, D) |

Still NOT RUN: UI screenshots at 360/768/1440, browser click-through (it needs a signed-in session, which the agent does not enter), Supabase auth, Stripe sandbox. Notification dispatch and settlement release were added in phase 3 below.

## 4. Defects found and fixed

| ID | Defect (evidence) | Fix |
|---|---|---|
| A | `sandbox_pay` let the buyer set `FUNDED`/`SUCCEEDED` directly, with no provider fact. This violates master §8.3/§8.4, PAY-06 and the COLLABORATION contract ("no client markPaid"). | Command now returns 403. Funding goes through `src/modules/payments/funding.ts`: journaled intent → provider confirmation → signed webhook → inbox → locked transition + ledger + outbox. |
| B | Concurrent submits with one idempotency key: effect applied once, but the 5 duplicates got HTTP 400 because they raced the unique insert. | `pg_advisory_xact_lock(hashtextextended(actor:command:key))` at the start of the command transaction. |
| C | `close_auction` always failed: `0A000 FOR UPDATE cannot be applied to the nullable side of an outer join`. No auction could ever close. | `for update of a`. |
| D | Anonymous `/requests/[id]` and `/auctions/[id]` threw `invalid input syntax for type uuid: ""`, from `actor?.id ?? ''`. | `?? null`. |
| E | `refund` command marked `REFUNDED` without any provider refund. | Command requests a provider refund (journal `refund:<order>:full`); `REFUNDED` only after a verified `refund.succeeded` webhook. |
| F | Mock provider event ids were deterministic per account + sequence. A new provider instance or a server restart reused ids, and inbox dedupe silently dropped real new payments (found by these tests). | Per-instance random nonce in event ids, plus a unit test. |
| G | `scripts/postgres.ts` could not start in deep checkout paths (Unix socket > 103 bytes). | TCP-only postmaster flag. |

---

# Phase 3 — durable jobs, settlement release, notifications timeline (2026-09-13, user-approved)

## Commands and results

| Command | Result |
|---|---|
| `./node_modules/.bin/tsx scripts/migrate.ts` | `skip 0001_marketplace.sql` · `applied 0002_notifications.sql`; rerun → both `skip` |
| `./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false` | exit 0 |
| `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run` (twice, same DB) | `Test Files 5 passed (5)` · `Tests 83 passed (83)`, both runs |
| `./node_modules/.bin/vitest run` (no DB flag) | `2 passed, 3 skipped` files · `49 passed, 34 skipped` tests |
| `next build --webpack` (same placeholder env as above) | `✓ Compiled successfully`; routes add `/api/dev/jobs` |
| Mutation check. Each mutant was applied to `src/modules/payments/funding.ts` from a scratchpad backup, run against `jobs.db` + `payments.db` suites, then restored (`shasum -c` OK). | Killed, each with 1 failing test: no operation-id fallback when matching webhooks; RECONCILING hold not accepted by funding; CREATOR_AT_COST release drops the fee entry (unbalanced); reconciliation case dedupe removed; no-regression guard removed |

## New coverage (`tests/integration/jobs.db.test.ts`, 15 tests, all PASS)

| Area | Behaviour proven against PostgreSQL |
|---|---|
| Hold expiry (§6.3) | expired unpaid hold released exactly once; unexpired hold untouched; open provider intent cancelled before release, and checkout refused afterwards; provider already captured → reservation `RECONCILING` + one open case, then the late webhook funds the order with correct pool counters; expired Buy Now order → auction `EXPIRED` |
| Settlement release (PAY-02/03/12) | CREATOR_AT_COST: transfer 63050 of 65000 (3% fixture cost), zero platform fee, principal/clearing/fee-expense all net to 0, `SETTLEMENT_RELEASED` payload, payout notification queued, second run no-op. PLATFORM_SUBSIDIZED: transfer 65000, platform expense 1950. Missing payout capability: stays READY, one case, one journal row, no payout notification. Open dispute freezes release. |
| Reconciliation (PAY-10/11/20) | lost webhook → provider API fetch funds the order, and the late webhook is `DUPLICATE_FACT` (one ledger tx); UNKNOWN resolved by lookup (applied → SUCCEEDED with reference); not applied → FAILED, and the next checkout uses attempt `:2` and funds once; refund accepted-then-timed-out is matched by the signed event's operation id → REFUNDED once, no unmatched case, journal resolved later |
| Inbox reprocess | verified event persisted but never processed (simulated crash) is applied by the job once; the original redelivery is a duplicate |
| Notifications | two concurrent dispatch workers + forced re-dispatch → exactly 4 rows (buyer/creator × in_app/email), email rows `EMAIL_SINK` (never sent), timeline shows "Payment confirmed" with `650.00 USD`; poison payload parked |
| Jobs route | runs the five jobs in order; cross-origin POST 403 |
