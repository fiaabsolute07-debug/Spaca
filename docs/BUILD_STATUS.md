# BUILD_STATUS

> **Update 2026-09-13 (Claude, user-approved):** the PostgreSQL IPC blocker is specific to the Codex managed runner.
> - In the user's normal macOS shell, PostgreSQL 18.4 starts and `db:migrate`/`db:seed` pass (idempotent).
> - DB-backed integration suites for TEST_PLAN 1–7, the payment adapter and durable jobs pass: `RUN_DB_INTEGRATION=1 vitest run` → 83/83. `tsc` and `next build --webpack` also pass.
> - Funding is now provider-webhook driven (no client mark-paid).
> - Hold expiry, reconciliation, inbox reprocess, settlement release and outbox → in-app notifications exist as jobs, but no scheduler is wired yet.
> - Evidence: `docs/evidence/claude-db-integration.md`. Acceptance rows are not yet updated by the lead.
> - UI screenshots, Supabase, Stripe sandbox, a deployed scheduler and dispute resolution remain NOT RUN.

Updated: 2026-09-13. Current phase: **P0 foundation — implementation complete, acceptance PARTIAL/BLOCKED by local PostgreSQL IPC**.

The repository was empty at audit time. The master prompt was retained in `docs/MASTER_PROMPT.md`, and the product/requirements/test documents now live beside it. Platform fee is **0%** in policy, schema checks, UI copy, and command calculations. No live accounts, payment credentials, Supabase project, or deployment target are configured.

## Verified

- Strict TypeScript: PASS (direct `tsc`, exit 0).
- Unit and payment contract tests: PASS (48 tests across auth and provider suites).
- Webpack production build: PASS with placeholder build-time environment values; all app and API routes compile as dynamic routes.
- UI: public marketplace, creator profile/service, buyer booking, order workspace, delivery/revision/dispute/review, request/application, auction/bid, auth and policy pages are implemented.
- Backend: same-origin mutation guard, actor/role checks, idempotency, money-in-minor-units, row locks, capacity reservation, order events, outbox/ledger/provider-operation tables, and local seed fixtures are implemented.
- Claude-owned provider/notification modules and tests are recorded in `docs/CLAUDE_REPORT.md`.

## Not accepted yet

- `db:start` cannot initialize the embedded PostgreSQL binary in this managed runner. PostgreSQL's bootstrap probe falls back to SysV shared memory and the sandbox rejects `shmget(... size=56)` with `Operation not permitted`, even with mmap flags. Therefore `db:migrate`, `db:seed`, and database-backed integration/e2e acceptance are **BLOCKED**, and no transaction is claimed as executed.
- Turbopack's default build is blocked by the runner's child-process port binding. The webpack build is the verified compile gate for this environment.
- Live payment, notification, storage, production auth, observability, deployment, and real buyer evidence remain future gates.

## Next action

Run the existing `scripts/postgres.ts`, `scripts/migrate.ts`, and `scripts/seed.ts` in a normal local/Docker/Supabase environment with IPC enabled. Then execute the integration cases in `docs/TEST_PLAN.md`, attach redacted screenshots/receipts under `docs/evidence/`, and move P0 to PASS before calling P1A/P1B/P1C accepted.
