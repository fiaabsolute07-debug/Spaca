# BUILD_STATUS

Updated 2026-09-15, end of session. Latest commit `d898592`. Claude builds UI and backend and is the only committer. The platform fee is enforced at 0 in code; the fee model is undecided.

Everything below is LOCAL: embedded PostgreSQL, mock payment provider, local storage, local devnet and anvil. Nothing is deployed, and no testnet or live money is involved.

| Phase | Status | Scope / limits |
|---|---|---|
| P0 | done-local | Foundation, local auth and fixtures, PostgreSQL, scripts. Clean-clone and frozen CI not run (FND-01/02 PARTIAL). No ESLint config, because typescript-eslint does not support TypeScript 7. |
| P1A | done-local | Versioned supply, immutable sold terms, pause (order limit removed 2026-09-15), profile photo, separate buyer and creator accounts. |
| P1B | done-local, mock provider | Funding, lifecycle, delivery and revision, auto-accept, cancellation, deadline amendments, card disputes, refunds after release, late costs, order receipt. Sandbox/live payments BLOCKED. |
| P1C | docs + local rehearsal | Readiness docs, runbooks, operator console, local restore rehearsal. Staging/live BLOCKED. |
| P2 | done-local | Requests with private quotes, budget holds, multi-hire, campaign images, buyer comparison with sort, filter and CSV. |
| P3 | done-local, paused | Auctions work locally; further auction work is paused by the user. AUC-01 payout readiness PARTIAL. |
| P4 | LOCAL devnet + anvil | Crypto checkout, campaign pools, `SpacaEscrow` (model A) with payout outbox. Arc testnet deployment BLOCKED on faucet funds. |
| P5 | done-local | Discovery backend, Explore master-detail UI, benchmark. |
| P6 | done-local | PUBLISH with linked accounts and reports, DIGITAL products, bank transfer funding (mock provider). ACCESS scheduling removed by product decision. |

[Acceptance](ACCEPTANCE.md): **116 PASS, 19 PARTIAL, 0 NOT_RUN, 2 BLOCKED, 5 REMOVED (142 rows)**. Gates G0–G4 PARTIAL; G5–G7 BLOCKED.

## Latest verified results (2026-09-15, tree of `d898592`)
- `tsc --noEmit`: exit 0.
- `RUN_DB_INTEGRATION=1 vitest run`: 316 passed, 3 skipped (38 files). The 3 skipped are the anvil suite, which needs `RUN_ANVIL=1`.
- `RUN_ANVIL=1` `escrow.anvil.test.ts`: 3/3. `forge test`: 17/17.
- Release check: every item PASS. Discovery benchmark: every latency and plan check passes. Secret scan: no findings.
- Full Playwright suite: 37/37 in 7.1 minutes.
- Restore rehearsal: obligations conserved, 8 invariants with 0 violations, webhook replay a no-op ([audit](evidence/claude-AUDIT-2026-09-15.md)).

## UI state (2026-09-15)
- Signed-in pages share one workspace sidebar with back links. The profile is its own area, opened from the header avatar.
- Header links mark Explore, Campaigns and Auctions; a tab strip was removed at the user's request.
- Color is used only on primary actions, the current location and campaign categories.
- Post a brief uses category cards and chips.

## Local adapters and known limits
- `MockPaymentProvider` keeps its state in the Next process. Restarting the dev server loses provider history, and approved orders then open `PROVIDER_OBJECT_MISSING` cases.
- `LocalStorageProvider` checks file signatures only: no antivirus and no Supabase adapter. Campaign images are neither moderated nor resized.
- Jobs run in-process through `POST /api/dev/jobs`. There is no deployed scheduler, and email is an in-app/outbox sink.
- PARTIAL (19): FND-01, FND-02, SEC-11, ORD-07, ORD-11, ORD-13, ORD-16, PAY-01, PAY-02, PAY-03, PAY-04, PAY-12, PAY-20, AUC-01, CRY-01, OPS-03, OPS-05, OPS-06, OPS-08.
- BLOCKED: SEC-03 (Supabase Data API), PAY-19 (bank payouts).
- REMOVED: CAP-01, CAP-02, CAP-07, CAP-11, XPL-03.
- Needs from outside:
  - Arc testnet faucet funds for deployer `0x7758186cD9FE0156fd5F631e5c944445D9c1e97F`
  - Supabase/staging
  - payment and payout provider accounts
  - a platform fee decision
  - legal review
  - an independent contract audit before mainnet
