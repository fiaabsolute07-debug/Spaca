# BUILD_STATUS

Updated 2026-09-14. Verified baseline: **94792af** (W5-C1) plus the C5 E2E run. Platform fee is always **0%**, with integer money and database fee constraints. Claude coordinates and integrates; Codex is the second engineer dispatched through `codex exec`.

| Phase | Official status | Scope / limits |
|---|---|---|
| P0 | done-local | Foundation, local auth/fixtures, PostgreSQL, contracts and operational scripts; clean-clone/frozen CI still unverified. |
| P1A | done-local | Versioned supply, immutable sold terms, per-creator active-order limit with pause (W7-CAP); remaining per-ID gaps in the ledger. |
| P1B | done-local with mock provider | Funding, lifecycle, delivery/revision, auto-accept, mutual cancellation, reviews and operator refunds; sandbox/live payments **BLOCKED**. |
| P1C | docs done | Readiness, runbooks, staging/restore/rollback plans; staging/live **BLOCKED**. Local operator console implemented. |
| P2 | done-local | Versioned private quotes, budget reservations, multi-hire and campaign view; **REQ-11 PARTIAL** (no comparison sort/filter). |
| P3 | done-local | W4-A AUC-01..14 PASS local-db+mock; payout readiness, P3-07 metrics and E2E execution gaps remain. |
| P4 | IN_PROGRESS (Claude) | Crypto/rewards; concurrent implementation has no new verification claim here. |
| P5 | done-local backend | W6-D search/filters/cursors, creators, ending soon, trending-v1 with COLD_START, eligible views, sitemap/robots/noindex, local DSC-06 benchmark; DSC-01/03/04/06 PASS, DSC-02/05 PARTIAL until the discovery UI exists. |
| P6 | TODO | Cross-platform/PUBLISH/ACCESS/DIGITAL and bank funding. |

Latest verified results: **222/222 tests across 22 files with DB suites enabled**, **tsc exit 0**, with W6-D on `26d6680` ([W6-D](evidence/claude-W6-D.md)); earlier 214/214 at `26d6680` ([W5-C2](evidence/claude-W5-C2.md)) and 206/206 at `94792af` ([W5-C1](evidence/claude-W5-C1.md)); **Playwright E2E 14/14 passed** in system Chrome against Next dev and the seeded dev DB, with 18 screenshots at 360/768/1440 ([C5 review](evidence/claude-review-C5.md)). Earlier: 195/195 at `90004fd` ([W4-A](evidence/claude-W4-A.md)). The full run includes unit/provider tests, not 195 exclusively DB tests. C3c maps that evidence; C5 authors Playwright journeys and runs typecheck/test discovery only ([C3c](evidence/codex-C3c.md), [C5](evidence/codex-C5.md)). Browser evidence covers W1-B booking through completion, W2-S private file delivery/download and 360px layout, W3-R request hire/funding, C6 role isolation/360px flag form, and W4-A two-persona outbid polling within ≤6.5 s. C5 browser execution, full viewport and keyboard checks remain NOT_RUN.

PostgreSQL runs and DB suites pass in **Claude's shell**. The Codex managed runner cannot start PostgreSQL because its IPC permissions reject bootstrap shared memory; this is a runner limitation, not a global product/database blocker. Claude runs DB suites and browser checks and makes scoped commits. Codex writes only dispatched paths and evidence. Current assignments are in [COLLABORATION.md](COLLABORATION.md). AGENTS.md matches that coordination model.

Implemented local system:

- `MockPaymentProvider`: in-memory provider state with durable application journals/inbox/ledger; local funding through verified mock webhooks or provider-API reconciliation facts. `sandbox_pay` is rejected (403), never a usable funding command. Provider calls still occur inside DB transactions; split journal commit/remote effects before a real adapter. Restarting Next loses mock provider history.
- Capacity counters live on `app.creator_workloads`, derived by triggers from `app.workload_claims`: HELD/EXPIRY_RECONCILING are held, ACTIVE is active; the claim insert trigger refuses claims above the limit or while paused, and the order status trigger frees units on APPROVED/COMPLETED/CANCELLED/REFUNDED. Lock contract: aggregate → workload → order ([W7-CAP](evidence/claude-W7-CAP.md)); dedicated funding/expiry race coverage remains. No manual counter repair; `app.workload_counter_drift` must be empty.
- `LocalStorageProvider`: upload intent → signed PUT → finalize with size/signature/SHA-256 checks; invalid files quarantined, private downloads expire after five minutes. **No antivirus and no Supabase Storage adapter**; signature CLEAN does not mean malware-free.
- In-process jobs run through `POST /api/dev/jobs`, optionally polled by `pnpm jobs:dev`; durable rows survive, the mock provider does not. Ten accepted local jobs, including W4-A `close_due_auctions` (AUC-05/06), are listed in [runbooks](runbooks/README.md). **Inngest integration and reconcile:dry-run are NOT IMPLEMENTED**. External email is sink-only.
- Operator `/admin` pages use active `app.user_roles` grants, required reasons and append-only `app.audit_log`. Checkout/bid/payout creation kill switches preserve webhooks, refunds and reconciliation; enabling live also requires an environment gate and G6 readiness.
- Orders use the DB transition matrix, fixed funding/brief work clock, delivery versions, page-view-based ReviewHold recovery and consented mutual cancellation. Request order triggers commit/release budget; partial refunds keep budget committed. Legacy requests before migration 0007 lack budget-reservation backfill.

[Acceptance](ACCEPTANCE.md): **51 PASS, 55 PARTIAL, 33 NOT_RUN, 3 BLOCKED (142 rows)**. The ledger and [traceability](REQUIREMENTS_TRACEABILITY.md) retain narrower gaps despite local phase delivery. Gates: **G0–G4 PARTIAL; G5–G7 BLOCKED**. Missing staging infrastructure, real payment/storage/email adapters, provider credentials/approval, entity/policies/reserve, launch authority and actual market evidence remain separate blockers. No sandbox, testnet, live money, deployment or production readiness is claimed.
