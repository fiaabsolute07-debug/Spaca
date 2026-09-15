# Remaining local gaps: late funds, availability, clocks, precision, script guards (Claude, 2026-09-15)

Scope: PARTIAL rows REQ-04, ORD-03, CAP-05, PAY-08, PAY-17 and FND-07. Local only (embedded PostgreSQL 18, mock provider).

## Fixes

- **Late captured funds were neither booked nor refundable** (CAP-05). A capture arriving after the order was cancelled opened a LATE_FUNDING case, but the money was not in the ledger, and no command could refund it, because `admin_refund_order` needs payment SUCCEEDED.
  - The capture is now booked as `LATE_FUNDING_CAPTURED` (or `DUPLICATE_FUNDING_CAPTURED`): provider clearing and fee expense debited, `order_principal` credited, so the money is shown as owed back to the buyer. It still never funds the order. The idempotency key is the funding reference, so a replayed webhook stays a duplicate.
  - New finance/admin command `admin_refund_late_funding {order_id, reason}`: only for a CANCELLED order with an open LATE_FUNDING case. It refunds the full amount through the provider (order ends REFUNDED, principal back to 0) and writes an audit entry. It appears on `/admin/orders/[orderId]` as "Refund late funds".
  - Mock harness `simulateLateCapture(reference)` models a capture that completes after the platform cancelled the attempt.
- **Offers to unavailable creators** (REQ-04): `select_application` now refuses a creator who paused new orders after applying (409 `NOT_ACCEPTING_ORDERS`) or was suspended (403). No offer or budget reservation is created, and selection works again once the creator resumes.
- **Restore rehearsal guard** (FND-07): `scripts/restore-rehearsal.ts` now calls `assertLocalDatabaseTarget` before touching any database, like seed, test-db and the benchmark.

## Tests run

| Row | Test | Result |
|---|---|---|
| CAP-05 | `races.db`: exclusive DIGITAL license; buyer A's hold expires (attempt cancelled, order CANCELLED); buyer B buys and gets the license; A's capture then completes at the provider | LATE_FUNDING case, A's order stays CANCELLED, ledger principal −4000 (owed), A's entitlement not active, B's ACTIVE, one live entitlement. Buyer calling the refund 403; finance refund 200 → REFUNDED, principal 0, ledger 0, provider refunded 4000, one buyer notification; second refund 409; B keeps the license. PASS |
| CAP-05 (existing) | `payments.db` late funds after cancel | now also asserts the `LATE_FUNDING_CAPTURED` ledger transaction balancing to 0. PASS |
| REQ-04 | `requests.db`: creator pauses new orders after applying, then is suspended | select 409 ("paused new orders"), then 403; no offers, reserved 0; after resuming, select 200. PASS |
| ORD-03 | `orders.db`: booked CREATE order with its brief 6 h before payment | before funding no clock; after funding `work_start_at` equals `funded_at` and the due date is exactly `turnaround_hours` later, in the future. PASS |
| PAY-08 | Existing no-regression test, plus the independent card payment dispute lifecycle from [ORD-14](claude-ORD-14.md) | PASS |
| PAY-17 | `money-precision.db`: USD input matrix (7 accepted, 15 refused including `1.001`, `1e3`, `1,000`, `0x10`, `NaN`, out of range); cents ↔ 6/18-decimal token units with no rounding (inexact → null); display exact up to 999,999,999.99; DB round trip of max bigint and 2^256−1 in numeric(78,0) with overflow refused; a 650.99 order stays 65099 through order, provider funding, ledger and receipt | 4/4 PASS |
| FND-07 | `unit/script-guards`: spawns the real scripts | seed refuses APP_ENV/NODE_ENV production, staging and remote URLs without seeding; test-db reset refuses a remote admin URL, a non-`_test` name and production; restore rehearsal refuses production environments without starting; the benchmark refuses a remote target; the job loop refuses a non-loopback URL. 4/4 PASS |

Full `RUN_DB_INTEGRATION=1 vitest run`: 306 passed, 3 skipped (anvil opt-in). `tsc` clean.
