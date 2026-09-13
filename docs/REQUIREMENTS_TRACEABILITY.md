# Requirements traceability (P0/P1 foundation)

| Requirement | Implementation | Test/evidence | Status |
| --- | --- | --- | --- |
| P0-01 audit without destroying work | `AGENTS.md`, `docs/adr/001-local-runtime.md` | `docs/evidence/p0-foundation.md` | PASS |
| P0-02 product decisions and zero fee | `docs/PRODUCT_SPEC.md`, `docs/MASTER_PROMPT.md` | This report; schema check on `platform_fee_minor` | PASS |
| P0-03 pinned runtime/dependencies | `package.json`, `pnpm-lock.yaml`, `.node-version` | TypeScript/build commands in evidence | PASS with lint follow-up |
| P0-04 typed Next shell and error states | `src/app/layout.tsx`, `src/app/globals.css`, `src/app/error.tsx`, `src/app/not-found.tsx` | `tsc`, `next build --webpack` | PASS |
| P0-05 auth and database boundary | `src/lib/auth.ts`, `src/lib/db.ts`, `src/app/api/auth/route.ts` | `tests/auth.test.ts`; DB startup blocker recorded | PARTIAL |
| P0-06 durable schema and grants | `drizzle/0001_marketplace.sql`, `scripts/migrate.ts` | Migration command is blocked by unavailable server | PARTIAL |
| P0-07 money, actor, idempotency, transitions | `src/app/api/commands/route.ts`, `src/lib/read-model.ts` | Provider/auth contract tests; DB integration pending | PARTIAL |
| P0-08 local fixtures and role shell | `scripts/seed.ts`, catch-all route role views | Seed requires DB; compile verified | PARTIAL |
| P0-09 outbox/notification seams | `app.outbox`, `app.provider_operations`, `src/modules/notifications/index.ts` | `docs/CLAUDE_REPORT.md` | PASS (seam) |
| P0-10 mock payment adapter | `src/modules/payments/providers.ts` | `tests/providers.test.ts` (43 tests) | PASS |
| P0-11 reproducible checks/docs | `scripts/*`, README, this evidence set | Typecheck, unit tests, webpack build | PASS with DB blocker |
| P1A Creator/service/capacity | creator profile, sample links, service CRUD/publish/pause, pool reservation | Requires DB integration/e2e | CODE COMPLETE, NOT ACCEPTED |
| P1B Book Now | `book`, `sandbox_pay`, `start`, `deliver`, `approve`, `revision`, `dispute`, `cancel`, `review` commands and UI | Requires DB integration/e2e | CODE COMPLETE, NOT ACCEPTED |
| P2 Requests | request/application/selection/offer commands and scoped UI | Requires DB integration/e2e | CODE COMPLETE, NOT ACCEPTED |
| P3 Auctions | auction/bid/buy-now/close commands and UI | Requires DB integration/e2e | CODE COMPLETE, NOT ACCEPTED |

The status is deliberately conservative: compiling code or a mock provider test does not prove a database transaction or a payment terminal state.
