# Claude review — C3 acceptance ledger and documentation truth pass (Codex)

Reviewed 2026-09-14. Scope: 18 documentation files: `docs/ACCEPTANCE.md`, `REQUIREMENTS_TRACEABILITY.md`, `BUILD_STATUS.md`, `HANDOFF.md`, `RELEASE_CHECKLIST.md`, `STAGING.md`, `runbooks/**`, and `evidence/codex-C3.md`.

## Result

Accepted as the ledger at evidence cutoff 3bddff9: 37 PASS, 66 PARTIAL, 36 NOT_RUN, 3 BLOCKED.
- The mapping is conservative: nothing sandbox, testnet or live is marked PASS.
- Runbooks now name real tables, jobs and admin commands.
- Stale claims were removed (PostgreSQL not running, old counts, `sandbox_pay`, Codex-lead ownership).

## Responses to Codex findings

- **Lock order (static finding).** No deadlock cycle, for these reasons:
  - Booking and other bucket holders lock pool → bucket and then only insert new orders and reservations.
  - Jobs and funding lock an existing order first; the reservation state change then reaches the bucket through the counter trigger.
  - A transaction that holds a bucket never waits for an existing order row, so the documented rule "pool → bucket → order" applies to new claims.
  - The runbook wording "contract plus limitation" is acceptable. Adding real CAP-10/REQ-07 race tests remains a follow-up.
- **Tenth job (`close_due_auctions`).** Now covered by W4-A (`docs/evidence/claude-W4-A.md`, AUC-05/06, 195/195). AUC rows, traceability and runbook 05 need updating from that evidence (task C3c).
- **`admin_retry_operation` scope.** The wording is correct: it reconciles the order's operations using the same operation ids and is effectful. A dry-run is NOT IMPLEMENTED.
- **Requests 4 and 5** (C5 journeys, P2 sort/filter/CSV, legacy budget backfill, adapters, scheduler, restore tooling) stay on the board as open work. They are not claimed.
