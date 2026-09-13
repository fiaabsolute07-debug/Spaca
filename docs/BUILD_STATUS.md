# BUILD_STATUS

Updated 2026-09-14. Verified baseline: **3bddff9**. Platform fee is always **0%**, with integer money and database fee constraints. Claude coordinates and integrates; Codex is the second engineer dispatched through `codex exec`.

| Phase | Official status | Scope / limits |
|---|---|---|
| P0 | done-local | Foundation, local auth/fixtures, PostgreSQL, contracts and operational scripts; clean-clone/frozen CI still unverified. |
| P1A | done-local | Versioned supply, immutable sold terms, weekly shared capacity; remaining per-ID gaps in the ledger. |
| P1B | done-local with mock provider | Funding, lifecycle, delivery/revision, auto-accept, mutual cancellation, reviews and operator refunds; sandbox/live payments **BLOCKED**. |
| P1C | docs done | Readiness, runbooks, staging/restore/rollback plans; staging/live **BLOCKED**. Local operator console implemented. |
| P2 | done-local | Versioned private quotes, budget reservations, multi-hire and campaign view; **REQ-11 PARTIAL** (no comparison sort/filter). |
| P3 | IN_PROGRESS | Claude owns auction code, migrations, tests and pages; concurrent work has no acceptance claim here. |
| P4–P6 | TODO | Crypto/rewards, advanced discovery, cross-platform/PUBLISH/ACCESS/DIGITAL and bank funding. |

Latest verified results: **184/184 tests across 17 files with DB suites enabled**, plus **tsc exit 0**, at `3bddff9`. The full run includes unit/provider tests, not 184 exclusively DB tests. Sources: [C6 review](evidence/claude-review-C6.md) and its referenced commit; [W3-R](evidence/claude-W3-R.md) records the preceding suite. C3 did not rerun application tests or a build. Browser evidence covers W1-B booking through completion, W2-S private file delivery/download and 360px layout, W3-R request hire/funding, and C6 role isolation plus a 360px flag form. Full 768/1440, keyboard and multi-hire E2E checks remain NOT_RUN.

PostgreSQL runs and DB suites pass in **Claude's shell**. The Codex managed runner cannot start PostgreSQL because its IPC permissions reject bootstrap shared memory; this is a runner limitation, not a global product/database blocker. Claude runs DB suites and browser checks and makes scoped commits. Codex writes only dispatched paths and evidence. Current assignments are in [COLLABORATION.md](COLLABORATION.md); the old Codex-lead split in AGENTS.md is superseded by the user's coordination instruction.

Implemented local system:

- `MockPaymentProvider`: in-memory provider state with durable application journals/inbox/ledger; local funding through verified mock webhooks or provider-API reconciliation facts. `sandbox_pay` is rejected (403), never a usable funding command. Provider calls still occur inside DB transactions; split journal commit/remote effects before a real adapter. Restarting Next loses mock provider history.
- Capacity counters live on `app.capacity_buckets`, derived by triggers from `app.reservations`: HELD/RECONCILING reserve; COMMITTED/CONSUMED commit. Pool → bucket → order is the capacity lock contract; order-first worker paths need Claude's consistency review (C3 evidence). No manual counter repair.
- `LocalStorageProvider`: upload intent → signed PUT → finalize with size/signature/SHA-256 checks; invalid files quarantined, private downloads expire after five minutes. **No antivirus and no Supabase Storage adapter**; signature CLEAN does not mean malware-free.
- In-process jobs run through `POST /api/dev/jobs`, optionally polled by `pnpm jobs:dev`; durable rows survive, the mock provider does not. Nine accepted baseline jobs and the current unverified P3 tenth job are listed in [runbooks](runbooks/README.md). **Inngest integration and reconcile:dry-run are NOT IMPLEMENTED**. External email is sink-only.
- Operator `/admin` pages use active `app.user_roles` grants, required reasons and append-only `app.audit_log`. Checkout/bid/payout creation kill switches preserve webhooks, refunds and reconciliation; enabling live also requires an environment gate and G6 readiness.
- Orders use the DB transition matrix, fixed funding/brief work clock, delivery versions, page-view-based ReviewHold recovery and consented mutual cancellation. Request order triggers commit/release budget; partial refunds keep budget committed. Legacy requests before migration 0007 lack budget-reservation backfill.

[Acceptance](ACCEPTANCE.md) and [traceability](REQUIREMENTS_TRACEABILITY.md) retain narrower gaps despite local phase delivery. Gates: **G0–G4 PARTIAL; G5–G7 BLOCKED**. Missing staging infrastructure, real payment/storage/email adapters, provider credentials/approval, entity/policies/reserve, launch authority and actual market evidence remain separate blockers. No sandbox, testnet, live money, deployment or production readiness is claimed.
