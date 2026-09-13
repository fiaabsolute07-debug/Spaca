# HANDOFF

Read `docs/MASTER_PROMPT.md`, `docs/BUILD_STATUS.md`, `docs/COLLABORATION.md`, `docs/ACCEPTANCE.md` and AGENTS.md before changes. Continue this working tree without resets or overwriting another engineer. Platform fee always **0%**.

As of 2026-09-14: **Claude coordinates, integrates, runs DB suites/browser checks and commits. Codex is dispatched via `codex exec`**, implements assigned paths and writes evidence without committing. This user-directed model supersedes the old Codex-lead instructions. Claude is currently editing P3 auction code, migrations, tests and auction pages; C3 touched documentation only.

Verified baseline **3bddff9**: **184/184 tests, 17 files with DB suites enabled; tsc exit 0** ([C6 review](evidence/claude-review-C6.md) and referenced commit). The count includes unit/provider tests. PostgreSQL startup/migrations/seed and DB integration work in Claude's shell. Codex cannot start PostgreSQL because the managed runner rejects IPC; do not describe this as a global database blocker or infer current process health from historical tests.

| Phase | Handoff status |
|---|---|
| P0 / P1A | done-local |
| P1B | done-local with MockPaymentProvider; sandbox/live payments BLOCKED |
| P1C | docs done; staging/live BLOCKED |
| P2 | done-local; REQ-11 PARTIAL (comparison sort/filter missing) |
| P3 | IN_PROGRESS — Claude; no results inferred from concurrent files |
| P4–P6 | TODO |

Local adapters are `MockPaymentProvider`, `LocalStorageProvider` (signature checking, no antivirus, no Supabase adapter), in-app notifications/local email sink and in-process jobs through `POST /api/dev/jobs`. `pnpm jobs:dev` polls that route; no Inngest integration exists. `sandbox_pay` returns 403. Fund only from verified provider facts, including the existing reconciliation fetch path. Mock provider history disappears when Next restarts; provider recovery must use the original process and operation ID.

For Claude's local shell, existing scripts are `pnpm db:start`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:test:prepare`, `pnpm dev`, `pnpm jobs:dev`, `pnpm typecheck`, `pnpm test:integration` and `pnpm release:check`. Run fixtures only against allowlisted local/test targets. Full recorded suite command: `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run`. No command in this handoff was executed by C3. `test:critical` currently omits the newer order/admin/storage/request suites; use the full suite for integration until Claude expands it. `test:e2e`, `test:contracts`, `smoke:staging`, `reconcile:dry-run` and configured lint tooling are NOT IMPLEMENTED as package scripts.

Next work for Claude:

1. Integrate C3's allowed docs and [evidence](evidence/codex-C3.md), update your board, and reconcile the superseded AGENTS.md ownership text. Preserve concurrent P3 files.
2. Finish P3 and record its own acceptance evidence; then refresh auction/job documentation against that accepted commit. Keep P4–P6 TODO meanwhile.
3. Review pool → bucket → order consistency in order-first worker paths; add real hire-funding/expiry and cancellation/auto-release races. Close ORD-12 deadline amendments and ORD-14 chargeback gaps in planned follow-ups.
4. Dispatch C5 full browser/E2E checks: 360/768/1440, keyboard/long text, multi-hire and populated dispute/case forms. Existing 360px checks do not close OPS-07/G3. Add P2 comparison controls/analytics/export follow-ups.
5. Before staging: implement real provider/storage adapters and remote operation boundaries, deployed scheduler/alerts, safe reconcile dry-run, restore/rollback rehearsal and Supabase auth/storage tests. Credentials alone do not implement these integrations.

Operational truth: bucket counters derive from reservations; consumed work is never returned after refund. Orders become COMPLETED only after confirmed release, with ReviewHold stored separately while DELIVERED. Request budget reservations commit on funding, release on unpaid lapse/full refund; partial refunds retain commitments and pre-0007 requests need a backfill decision. Privileged roles come from active `app.user_roles` grants; `/admin` actions require reasons and append-only audits. See [runbooks](runbooks/README.md) for actual pages, commands and the nine-job accepted baseline and current unverified P3 addition.

G0–G4 remain PARTIAL; G5–G7 BLOCKED. No external email, deployment or live transaction is authorized by this handoff. Provider/identity/policy/reserve/infrastructure/launch decisions are in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
