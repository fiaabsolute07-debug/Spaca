# Evidence — C4 scripts + CI (Codex started, Claude completed)

Date: 2026-09-13.

**Why Claude completed it.** Codex (Astra) implemented `scripts/lib/env-rules.ts`, `scripts/env-check.ts`, `scripts/lib/release-rules.ts` and `scripts/release-check.ts`, then stopped with "You've hit your usage limit … try again at 11:24 PM" before tests, CI and evidence. Per the user's instruction ("khi codex hết quota thì cứ tiếp tục công việc của bạn"), Claude reviewed and completed the task.

## Review of the Codex part

- **`env-rules.ts`: kept unchanged.**
  - A pure `checkEnvironment(env, target)` validates local/staging/production.
  - Fail-closed rules: remote DB in production, `AUTH_MODE=supabase`, `DEV_SESSIONS=off`, no mock payments outside local, `PLATFORM_FEE_BPS` absent or 0, live payments require `FEE_PAYER_POLICY` plus live Stripe key shapes.
  - It prints only presence and host class, never values.
- **`release-rules.ts`: migration fee check kept; `import ts from 'typescript'` removed.**
  - The Codex version used the TypeScript compiler JS API (`ts.createSourceFile`, `ts.SyntaxKind`), which **TypeScript 7 (native) does not ship** (`tsc` failed with TS2694/TS2339).
  - Claude rewrote `checkClientFunding` and `checkDevRouteGuards` as comment/string-aware lexical scanners.
  - The first lexical version flagged two SQL predicates as writes (`o.payment_status='SUCCEEDED'` in a WHERE fragment; `case when payment_status='SUCCEEDED'`). Code-level patterns now run on string-blanked source, and SQL is judged only by `SET`/`INSERT` parsing.

## Added by Claude

| File | Purpose |
|---|---|
| `tests/unit/release-rules.test.ts` | 9 tests. The fee check fails on a nonzero/missing CHECK, a dropped fee constraint or a dropped column, and ignores comments. Client funding fails on `markPaid`, TS object writes, SQL `SET status='FUNDED'` and `INSERT … 'FUNDED'`, and passes predicates, CASE comparisons, comments and `funding.ts`. Dev routes fail on missing, late, commented or non-rejecting guards and re-exports. The secret scan never echoes the secret. Gate parsing reads the status column only. |
| `tests/unit/env-rules.test.ts` | 6 tests: local defaults; complete production passes; production refuses loopback DB, mock, dev sessions, local auth and nonzero fee; live requires fee policy and live keys (a test key is invalid in live); staging refuses mock; the formatted report contains no secret, host or key value. |
| `.github/workflows/ci.yml` | `permissions: contents: read`, a postgres:17 service, pnpm 11.19.0 + `.node-version`, frozen install. Steps: typecheck, `release:check`, `test:unit`, migrate twice (idempotent) + seed, `test:integration`, `next build --webpack`. No secrets, no deploy. |
| `scripts/jobs-dev.ts` | `jobs:dev` loop POSTing `/api/dev/jobs` on a loopback dev server (refuses non-loopback). |
| `package.json` scripts | `env:check`, `release:check`, `jobs:dev`, `db:test:prepare`, `test:unit`, `test:integration` (sets `RUN_DB_INTEGRATION=1`), `test:critical` (commands, payments, supply, jobs + provider contract), `test:security` (origin, fixtures guard, release/env rules, auth + dev session), `typecheck` |
| `pnpm-workspace.yaml` | `allowBuilds` held literal placeholders ("set this to true or false") that a frozen CI install cannot use. Set: `@embedded-postgres/darwin-arm64` true, `esbuild` true, `unrs-resolver` true, `protobufjs` false. |

## Commands and results (user's macOS shell)

| Command | Result |
|---|---|
| `tsx scripts/release-check.ts` | `PASS` ×4 (fee zero; no client mark-paid; dev route guards; example secrets), then INFO gates `NOT_RUN G3`, `BLOCKED G5/G6/G7`; exit 0 |
| `tsx scripts/env-check.ts local` | all OK, exit 0 |
| `APP_ENV=production tsx scripts/env-check.ts production` | MISSING rows (NODE_ENV, APP_BASE_URL, DATABASE_URL, DATABASE_MIGRATION_URL, AUTH_MODE, Supabase URL/key, DEV_SESSIONS, …); exit 1 as intended |
| `vitest run tests/unit/release-rules.test.ts tests/unit/env-rules.test.ts` | 15/15 |
| `vitest run tests/unit tests/providers.test.ts tests/auth.test.ts` (what `test:unit` runs) | 7 files, 81/81 |
| `RUN_DB_INTEGRATION=1 vitest run tests/integration` (what `test:integration` runs) | 5 files, 51/51 against `creator_marketplace_test` |
| `tsc --noEmit -p tsconfig.json --incremental false` | exit 0 |
| `ci.yml` parsed with the repo's `yaml@2.9.1` | 1 job `checks`, 10 steps |

## Not verified

- **The GitHub Actions workflow has not run** (no remote, no network). Status: authored, NOT_RUN.
- **`pnpm install --frozen-lockfile`** was not run: installs are not allowed here and the lockfile predates the `allowBuilds` fix. The first CI run may report lockfile drift; if so, regenerate the lockfile in a networked environment.
- **`reconcile:dry-run`** (§17.4) is not implemented yet. The reconciliation job still performs provider lookups; a read-only dry-run mode is planned with W2-B operator tooling.
- **`lint`** has no ESLint config yet.
