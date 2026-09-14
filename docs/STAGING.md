# Staging and release operations

Updated 2026-09-14; accepted baseline **3bddff9**. **Staging/live BLOCKED; deployment, restore and rollback rehearsals NOT_RUN.** P1C documentation is done; this is not staging execution evidence. Platform fee always **0%**. Local evidence: [W1-A](evidence/claude-W1-A.md), [C4](evidence/claude-C4.md), [W2-S](evidence/claude-W2-S.md), [C6 review](evidence/claude-review-C6.md).

| Component | Implemented local/test | Staging/production requirement and gap |
|---|---|---|
| Database/auth | PostgreSQL in Claude's shell; isolated test DB; local sessions/fixture personas | Separate DB/runtime/migration credentials; Supabase auth/Data API negative checks BLOCKED by missing environment |
| Payments | MockPaymentProvider; durable app journals, in-memory provider; verified mock webhook/fetch | Real adapter NOT IMPLEMENTED; sandbox credentials/approval BLOCKED; live additionally requires G6 |
| Storage | LocalStorageProvider, upload intents/finalize/signature checks; five-minute signed private downloads | Supabase adapter and antivirus NOT IMPLEMENTED; separate buckets/keys and storage policies unverified |
| Notifications | Durable in-app timeline and local EMAIL_SINK | External email sink/sender integration NOT IMPLEMENTED; verified sender/allowlist needed |
| Jobs | POST /api/dev/jobs in the Next process; pnpm jobs:dev polls loopback | Inngest/deployed scheduler and alerts NOT IMPLEMENTED; library dependency is not integration |
| Operators | /admin pages, app.user_roles grants, append-only app.audit_log with reasons, feature flags | Staff step-up, incident tooling, staging propagation/rehearsal unverified |
| Backup/rollback | Migration scripts and plan below | Backup provider/access/retention and restore/rollback/replay tooling absent; NOT_RUN |

Previews must have isolated DB/storage/keys and safe sinks. No preview may inherit production credentials. Until an isolated preview environment exists, do not deploy a write-enabled commerce preview. Environment labels do not establish isolation. These are target requirements, not configured infrastructure.

Configuration and real commands:

- `pnpm env:check local`, `pnpm env:check staging`, `pnpm env:check production` run `scripts/env-check.ts`; C4 tested local defaults and fail-closed missing production values. The script reads the supplied process environment, not proof of runtime/provider readiness. `pnpm release:check` checks fee constraints, client funding, dev guards and example secrets, then reports ledger gates; exit 0 does not mean G5/G6 passed.
- `APP_ENV`, `NODE_ENV`, `APP_BASE_URL`, `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `AUTH_MODE`, `DEV_SESSIONS`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are recognized. Deployed validation requires Supabase auth and DEV_SESSIONS=off; production rejects loopback DB, local auth and mock payments. Never put a server secret in NEXT_PUBLIC variables.
- `PAYMENT_MODE`, `PAYMENT_PROVIDER`, `LIVE_PAYMENTS_ENABLED`, `FEE_PAYER_POLICY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION` are configuration contracts, not implemented Stripe integration. Master `THIRD_PARTY_FEE_POLICY` maps to runtime `FEE_PAYER_POLICY` (CREATOR_AT_COST or PLATFORM_SUBSIDIZED). Nonzero `PLATFORM_FEE_BPS` is invalid. Missing policy/live key shapes reject a live configuration.
- Local knobs: `MOCK_PAYMENT_WEBHOOK_SECRET`, `MOCK_PROVIDER_FEE_BPS`, `CHECKOUT_HOLD_MINUTES` (default 15), `STORAGE_PROVIDER=local`, optional `STORAGE_SIGNING_SECRET` / `LOCAL_STORAGE_DIR`; `.env.example` is only a partial template. Deployed validation requires STORAGE_PROVIDER=supabase and rejects local signing/directory settings, but that adapter is **NOT IMPLEMENTED** and runtime storage fails closed.
- `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY`, email/allowlist and Arc settings are recognized preparedness fields; integration is **NOT IMPLEMENTED**. Do not claim email dispatch, chain finality or scheduling because validation accepts values.
- `pnpm db:start`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:test:prepare`, `pnpm dev`, `pnpm jobs:dev`, `pnpm typecheck`, `pnpm test:integration` exist. PostgreSQL cannot start inside Codex's managed runner; Claude runs DB suites/browser checks in her shell. `test:critical` lacks newer suites: use `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run` for full integration. Latest evidence is 184/184 across 17 files, including unit tests, tsc 0 at `3bddff9`; C3 reran none.
- Package scripts `test:e2e`, `test:contracts`, `smoke:staging`, `reconcile:dry-run` and configured lint are **NOT IMPLEMENTED**. C4 CI is authored; clean frozen install and hosted CI execution NOT_RUN. Do not substitute `POST /api/dev/jobs` for a dry run.

Migration and future deployment procedure — NOT_RUN in staging:

1. Engineering records the candidate commit and `drizzle/NNNN_*.sql` manifest, target identity, `public.schema_migrations`, feature flags and backup cutoff. Baseline evidence covers through migration 0007; Claude's 0008/P3 work is in progress and is not certified here.
2. In an authorized isolated target, supply its `DATABASE_MIGRATION_URL` securely and run existing `pnpm db:migrate`. The script sorts migration files, records each transaction in `public.schema_migrations` and skips applied entries. Never omit target configuration (local defaults exist), edit applied migrations or seed production. Deployment-wide runner serialization is the release owner's responsibility.
3. Run blank/upgrade/rerun migrations in isolated databases. W1-A proved blank/populated local upgrades; it did not prove old-app compatibility. Compare obligations in `app.orders`, `app.workload_claims`, `app.creator_workloads`, `app.provider_operations`, `app.ledger_entries`, `app.request_budget_reservations`, `app.storage_assets` and `app.outbox` before/after. Do not infer expand-contract compatibility: migration 0003 removed old pool counters.
4. Before any deployed app, implement the missing adapters/scheduler and choose hosting, health check and artifact rollback tooling. **No deployment, health/smoke CLI or rollback command is implemented here.** The operator must supply these concrete tools before executing this step; the plan does not authorize deployment.
5. After future deployment, smoke `/sign-in`, `/explore`, `/services/[id]`, `/orders/[orderId]`, `/requests/[id]`, upload/finalize/download routes and role-scoped `/admin` pages against sandbox fixtures. Use the deployed provider's own integration, not dev routes. Record actual browser/worker/permission results before enabling a feature.

Containment uses `/admin/flags` → `admin_set_flag` with a reason: CHECKOUT_CREATION_ENABLED, BIDDING_ENABLED and PAYOUT_CREATION_ENABLED stop new creation; webhooks/refunds/reconciliation stay running. LIVE_PAYMENTS_ENABLED requires the environment gate too; that gate is not launch approval. `/admin/cases` assigns/resolves cases; `/admin/operations` retries original provider operations; `/admin/audit` shows reasons. Roles come only from active `app.user_roles` grants. C6 verified a local role matrix and one 360px flag form; not staging latency or every populated dispute form.

Restore rehearsal (OPS-02) — BLOCKED environment, NOT_RUN procedure:

1. Infrastructure owner selects timestamped DB and storage snapshots and an isolated target; record backup cutoff, schema/version and start time. **Backup capture/restore tooling is NOT IMPLEMENTED in this repository.** Stop jobs and use safe sinks/no live credentials; creation kill switches alone do not stop refund/reconciliation effects.
2. On the restored target, read `public.schema_migrations`, core table counts, file hashes/references, immutable service/delivery versions, `app.audit_log` and financial event identities. Sum ledger integers per transaction/currency. `app.workload_counter_drift` must be empty (held = HELD+EXPIRY_RECONCILING, active = ACTIVE claims per creator); in-flight units may exceed a lowered limit.
3. Compare request budgets/counts to `app.request_budget_reservations`. Order triggers commit at funding and release on unpaid lapse/full refund; partial refunds stay committed. Pre-0007 requests lack budget-reservation backfill: document unresolved historical obligations, not zero-commitment claims.
4. Match provider effects after the backup cutoff against journals/inbox/outbox before replay. **reconcile:dry-run and isolated replay harness are NOT IMPLEMENTED**. The dev hook and admin retries are effectful. Mock provider memory cannot be restored from an app DB backup; do not use a fresh mock instance as proof of remote recovery.
5. Record measured RPO/RTO, conservation checks and unresolved cases. Proposed RPO ≤24h/RTO ≤4h are unmeasured targets; no restore pass follows from this plan.

Rollback rehearsal (OPS-03) — NOT_RUN:

1. Engineering tests previous/candidate app artifacts against the additive schema in isolation, using existing full suites and actual route smoke checks. Artifact selection/deployment rollback tooling must first be provided by the chosen hosting owner; it is **NOT IMPLEMENTED** here.
2. Preserve financial writes/schema, reconcile operations across the release interval and use a reviewed forward fix where the prior app is incompatible. Never reset financial state or restore an old DB over live effects.
3. Re-enable creation via `/admin/flags` only after reviewed invariants/provider facts and authorized target resumption. Read-only C3 source inspection found order-first worker paths under the aggregate → creator workload → order contract; W7-CAP reasons there is no cycle, but no recovery-time race test exists yet.

The [runbook index](runbooks/README.md) lists the nine accepted jobs and current unverified P3 tenth job from `runJobsOnce`; re-read after P3 integration. [Release gates](RELEASE_CHECKLIST.md): G0–G4 PARTIAL, G5–G7 BLOCKED. No staging, testnet, live payment, email or deployment was executed by C3.
