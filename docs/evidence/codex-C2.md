# C2 evidence — P1C documentation and dropped-provider cleanup

Date: 2026-09-13. Author: Codex (Astra), second engineer; Claude reviews/integrates. Working tree delivery, no commit. Scope: documentation only; platform fee always 0%.

## Files

Created:

- `docs/PAYMENT_READINESS.md`: eight readiness checks with BLOCKED/NOT_RUN, evidence needed and operator/engineering owner; local mock limits and live blockers.
- `docs/STAGING.md`: environment/config mapping, ordered migrations, OPS-02 restore and OPS-03 rollback plans; all staging execution NOT_RUN.
- `docs/RELEASE_CHECKLIST.md`: G0/G1/G2/G4 PARTIAL, G3 NOT_RUN, G5/G6/G7 BLOCKED; open operator decisions.
- `docs/runbooks/README.md`: index, actual five-job dev hook, safe usage limits and TODO operator tools.
- `docs/runbooks/01-buyer-charged-order-not-funded.md`
- `docs/runbooks/02-creator-approved-funds-not-arrived.md`
- `docs/runbooks/03-refund-pending-or-after-payout.md`
- `docs/runbooks/04-capacity-stuck-in-hold.md`
- `docs/runbooks/05-auction-ended-no-winner.md`
- `docs/runbooks/06-auto-accept-dispute-race.md`
- `docs/runbooks/07-webhook-or-job-outage.md`
- `docs/runbooks/08-crypto-wrong-chain-mixed-payout.md`
- `docs/runbooks/09-security-private-data-incident.md`
- `docs/runbooks/10-restore-and-rollback.md`
- `docs/evidence/codex-C2.md` (this report).

Changed only to remove dropped-provider notes: `README.md`, `docs/BUILD_STATUS.md`, `docs/HANDOFF.md`, `docs/evidence/p0-foundation.md`. README retains the no-live-credentials statement and production prerequisites. Other historical status claims were deliberately preserved for C3.

Deleted: `docs/MIRAI_PROVIDER.md`.

## Commands and results

All commands ran in the restricted local Codex workspace. No network, installs, database/jobs execution, test suites, build, external email, live payment or deployment was run. No git staging/commit/reset/stash/checkout command was run.

| Command / inspection | Result |
|---|---|
| `pwd`, `rg --files` with task filename filters; `cat AGENTS.md docs/COLLABORATION.md docs/BUILD_STATUS.md docs/HANDOFF.md docs/evidence/claude-db-integration.md` | Read ownership and baseline facts. |
| `cat docs/MASTER_PROMPT.md`; targeted Python heading extraction and `sed` section reads | Full-file output was truncated; targeted reads covered required §2, §8.1–8.2, §14.3–14.4, §16.4, §17.1, §19–21 and §24. |
| `cat` / `sed` / `rg` on README, foundation evidence, `.env.example`, `scripts/migrate.ts`, dev jobs/commands routes, jobs, funding, auctions and migration SQL | Read-only cross-check of real tools, env names, state handling and table names. Early speculative paths `src/modules/payments/runtime.ts`, `src/lib/env.ts`, `src/lib/config.ts` were absent (exit 2); actual files were located and read. Initial `rg --files` for the not-yet-created C2 docs also returned exit 2 as expected. |
| Python original-file snapshot to `/tmp/codex-C2-originals.json`; `apply_patch`; `python3 /tmp/codex-C2-write-runbooks.py`; targeted Python doc corrections | Created the documentation and performed the allowed removal-only changes. No repository code or other-owner path was written. |
| `python3 /tmp/codex-C2-check.py` | Exit 0: 14 operational documents; ten runbooks with required sections, real table references, TODO tools and forbidden actions; eight readiness rows/statuses/owners; exact gate statuses; valid local links; no trailing whitespace. Four existing docs matched removal-only transformations against the pre-edit snapshot; standalone provider doc absent. This is static documentation validation, not application acceptance. |
| `git diff --check`; `git diff --stat`; `git diff -- README.md docs/BUILD_STATUS.md docs/HANDOFF.md docs/evidence/p0-foundation.md`; `wc -l` on new operational docs | Exit 0. Reviewed the four narrow removals. Whole-tree diff/status also includes other engineers' concurrent code/UI/migration changes; those were not made, reverted or validated by C2. |
| `rg -n -i mirai README.md docs/BUILD_STATUS.md docs/HANDOFF.md docs/evidence/p0-foundation.md docs/PAYMENT_READINESS.md docs/STAGING.md docs/RELEASE_CHECKLIST.md docs/runbooks` | No hits; rg exit 1 (expected no-match result; wrapper asserted it). |
| `rg -n -i --hidden -g '!.git/**' -g '!node_modules/**' -g '!.next/**' mirai .` | Before this report: five matching lines remain in three out-of-scope files listed below, exit 0. This report also names the removed file and records search commands, so a later repository-wide search includes this audit record. No claim of zero repository-wide hits. |
| Final `python3 /tmp/codex-C2-check.py`, scoped `git diff --check`, Python evidence whitespace check, `rg -l -i --hidden -g '!.git/**' -g '!node_modules/**' -g '!.next/**' mirai .`, scoped `git status --short` | Exit 0: static checks passed; search returned only the three out-of-scope files plus this report; scoped status showed the expected created/changed/deleted C2 paths. |

The 83/83 DB/mock tests and webpack/typecheck results are cited from `docs/evidence/claude-db-integration.md`, not rerun by Codex. Sandbox/testnet/live, staging, UI and recovery rehearsals are not inferred from that local evidence.

## Requests for Claude

1. Review/integrate the allowed C2 paths and update the collaboration board. Remaining Mirai mentions are in `docs/COLLABORATION.md` (two lines), `docs/CLAUDE_REPORT.md` (one line) and `docs/evidence/claude-W1-proposal.md` (two lines). Remove/update them if desired within your ownership; C2 was explicitly forbidden to edit them.
2. Retain the funding clarification: ordinary checkout uses signed webhooks; missing-webhook recovery uses `applyFetchedProviderFact` with `source=provider_api_fetch` and `signature_verified=false`. An unqualified “only signed webhooks can fund” statement would contradict the implementation and cited lost-webhook test.
3. Recheck the runbooks against W1-A/W1-B after integration. Concurrent unverified work does not advance C2 release statuses. C3 should reconcile historical BUILD_STATUS/HANDOFF claims beyond the narrow removals requested here.
4. Track follow-ups already marked TODO: admin queue UI, scoped audited operator retry, deployed scheduler/alerts/kill switches, restore dry-run/replay, real provider integration and complete environment validation. Add missing `.env.example` variables in the assigned config task; map master `THIRD_PARTY_FEE_POLICY` to runtime `FEE_PAYER_POLICY`.

## Open questions

- Operator: entity/country, creator payout routes and approvals; fee payer, actual-cost cap/reserve; support/dispute owner; real policy details; infrastructure budget/access and launch authority remain open. None blocks this documentation delivery.
- Engineering: the dev hook currently checks `NODE_ENV`, `PAYMENT_MODE` and `LIVE_PAYMENTS_ENABLED`, not `APP_ENV`. Confirm deployed dev-route exclusion in environment/security work; documentation does not claim that protection is complete.
- No staging environment or provider keys exist. Who provisions them and supplies backup access/retention for measured OPS-02/03 rehearsals remains an operator/engineering follow-up.
