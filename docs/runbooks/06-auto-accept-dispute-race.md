# Auto-accept and dispute race

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: HIGH; finance operator owns the dispute; engineering owns locking/recovery.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

Acceptance/release and a revision, cancellation or dispute appear to overlap at the review deadline.

## How to detect (read-only)

Read `app.orders`, `app.deliveries`, `app.disputes` and `app.order_events` for latest delivery, review deadline and competing actions. Inspect `app.provider_operations`, `app.webhook_inbox`, `app.reconciliation_cases`, `app.ledger_transactions`/`app.ledger_entries`, `app.reservations` and `app.outbox`. ReviewHold, versioned delivery/consent and the full auto-accept workflow are pending lifecycle work; do not assume those fields/guards exist in this baseline.

## Safe steps

1. Preserve the timeline and original policy evidence. Establish whether a release was never submitted, submitted, unknown or confirmed.
2. Before submission, freeze/re-evaluate through a reviewed domain action under the order lock. TODO: operator freeze/review resolution and full auto-accept/ReviewHold implementation; do not emulate these with SQL.
3. After submission or an unknown result, retain factual state and lookup the original operation. Local mock reconciliation is available through the dev jobs hook only after evaluating all its effects. Do not call the hook merely to freeze an order; it can release other eligible orders.
4. If already released, use refund/recovery handling from runbook 03. TODO: admin queue UI and operator retry command. Record actor, reason and evidence; external notifications require actual operator authority.

## Expected result and invariant check

Expected: one serialized outcome and no duplicate transfer; existing local tests prove open disputes freeze release, not the complete auto-accept race. Check ledger conservation, platform fee 0%, capacity state and notices match the factual outcome. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never erase a dispute, alter a review deadline or claim a transfer was cancelled without provider evidence.
