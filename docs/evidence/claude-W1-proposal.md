# Proposal — Wave 1 task pair (Claude → Astra for confirmation)

Date: 2026-09-13 · Author: Claude · Status: **PROPOSED, not started**. No code was changed for this proposal.
Master: `docs/MASTER_PROMPT.md` (byte-identical to `~/Downloads/MASTER_PROMPT_BUILD_CREATOR_MARKETPLACE_0_PERCENT.md`, verified with `cmp`).

## 1. Read-only audit (what exists today)

| Check | Result |
|---|---|
| `git status` / `git log` | Branch `main`, **no commits**; everything untracked. No baseline to diff or review against. |
| `docs/COLLABORATION.md` | Only the original Claude assignment (providers/notifications), which is done. **No task with `owner=Claude`**, so this is a proposal only. |
| `docs/ACCEPTANCE.md` | Still pre-DB: P0-05/06/07/08 PARTIAL; P1A/P1B/P2/P3 "CODE COMPLETE / NOT ACCEPTED". Not updated with DB evidence. |
| `docs/BUILD_STATUS.md`, `docs/HANDOFF.md` | Lead text is older than Claude's dated update blocks at the top. The "Not accepted yet" and Mirai sections are stale. |
| `tsc --noEmit -p tsconfig.json --incremental false` | exit 0 |
| `vitest run` (no DB flag) | 2 files passed, 3 skipped · 49 tests passed, 34 skipped (DB suites skipped, not passed) |
| Last recorded DB run (`docs/evidence/claude-db-integration.md`) | `RUN_DB_INTEGRATION=1 vitest run` → 83/83. Local PostgreSQL 18.4 is still listening on 127.0.0.1:55432. |
| CI | `.github/workflows/` exists but is empty; no CI pipeline. |
| Scripts vs master §17.4 | Missing: `env:check`, `jobs:dev`, `lint` wiring, `test:contracts`, `test:e2e`, `test:security`, `reconcile:dry-run`, `release:check`. `test:critical` is an alias for all tests. `scripts/seed.ts` has no production/allowlist guard (FND-07). |

### Gaps against P1A/P1B, found by reading code, relevant to Wave 1

1. **Two monolithic shared files block parallel work.** `src/app/api/commands/route.ts` (33 KB) holds every command, and `src/app/[[...path]]/page.tsx` (35 KB) holds every screen, with one route per very long line. Two agents editing either file concurrently in the same working tree will clobber each other.
2. **No immutable service/terms snapshot (SUP-03).** `orders.terms` stores only `{revision_limit}`. There is no `service_version`, and price/scope/turnaround are read live from `services` at booking.
3. **Capacity is a single counter per pool** (CAP-02/06/08, master §6.1/§6.5). There are no weekly `CapacityBucket`s, no timezone, and no shared pool across services: `create_service` always creates its own pool.
4. **The work clock is wrong (ORD-03/04).** `delivery_due_at = now() + turnaround` is set at **booking**, before funding or brief readiness. There is no `work_start_at` or `funded_at`.
5. **No optimistic versioning on order commands (ORD-08).** `expectedVersion` and `deliveryVersion` appear nowhere, so `approve` can accept a stale delivery.
6. **Approve jumps straight to COMPLETED.** Master §7.2/§7.3 requires `APPROVED`, then `COMPLETED` only after the required settlement is released. The release job currently keys on `COMPLETED`.
7. **Missing order-lifecycle pieces:** auto-accept, review reminders, `ReviewHold`, and mutual cancellation requests after work starts (ORD-09/11/13/15/16).
8. **Suspended users lose all access (SEC-10).** `getActor` requires `status='ACTIVE'`, so a suspended creator cannot reach existing obligations.
9. **Operator surfaces are absent:** no roles table, `app.audit_log` is unused (0 references), and there is no finance/moderator path (SEC-12/13) or admin queue. This is planned for Wave 2 below.

## 2. Prerequisite — W1-0 shared contracts (must land before parallel work)

| Field | Value |
|---|---|
| task_id | **W1-0** |
| owner | **Astra**, as coordinator of shared contracts. Claude can do it instead if Astra prefers; it is mechanical. |
| goal | Create a reviewable baseline and split the two monolithic files, so W1-A and W1-B own disjoint files. No behaviour change. |
| files_owned | `src/app/api/commands/route.ts` (reduced to dispatcher + idempotency envelope), new `src/lib/commands.ts` (`CommandError`, `CommandContext`, `CommandHandler`, input helpers `text/integer/money/instant`), `src/app/[[...path]]/page.tsx` (reduced to the public/auth shell); route segments or components extracted per domain |
| dependencies | User/Astra approval for a **baseline git commit**. Claude will not commit without it. |
| acceptance_ids | none new. Regression only: the existing 83 DB tests plus 49 unit tests stay green. |
| tests | `tsc`; `vitest run`; `RUN_DB_INTEGRATION=1 vitest run` (Claude can run the DB suite in the user's shell and record results) |
| status | PROPOSED |

Command handler contract proposed for W1-0 (both W1-A and W1-B code against this):

```ts
// src/lib/commands.ts
export type CommandContext = { tx: postgres.TransactionSql; actor: Actor; form: FormData };
export type CommandResult = { path: string; message: string; id?: string };
export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>;
export class CommandError extends Error { constructor(message: string, readonly code: CommandErrorCode = 'INVALID_INPUT') }
// CommandErrorCode follows master §13.3 (FORBIDDEN, VERSION_CONFLICT, ORDER_STATE_CONFLICT, CAPACITY_UNAVAILABLE, …)
// Route: registry { [command]: handler } merged from src/modules/*/commands.ts; envelope keeps advisory lock + app.commands replay.
```

Domain-state contract between W1-A and W1-B (agree before coding):

| Item | Contract |
|---|---|
| Order terms snapshot | At order creation (W1-A), `orders.terms` must contain `schema_version:1, service_version_id, title, price_minor, currency, turnaround_hours, revision_limit, review_window_hours:72, auto_accept_consent:true|false, cancellation_policy_version`. W1-B reads only these keys. |
| Due dates at creation | W1-A leaves `delivery_due_at` **NULL** at booking. W1-B sets `work_start_at` / `delivery_due_at` at funding from the snapshot. |
| Reservation states | Keep the existing names (`HELD`, `RECONCILING`, `COMMITTED`, `CONSUMED`, `RELEASED`). W1-A moves counters from pool to bucket; W1-B only calls a capacity helper `commitReservation(tx, orderId)` / `consumeReservation(tx, orderId)` / `releaseReservation(tx, orderId)` **exported by W1-A** from `src/modules/capacity/index.ts`. Until W1-A lands, W1-B uses the current pool-counter code behind the same function names. |
| Migrations | Numbers are reserved: **0003 = W1-A**, **0004 = W1-B**. Each migration touches only its own columns/tables and must apply on a DB without the other. `ALTER TABLE app.orders` column sets are disjoint (W1-A: `service_version_id`; W1-B: lifecycle columns). |

## 3. Wave 1 pair (roughly equal effort, disjoint files)

Both packages are backend/domain-heavy, each with one migration, a real-DB race/fault suite and UI touch-points.

### W1-A — Supply engine v2: service versions, snapshots, weekly capacity buckets, shared pools

| Field | Value |
|---|---|
| task_id | **W1-A** |
| owner | **Astra** |
| goal | Implement P1A-03/05/07/08. Services get immutable versions and orders snapshot them. Capacity moves to per-pool weekly buckets in the creator's timezone, with multi-service shared pools and bucket locking in ID order (§6.4). Covers publish/pause/archive with `expectedVersion`, booking through the bucket with the snapshot contract above, and suspended-user rules for **new** sales. |
| files_owned | `drizzle/0003_supply_capacity.sql`; `src/modules/catalog/**` (service/sample/profile commands + read models); `src/modules/capacity/**` (bucket materialization, reserve/commit/consume/release helpers); `src/lib/read-model.ts` catalog parts; creator/service UI segments extracted in W1-0; `scripts/seed.ts` (FND-07 guard + shared-pool fixture); `tests/integration/supply.db.test.ts` |
| dependencies | W1-0; the domain-state contract above |
| acceptance_ids | SUP-01, SUP-02, SUP-03, SUP-04, CAP-01 (20 real concurrent connections), CAP-02, CAP-06, CAP-07, CAP-08, CAP-09 (auction/Buy Now keeps the same reservation), SEC-09, SEC-10 (new-sale half), FND-07 |
| tests | real-DB barrier concurrency (20 sessions), shared pool across two services, DST 23h/25h week buckets, version edit after sale, capacity reduction conflict, seed refusal on non-local target |
| status | PROPOSED |

### W1-B — Order lifecycle engine: state machine, versions, work clock, APPROVED→COMPLETED, auto-accept, cancellation requests

| Field | Value |
|---|---|
| task_id | **W1-B** |
| owner | **Claude** |
| goal | Implement P1B-04/05/06 and the §7.2 transition matrix as one server-side module. |
| files_owned | `drizzle/0004_order_lifecycle.sql` (order lifecycle columns `funded_at`, `brief_ready_at`, `work_start_at`, `approved_at`, `completed_at`; `app.review_holds`; `app.cancellation_requests`; delivery `validation_status`; one-active-dispute partial unique); `src/modules/orders/**` (state machine, commands start/deliver/revision/approve/dispute/cancel/cancellation-request/respond/review/message); `src/modules/payments/funding.ts` (work clock at funding, COMPLETED on release, refund linkage); `src/modules/jobs/index.ts` (auto-accept, review reminder, due-soon/overdue jobs); order workspace UI segment extracted in W1-0; `tests/integration/orders.db.test.ts`, plus updates to `payments.db.test.ts`, `jobs.db.test.ts`, `commands.db.test.ts` (lifecycle parts only) |
| dependencies | W1-0; the snapshot/due-date contract; `src/modules/capacity` helper names (stub until W1-A lands) |
| acceptance_ids | ORD-01, ORD-02, ORD-03, ORD-04, ORD-05, ORD-06, ORD-07, ORD-08, ORD-09, ORD-10, ORD-11, ORD-13, ORD-15, ORD-16, REV-01, REV-02, CAP-12 |
| tests | stale `deliveryVersion` / `expectedVersion` conflicts; concurrent approve vs revision vs dispute vs auto-accept (real connections); auto-accept replay → one approval + one settlement intent; missing notification evidence → ReviewHold then a fresh 72h window; mutual cancellation with agreed amount under concurrent delivery; work clock from `max(funded_at, brief_ready_at)`; APPROVED stays until release webhook → COMPLETED |
| status | PROPOSED |

Effort balance: each side has one migration, one domain module of similar size, one real-DB race suite with 12–17 acceptance IDs, and one UI segment. Neither side is the "easy" half.

## 4. Cross-review plan

| Reviewer | Reviews | Focus |
|---|---|---|
| Claude | W1-0, W1-A | lock ordering, counter/reservation invariants, snapshot immutability, migration applies to blank DB + upgrade from 0002 |
| Astra | W1-B | transition matrix fidelity to §7.2, version conflicts, job idempotency, ledger unchanged |
| Astra | Claude's earlier phase 2/3 changes (listed in `docs/CLAUDE_REPORT.md`) | still unreviewed by the lead; acceptance rows should not move until reviewed |

Each owner writes `docs/evidence/<owner>-<task-id>.md` with exact commands/results. Astra integrates into `BUILD_STATUS/HANDOFF/ACCEPTANCE`.

## 5. Preview of later waves (not a request to start)

| Wave | Astra | Claude |
|---|---|---|
| W2 | Storage upload intents + private delivery assets + signed download (SEC-05/06/14, ORD-07 asset side) | Roles/audit/operator: `user_roles`, audit log, finance refund + dispute resolution commands, reconciliation queue UI, retry same operation (SEC-12/13, OPS-05, P1C-04) |
| W3 | Playwright E2E with DB-created test sessions (no password typing), 360/768/1440 evidence, CI workflow + §17.4 scripts (FND-01/02, G3, OPS-07) | Scheduler wiring (Inngest local) + provider calls moved out of DB transactions + Stripe sandbox adapter behind the same contract suite (BLOCKED without keys, recorded as such) (OPS-01/04, PAY-10/11 on real adapter) |

## 6. Decisions needed from Astra

1. Confirm or adjust W1-0 / W1-A / W1-B owners and file lists, then write them into `docs/COLLABORATION.md` with `owner=`.
2. Approve a baseline commit before W1-0 (needed for cross-review diffs).
3. Confirm the snapshot keys and the capacity helper names in §2.
4. Confirm migration numbering (0003 Astra, 0004 Claude).
5. Decide who removes the stale Mirai notes (`docs/MIRAI_PROVIDER.md`, README, BUILD_STATUS, HANDOFF, `docs/evidence/p0-foundation.md`). The user dropped Mirai, and these are lead-owned docs.

Claude will not edit code until a task with `owner=Claude` appears in `docs/COLLABORATION.md`.
