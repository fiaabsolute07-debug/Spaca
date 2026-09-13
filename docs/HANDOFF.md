# HANDOFF

Read `docs/MASTER_PROMPT.md`, `docs/BUILD_STATUS.md`, `docs/COLLABORATION.md`, `docs/ACCEPTANCE.md`, and `AGENTS.md` before changing files. Continue this repository; do not reset or initialize a second project.

## Claude → Codex update (2026-09-13, user-approved)

Claude ran PostgreSQL in the user's normal macOS shell. It added DB-backed integration tests and replaced client-side funding with provider-webhook funding. Start with `docs/CLAUDE_REPORT.md` ("Phase 2") and `docs/evidence/claude-db-integration.md`.

- **DB works outside the Codex runner.** Run `tsx scripts/postgres.ts start` (TCP-only fix applied), then `tsx scripts/migrate.ts` and `tsx scripts/seed.ts`; all pass. A Postgres process may still be running on `127.0.0.1:55432`. Stop it with `tsx scripts/postgres.ts stop`.
- **Gates (after phase 3):**
  - `tsx scripts/migrate.ts` applies `0002_notifications.sql`
  - `tsc` exit 0
  - `RUN_DB_INTEGRATION=1 vitest run` → 83/83 (twice)
  - `vitest run` without the flag → 49 passed, 34 skipped
  - `next build --webpack` passes
- **Phase 3 added:**
  - durable jobs in `src/modules/jobs` (hold expiry, inbox reprocess, provider reconciliation, settlement release, outbox → notifications), run locally via `POST /api/dev/jobs`
  - `app.notifications` in-app timeline and local email sink
  - automatic full refund request when cancelling a funded order
- **Fixed in lead-owned files** (review the diff):
  - `sandbox_pay` mark-paid removed (403)
  - idempotency advisory lock
  - `close_auction` `FOR UPDATE` on an outer join
  - anonymous request/auction pages crashing on `uuid = ''`
  - refund no longer marks REFUNDED without the provider
- **Next for Codex:**
  1. Review and own these changes.
  2. Move TEST_PLAN cases 1–7 in `docs/ACCEPTANCE.md` from NOT_RUN using the evidence file.
  3. Capture UI evidence.
  4. Wire a scheduler (Inngest/cron) to `src/modules/jobs`.
  5. Add dispute/finance resolution and an admin queue for `reconciliation_cases`.
  6. Split provider calls out of DB transactions before any real adapter.
  7. Remove the stale Mirai notes (the user dropped Mirai).

## Current state

- P0 code foundation is in place: Next shell, strict TypeScript, auth route, read models, command route, durable migration, seed fixtures, payment/notification seams, and shared UI.
- Direct checks pass: `tsc --noEmit -p tsconfig.json --incremental false`; `vitest run` (48 tests); webpack production build with placeholder env values.
- PostgreSQL is **not running** in this managed runner. `scripts/postgres.ts start` is blocked by denied SysV `shmget` during embedded `initdb`, so migrations/seed/integration tests are pending. Do not report sandbox transaction PASS until those commands run.
- Turbopack is blocked by child-process port binding; use `next build --webpack` for this runner's compile evidence.
- No live payment, Supabase, email, storage, RPC, or deployment credentials are available. Never invent them.

## Next concrete work

1. Use a normal local/Docker/Supabase PostgreSQL runtime and run `db:start` (or set `DATABASE_MIGRATION_URL`/`DATABASE_URL`), `db:migrate`, and `db:seed`.
2. Add database-backed integration tests for authorization, capacity race, idempotency, order lifecycle, requests, and auctions from `docs/TEST_PLAN.md`.
3. Capture redacted UI evidence at 360/768/1440px, update `docs/ACCEPTANCE.md`, then proceed with the later master phases.

Mirai API details are in `docs/evidence/p0-foundation.md`; no secret is persisted. A new CLI process may be configured with Mirai's documented Responses endpoint, but the current Codex task cannot change provider mid-run.
