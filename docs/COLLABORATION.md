# Collaboration board

Root project: this directory. Master: `docs/MASTER_PROMPT.md`. TypeScript strict, ESM, Node 24, Vitest. Platform fee is always 0%.

## Update (user decision, 2026-09-14)

The user now drives Codex directly to build the UI. Claude no longer dispatches `codex exec`. Claude continues the backend roadmap (W5-C2 onward) and keeps `docs/UI_CONTRACT.md` complete for every new read model and command, so the UI can be built against it. The Codex task rows below are historical.

## Current model (user decision, 2026-09-13)

The user asked Claude to build the product end to end and to **coordinate Codex (Astra)** as the second engineer. Claude assigns and integrates tasks on this board; each engineer implements and tests their own tasks and reviews the other's.

**Why this split.** The Codex runner cannot start PostgreSQL (SysV `shmget` blocked) or Turbopack. Claude's shell can. So:
- **Claude** owns database, domain, API and DB-backed tests.
- **Codex** owns UI, docs, operational scripts, CI and E2E authoring.

Both halves are full implementation work with their own tests.

## File ownership (hard boundaries)

| Owner | Paths |
|---|---|
| **Claude** | `drizzle/**`, `src/modules/**`, `src/lib/**`, `src/app/api/**`, `scripts/postgres.ts`, `scripts/migrate.ts`, `scripts/seed.ts`, `tests/integration/**`, `tests/providers.test.ts`, `tests/unit/**` for modules, `docs/UI_CONTRACT.md` (backend contract), `docs/evidence/claude-*.md`, `docs/CLAUDE_REPORT.md`, this board |
| **Codex** | `src/app/**` **except** `src/app/api/**`; `src/components/**`; `src/app/globals.css`; `tests/e2e/**`; `playwright.config.ts`; `.github/workflows/**`; `scripts/env-check.ts`, `scripts/release-check.ts` (new scripts other than the three Claude scripts); `README.md`; `docs/PAYMENT_READINESS.md`, `docs/runbooks/**`, `docs/STAGING.md`, `docs/RELEASE_CHECKLIST.md`, `docs/ACCEPTANCE.md`, `docs/BUILD_STATUS.md`, `docs/HANDOFF.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/PRODUCT_SPEC.md`, `docs/MIRAI_PROVIDER.md`, `docs/evidence/codex-*.md`, `docs/evidence/astra-review-*.md` |
| Shared, change by request only | `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`, `next.config.ts`. Write the requested change in your evidence file; Claude applies it. |

**How Codex is connected.** Claude dispatches each Codex task with the official Codex CLI:
- Command: `~/.local/bin/codex exec -C <repo> -s workspace-write -o <report>`. The binary is signed by OpenAI OpCo, LLC and runs in a sandbox with no network.
- Codex writes code and its evidence file. It does **not** commit and does **not** edit this board.
- Claude reviews each Codex diff, writes `docs/evidence/claude-review-<task>.md`, commits the Codex paths as `<task>: … (Codex)`, and updates the board status.

Rules:
- Never edit the other owner's paths. Put requests in your evidence/review file.
- **Git:** Claude is the only committer. Commit only the task's paths (`git add <paths>`, never `git add -A`). No reset, rebase, stash or checkout of others' files. Commit messages start with the task id.
- UI reads only exported read models and posts only commands documented in `docs/UI_CONTRACT.md`. If the UI needs a new field or command, write the request in `docs/evidence/codex-<task>.md`; Claude adds it and updates the contract.
- Codex cannot run DB suites. Claude runs `RUN_DB_INTEGRATION=1 vitest run` and E2E against local PostgreSQL, and records results in `docs/evidence/claude-*.md`.
- No live money, public deployment, external messages or secrets. Label mock, sandbox, testnet and live separately. A green build is not acceptance.

## Task board

Status values: TODO · IN_PROGRESS · REVIEW · DONE · BLOCKED.

### Claude

| task_id | goal | acceptance_ids | depends | status |
|---|---|---|---|---|
| W1-0 | Split the command route into domain modules (`bf5e2e2`) | regression 83/83 | — | DONE |
| W1-A | Supply engine v2: service versions + order terms snapshot, weekly capacity buckets (timezone/DST), shared pools, lock order, suspended-user new-sale block, seed guard. Migration 0003. Evidence `docs/evidence/claude-W1-A.md` | SUP-01..04, CAP-01/02/06/07/08/09, SEC-09/10, FND-07 | W1-0 | DONE |
| W1-B | Order lifecycle engine (§7.2): expected/delivery versions, work clock at funding, APPROVED→COMPLETED on release, auto-accept + ReviewHold + reminders, mutual cancellation requests, reviews. Migration 0004. Includes the order/booking UI (Codex at usage limit). Evidence `docs/evidence/claude-W1-B.md` | ORD-01..11/13/15/16, REV-01/02/03, CAP-12 | W1-A | DONE |
| W1-S | Dev-only fixture session endpoint for E2E (`POST /api/dev/session`, local only, fail closed in production), §17.3 personas, FND-07 seed guard (`bf9ccba`) | FND-03, FND-07, SEC-08 | W1-0 | DONE |
| W2-B | Roles/audit/operator backend: `user_roles`, append-only audit log, finance refund + dispute resolution, reconciliation retry, case/moderation/suspension, feature flags + checkout/bid/payout kill switches, operator queue read models. Migration 0005. Evidence `docs/evidence/claude-W2-B.md` | SEC-12/13, OPS-04/05, FND-05 | W1-B | DONE |
| W2-S | Storage: upload intents, finalize (size/signature/SHA-256, quarantine), private delivery/brief/dispute files, 5-minute signed downloads, sample files, orphan cleanup, delivery upload UI. Local filesystem adapter only (Supabase adapter + AV scanning not done). Migration 0006. Evidence `docs/evidence/claude-W2-S.md` | SEC-01/05/06/14, ORD-07 | W1-B | DONE |
| W3-R | P2 requests v2: versioned private quotes, 24 h hire offers holding request budget/hire count (DB CHECK counters), creator capacity-plan confirmation, canonical order per hire, funding/refund/lapse budget sync trigger, close/cancel, offer expiry job, campaign read model + request UI. Migration 0007. Evidence `docs/evidence/claude-W3-R.md` | REQ-01..10 (REQ-11 PARTIAL) | W2 | DONE |
| W4-A | P3 auctions v2: exact state enum + DB transition guard, write-once first_valid_bid_at, sequenced idempotent bids with moderated invalidation, single purchase intent (WINNER 24 h / BUY_NOW checkout TTL), idempotent close job, default without relist, snapshot polling UI + My bids. Migration 0008. Evidence `docs/evidence/claude-W4-A.md` | AUC-01..14 | W3-R | DONE |
| W5-C1 | P4 crypto checkout rail on a simulated local devnet: network/asset registry (mainnet/testnet gates), wallet proof of control, server-verified settlement events (reference/asset/amount/sender/finality), idempotent indexer with checkpoint, reorg/outage handling, order funding via funding.ts, UI with network labels. Migration 0009. Evidence `docs/evidence/claude-W5-C1.md` | CRY-02..05 PASS local; CRY-01/11/14 PARTIAL; testnet/contract BLOCKED/NOT_RUN | W4-A | DONE |
| W5-C2 | P4 campaign pools: per-asset buckets with DB conservation CHECK, versioned reward templates, atomic hire allocation funding the order (rail POOL), per-asset release with EIP-712 single-use authorizations and retry of failed assets only, unused-balance refund, PERK/NFT entitlements, cancel/return. Migration 0010. Evidence `docs/evidence/claude-W5-C2.md` | CRY-06/07/08/09/12 PASS local; CRY-10 PARTIAL (no Solidity) | W5-C1 | DONE |
| W6-D | P5 discovery: full-text search (simple config) on published versions and profiles, allowlisted filters/sorts with sort-bound keyset cursors, creator discovery (rating only at ≥3 reviews, no followers), server-time ending soon, trending-v1 with COLD_START label, hashed rate-limited eligible views, sitemap/robots/noindex, capacity horizon job, production exclusion of is_test supply, DSC-06 benchmark. Migration 0011. Evidence `docs/evidence/claude-W6-D.md` | DSC-01/03/04/06 PASS local; DSC-02/05 PARTIAL (no browser UI) | W5-C2 | DONE |
| W7-CAP | Capacity plan B: per-creator active-order limit (`creator_workloads`/`workload_claims`), pause new orders, units_per_order, DB guard + order release trigger, availability status only for buyers, drift view/job, creator order-limit UI. Migration 0012. Evidence `docs/evidence/claude-W7-CAP.md` | CAP-01/02/03/06/07/08/09/12 PASS local; CAP-04/05/10 PARTIAL; CAP-11 NOT_RUN | W6-D | DONE (5d169eb) |
| W8-PUB | P6 PUBLISH first: self-reported social accounts, PUBLISH listing/request terms and consent, publication proof on the sold channel, content policy screen, report queue with moderator resolution, publish with one sample. Migration 0013. Evidence `docs/evidence/claude-W8-PUB.md` | XPL-01/02, MOD-01/02, SUP-01/05/06 PASS local | W7-CAP | DONE |
| W9-ARC | Arc escrow model A: SpacaEscrow contract + Foundry unit/fuzz/invariant tests, payout outbox worker (no chain call in DB tx), crypto rail release/refund/dispute freeze, pool payouts via outbox, EVM adapter, anvil end-to-end, browser wallet funding, Arc testnet check/register scripts, mainnet release gate, ADR 002. Migration 0014. Evidence `docs/evidence/claude-W9-ARC.md` | CRY-04/05/07/10/11/13/14 PASS local; CRY-01 PARTIAL; testnet deploy BLOCKED (faucet) | W8-PUB | DONE |
| P6-ACCESS | ACCESS time-slot sessions: weekly availability in the creator's zone, 15-minute slots with 12 h notice, GiST no-overlap with buffers, hold/fund/cancel sync, buyer cancellation notice + mutual late cancellation, session outcome as delivery, buyer/creator no-show, private meeting link, slots API, picker/availability/session UI. Migration 0015. Evidence `docs/evidence/claude-P6-ACCESS.md` | CAP-11, XPL-03 PASS local | W9-ARC | DONE |
| P6-DIGITAL | DIGITAL products: versioned releases in a private bucket, NON_EXCLUSIVE/EXCLUSIVE licenses with stock, entitlements instead of workload claims (DB guard + advisory lock), delivery on payment, signed per-buyer downloads with version and count limits, refund before first download, hold expiry and storage cleanup, UI for creator releases and buyer files. Migration 0016. Evidence `docs/evidence/claude-P6-DIGITAL.md` | XPL-04..06 PASS local | P6-ACCESS | DONE |
| ORD-12 | Deadline extensions by agreement: immutable amendments, counterparty consent, DB guard on the delivery deadline, expiry on status change, Deadline panel. Migration 0020. Evidence `docs/evidence/claude-ORD-12.md` | ORD-12 PASS local | P6-DIGITAL | DONE |
| ORD-14 | Card payment disputes after completion: signed mock dispute facts, immutable payment_disputes with evidence snapshot, operator cases and creator notice, loss booking without creator debit, release freeze. Migration 0021. Evidence `docs/evidence/claude-ORD-14.md` | ORD-14 PASS local | ORD-12 | DONE |
| PAY-15 | Refunds after release: mock transfer reversals with balance checks, deficit tracking with DB-enforced recovered amounts, retry and approved platform cover, admin UI. Migration 0022. Evidence `docs/evidence/claude-PAY-15.md` | PAY-15 PASS local | ORD-14 | DONE |
| PAY-16 | Late provider costs: cost-v1 policy (capped creator share before payout, no retro debit, credits owed after payout), signed fee updates, immutable adjustments with cap trigger, inbox retry for early facts, admin table. Migration 0023. Evidence `docs/evidence/claude-PAY-16.md` | PAY-16 PASS local | PAY-15 | DONE |
| BNK | Bank transfer funding: flag + provider capability, bank-v1 120 h hold, verified-fact funding, reconciliation on expiry, returns handling, sandbox bank route, buyer UI, E2E warm-up. Migration 0024. Evidence `docs/evidence/claude-BNK.md` | BNK-01..03 PASS local | PAY-16 | DONE |
| OPS-02 | Local restore rehearsal: snapshot logical backup (tables + files), isolated restore, obligations/invariants/jobs dry-run comparison, webhook replay as app role, fault self-test, runbook. Evidence `docs/evidence/claude-OPS-02.md` | OPS-02 PASS local | BNK | DONE |

### Codex (Astra)

| task_id | goal | files | acceptance_ids | depends | status |
|---|---|---|---|---|---|
| C1 | **UI architecture split, no behaviour change.** (DONE `d5ca6c8`, reviewed + browser-verified) Move each route out of `src/app/[[...path]]/page.tsx` into real App Router segments (`src/app/page.tsx`, `explore/`, `creators/[handle]/`, `services/[id]/`, `orders/[orderId]/`, `requests/…`, `auctions/…`, `dashboard/`, `creator/…`, `buyer/…`, `settings/…`, `sign-in`, `sign-up`, policy pages). Extract shared UI into `src/components/**`. Keep every form field/command exactly as in `docs/UI_CONTRACT.md`. Delete the catch-all only when every route is migrated. | `src/app/**` (not api), `src/components/**` | OPS-07 groundwork, G3 | W1-0 | TODO |
| C2 | **P1C documentation set** (DONE `e762801`, reviewed) from master §8.2, §19, §20, §21: `docs/PAYMENT_READINESS.md` (all rows BLOCKED/NOT_RUN with owners), `docs/runbooks/*.md` (the 10 runbooks in §20), `docs/STAGING.md` (env separation, restore rehearsal plan, migration/rollback), `docs/RELEASE_CHECKLIST.md` (G0–G7). Remove the stale Mirai notes (user dropped Mirai) from `README.md`, `docs/BUILD_STATUS.md`, `docs/HANDOFF.md`, `docs/evidence/p0-foundation.md`, and delete `docs/MIRAI_PROVIDER.md`. | docs listed | P1C-01..03/07, OPS-08 | — | TODO |
| C3 | **Acceptance integration.** (DONE at cutoff 3bddff9, reviewed `docs/evidence/claude-review-C3.md`; P3 rows follow in C3c) (PARTIAL: Codex wrote ACCEPTANCE/TRACEABILITY drafts then hit usage limit; Claude finishes after W1-B) Update `docs/ACCEPTANCE.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/BUILD_STATUS.md`, `docs/HANDOFF.md` from `docs/evidence/claude-db-integration.md` and later `claude-*.md` evidence. Map rows to master §18 IDs with status PASS(local-mock) / PARTIAL / NOT_RUN / BLOCKED. Never mark sandbox/live PASS. | docs listed | all rows | evidence files | DONE |
| C4 | **Scripts + CI.** (DONE: Codex started, hit usage limit; Claude completed — `docs/evidence/claude-C4.md`) `scripts/env-check.ts` (validate env for local/staging/production; fail closed on missing production vars; no secret printing) and `scripts/release-check.ts` (fee-zero schema check, no `sandbox_pay`/markPaid routes, production flags, NOT_RUN gates listed). `.github/workflows/ci.yml`: frozen install, typecheck, unit tests, a PostgreSQL service container running migrate + `RUN_DB_INTEGRATION=1 vitest run`, webpack build. Request the `package.json` script entries (`env:check`, `release:check`, `jobs:dev`, `test:critical`, `test:e2e`, `test:security`, `reconcile:dry-run`) in your evidence file. | files listed | FND-01/02, G0 | W1-0 | TODO |
| C5 | **E2E authoring.** (DONE: 14/14 passed in system Chrome, reviewed `docs/evidence/claude-review-C5.md`) `playwright.config.ts` using the system Chrome (`channel: 'chrome'`, no browser download) and specs in `tests/e2e/` for: anonymous explore; buyer book → pay (local test provider) → creator deliver → buyer approve; revision; dispute; request apply/select/accept; auction bid/close; 360/768/1440 screenshots. Authenticate through the W1-S dev session endpoint, **never by typing passwords**. Claude runs the suite against local PostgreSQL. | `tests/e2e/**`, `playwright.config.ts` | ORD-01 (E2E), OPS-07, G3 | C1, W1-S | DONE |
| C6 | **Operator console UI.** (DONE, reviewed `docs/evidence/claude-review-C6.md`) `/admin` (queues overview), `/admin/disputes`, `/admin/cases`, `/admin/operations`, `/admin/moderation`, `/admin/users`, `/admin/flags`, `/admin/audit`, `/admin/orders/[orderId]`. Use only the W2-B read models and commands in `docs/UI_CONTRACT.md`; every form posts to `/api/commands` with a required reason field; non-operators get the 403/404 page. No private brief/delivery text in lists. Check at 360/768/1440 with the `moderator`/`finance`/`admin` dev personas. | `src/app/admin/**`, `src/components/admin/**` | SEC-12 (UI), OPS-05 (UI) | W2-B | DONE |
| R1 | **Review.** Review Claude commits `2e00eca` (baseline incl. phase 2/3) and `bf5e2e2`, then W1-A/W1-B as they land. Write findings with file:line in `docs/evidence/astra-review-<commit>.md`. | review file | — | — | TODO |

Claude reviews every Codex commit and writes `docs/evidence/claude-review-<task>.md`.

## History

Original Claude assignment (providers/notifications, `docs/CLAUDE_REPORT.md`) is DONE. Proposal for the first 50/50 wave: `docs/evidence/claude-W1-proposal.md` (superseded by this board).
