# HANDOFF

Read `docs/MASTER_PROMPT.md`, `docs/BUILD_STATUS.md`, `docs/COLLABORATION.md`, `docs/ACCEPTANCE.md` and AGENTS.md before changes. Continue this working tree without resets or overwriting another engineer. Platform fee always **0%**.

As of 2026-09-14: **Claude coordinates, integrates, runs DB suites/browser checks and commits. Codex is dispatched via `codex exec`**, implements assigned paths and writes evidence without committing. AGENTS.md now matches this model. Claude is currently editing P4 crypto, payments, migrations, integration tests, API and order pages; C3c/C5 stay in their assigned docs and E2E paths.

Verified baseline **94792af**: **206/206 tests, 20 files with DB suites enabled; tsc exit 0** ([W5-C1](evidence/claude-W5-C1.md)); Playwright E2E **14/14** ([C5 review](evidence/claude-review-C5.md)). The count includes unit/provider tests. PostgreSQL startup/migrations/seed and DB integration work in Claude's shell. Codex cannot start PostgreSQL because the managed runner rejects IPC; do not describe this as a global database blocker or infer current process health from historical tests.

| Phase | Handoff status |
|---|---|
| P0 / P1A | done-local |
| P1B | done-local with MockPaymentProvider; sandbox/live payments BLOCKED |
| P1C | docs done; staging/live BLOCKED |
| P2 | done-local; REQ-11 PARTIAL (comparison sort/filter missing) |
| P3 | done-local; AUC-01..14 PASS local-db+mock; payout readiness, metrics and E2E execution remain |
| P4 | IN_PROGRESS — Claude; no results inferred from concurrent files |
| P5–P6 | TODO |

Local adapters are `MockPaymentProvider`, `LocalStorageProvider` (signature checking, no antivirus, no Supabase adapter), in-app notifications/local email sink and in-process jobs through `POST /api/dev/jobs`. `pnpm jobs:dev` polls that route; no Inngest integration exists. `sandbox_pay` returns 403. Fund only from verified provider facts, including the existing reconciliation fetch path. Mock provider history disappears when Next restarts; provider recovery must use the original process and operation ID.

For Claude's local shell, existing scripts are `pnpm db:start`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:test:prepare`, `pnpm dev`, `pnpm jobs:dev`, `pnpm typecheck`, `pnpm test:integration` and `pnpm release:check`. Run fixtures only against allowlisted local/test targets. Full recorded suite command: `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run`. C3c/C5 did not run DB suites, jobs or the app; exact static verification is in [C5 evidence](evidence/codex-C5.md). `test:critical` currently omits the newer order/admin/storage/request suites; use the full suite for integration until Claude expands it. `test:e2e`, `test:contracts`, `smoke:staging`, `reconcile:dry-run` and configured lint tooling are NOT IMPLEMENTED as package scripts.

Next work for Claude:

1. Review and integrate [C3c evidence](evidence/codex-C3c.md) and [C5 evidence](evidence/codex-C5.md), then update the collaboration board and commit only assigned paths. The ledger now totals **51 PASS, 55 PARTIAL, 33 NOT_RUN, 3 BLOCKED** across 142 rows.
2. P4 W5-C1 (local devnet crypto checkout) is done; continue with W5-C2 pools/allocations/entitlements. Testnet and contracts stay BLOCKED/NOT_RUN. P5–P6 remain TODO. P3 local evidence is `90004fd`; implement seller payout readiness and P3-07 bidder/uplift metrics as follow-ups.
3. Pool → bucket → order review is accepted in [C3 review](evidence/claude-review-C3.md). Add real hire-funding/expiry and cancellation/auto-release races; close ORD-12 deadline amendments and ORD-14 chargeback gaps.
4. Add package script `"test:e2e": "playwright test"`. Start Next dev on 3100 against a seeded local mock DB with system Chrome, then run C5 and record results/screenshots. Authoring and discovery do not close OPS-07/G3; keyboard/long-text, multi-hire completion, auction close/reconnect and populated case journeys need further coverage. Add P2 comparison controls/analytics/export follow-ups.
5. Before staging: implement real provider/storage adapters and remote operation boundaries, deployed scheduler/alerts, safe reconcile dry-run, restore/rollback rehearsal and Supabase auth/storage tests. Credentials alone do not implement these integrations.

Operational truth: bucket counters derive from reservations; consumed work is never returned after refund. Orders become COMPLETED only after confirmed release, with ReviewHold stored separately while DELIVERED. Request budget reservations commit on funding, release on unpaid lapse/full refund; partial refunds retain commitments and pre-0007 requests need a backfill decision. Privileged roles come from active `app.user_roles` grants; `/admin` actions require reasons and append-only audits. See [runbooks](runbooks/README.md) for actual pages, commands and the ten-job local inventory, including verified `close_due_auctions` (AUC-05/06).

G0–G4 remain PARTIAL; G5–G7 BLOCKED. No external email, deployment or live transaction is authorized by this handoff. Provider/identity/policy/reserve/infrastructure/launch decisions are in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
