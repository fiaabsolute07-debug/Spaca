# Evidence — W1-B order lifecycle engine (P1B)

Date: 2026-09-13 · Owner: Claude · Environment: user's macOS shell, local PostgreSQL 18.4, `creator_marketplace_test` for suites, dev server on 127.0.0.1:3100, mock payment provider. Local only; no sandbox or live claim.

UI changes for this task were done by Claude because Codex was at its usage limit.

## What changed

| Area | Change |
|---|---|
| Migration `drizzle/0004_order_lifecycle.sql` | See the rows below. |
| ↳ Order columns | Work clock (`funded_at`, `brief_ready_at`, `work_start_at`), `revision_due_at`, `approved_at`/`completed_at`/`cancelled_at`, `status_before_dispute`, `cancellation_refund_minor` (≤ amount). Payment status adds `PARTIALLY_REFUNDED`. |
| ↳ Deliveries | Append-only (content trigger, no delete), `validation_status`, `buyer_viewed_at`. |
| ↳ New tables and indexes | `review_holds` with one active hold per order. `cancellation_requests` with one active request per order and immutable consented terms. Partial unique index for one active dispute. Reviews unique per (order, reviewer). |
| ↳ Transition trigger | `orders_transition_guard` enforces the §7.2 matrix and requires a version bump on every status change. |
| `src/modules/orders/lifecycle.ts` | `recomputeWorkClock` (due = max(funded, brief_ready) + turnaround, fixed once set), `assertCurrentDelivery` (ORD-08), review-hold resolve, pending-cancellation expiry, `recordBuyerView` (clears the evidence hold and restarts the full review window), `creatorReputation` (REV-03: completed only, N reported, fixtures excluded unless `REPUTATION_INCLUDE_TEST_DATA=true`). |
| `src/modules/orders/commands.ts` | Commands: `submit_brief`, `start` (FUNDED + brief ready), `deliver` (IN_PROGRESS/REVISION_REQUESTED only; link or ≥20 chars), `revision` (`delivery_version`, within review window, limit from snapshot, 48h revision due), `approve` (`delivery_version` → APPROVED + settlement READY + consume capacity), `dispute` (stores prior status, freezes release), `cancel` (before work only), `request_cancellation` / `respond_cancellation` (accept / reject / withdraw; consent bound to order version; lock order before request), `refund` retry, `review` (COMPLETED only; idempotent), `message`, `mark_delivery_viewed`. Outbox notifications for each lifecycle event. |
| Funding | Sets `funded_at` and recomputes the clock. Refunds use the agreed amount (`refund:<order>:agreed`) or the full amount. A partial `refund.succeeded` → `PARTIALLY_REFUNDED` (the order stays CANCELLED). The release plan carries the gross amount. `release.succeeded` moves APPROVED → **COMPLETED**. A cancelled order releases the unrefunded remainder (`release:<order>:remainder`). |
| Jobs | `auto_accept_deliveries`: only after the review window; requires consent, a VALID current delivery, no dispute or pending cancellation, and buyer view evidence. Otherwise it creates one ReviewHold plus a case. `order_reminders`: review reminder 24h before auto-accept, due-soon, overdue. Release condition: APPROVED, or CANCELLED with a remainder. |
| Read model and UI | `getOrderData` returns clocks, versions, view evidence, active cancellation request and active hold. The order page records buyer view evidence on open. The Next-step panel offers only currently valid actions (approve/revision carry `delivery_version`; brief form; cancellation request/respond/withdraw; review after COMPLETED). The brief panel shows clocks, revisions used/limit and auto-accept consent. The book form sends `service_version_id` plus an `accept_terms` consent checkbox. |
| Notifications | New templates: `order.review_reminder`, `order.overdue`, `order.completed`, `order.cancellation_requested`, `order.cancellation_resolved`. |

## Commands and results

| Command | Result |
|---|---|
| `tsx scripts/migrate.ts` (dev DB) and `tsx scripts/test-db.ts` (test DB) | `applied 0004_order_lifecycle.sql` on both (upgrade of populated databases) |
| `tsc --noEmit -p tsconfig.json --incremental false` | exit 0 |
| `RUN_DB_INTEGRATION=1 vitest run tests/integration/orders.db.test.ts` | 18/18 |
| `RUN_DB_INTEGRATION=1 vitest run` | `Test Files 13 passed (13)` · `Tests 150 passed (150)` |
| `tsx scripts/release-check.ts` | 4× PASS |
| Browser, dev server + local DB (persona sessions via `/api/dev/session`, no passwords) | buyer_a booked → paid with the local test provider → creator_c **Start work** → **Submit delivery** → buyer_a opened the order ("opened by buyer" recorded) → **Approve version 1** → `POST /api/dev/jobs` → order **COMPLETED**, settlement **RELEASED**, timeline `ORDER CREATED → PAYMENT CONFIRMED → WORK STARTED → DELIVERED → ORDER APPROVED → SETTLEMENT RELEASED`, review form shown |

## Acceptance (local PostgreSQL + mock provider)

| ID | Proven by | Status |
|---|---|---|
| ORD-01 | payments lifecycle test (book → pay → start → deliver → revision → deliver → approve → release → COMPLETED → review, exact event list) + browser run | PASS (local) |
| ORD-02 | start/deliver refused while payment pending (409) and while brief missing (422 BRIEF_INCOMPLETE) | PASS (local) |
| ORD-03 | auction order: due = max(funded 5h ago, brief now) + 72h; never null | PASS (local) |
| ORD-04 | late start keeps the fixed due date and work_start | PASS (local) |
| ORD-05 | V1 kept (append-only enforced by DB), revision due 48h, V2 resets review window | PASS (local) |
| ORD-06 | second revision → 422 REVISION_LIMIT_REACHED; dispute still possible | PASS (local) |
| ORD-07 | too-short note and `javascript:` link refused; review not started; link delivery accepted | PASS (local) |
| ORD-08 | approve V1 after V2 → 409; approve without version → 400; nothing approved | PASS (local) |
| ORD-09 / ORD-16 | expired window + consent + view evidence → one AUTO_APPROVED under concurrent replays; later release → COMPLETED | PASS (local) |
| ORD-10 | concurrent approve/revision/dispute/auto-accept → exactly one outcome and one event | PASS (local) |
| ORD-11 | no view evidence → one hold + case, still DELIVERED; buyer view resolves hold and restarts full 72h | PASS (local) |
| ORD-13 | overdue notice queued; unilateral cancel after start refused; cancellation request path | PASS (local) |
| ORD-15 | accepted partial refund 400 of 650 → refund op `agreed` 40000, remainder release 25000, capacity CONSUMED, ledger nets to zero; delivery vs acceptance race → one decision; stale request after delivery → 409 and EXPIRED; consented amount immutable in DB | PASS (local) |
| REV-01 / REV-02 | outsider/creator 403, before completion 409, three concurrent submits → one review | PASS (local) |
| REV-03 | fixtures excluded by default (all zero/null); with flag: 1 job, on-time 1/1, rating 4, N reported | PASS (local) |
| CAP-12 | refund after work never returns capacity (reservation CONSUMED) | PASS (local) |
| ORD-12 (deadline extension), ORD-14 (chargeback after completion) | not implemented | NOT_RUN |

## Known limits

1. **Dispute resolution** (resume, approve, cancel with evidence) needs the finance/operator role model: W2-B.
2. **"Buyer notified" evidence is page-view only.** No email provider delivery confirmation exists, and email rows are sink-only.
3. **Brief form is minimal.** Structured brief fields (§7.4) and a per-service brief schema are not built; the brief is free text with a ≥20 character minimum.
4. **UI verified in one browser session at the default desktop size.** No 360/768/1440 evidence yet (C5).
