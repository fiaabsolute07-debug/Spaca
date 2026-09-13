# Creator approved; funds not arrived

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: HIGH; escalate to finance operator; engineering handles journal/job defects.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

Buyer accepted the work, but the creator sees no funds. Proposed alert: settlement unknown for more than 15 minutes (alert wiring TODO).

## How to detect (read-only)

Read `app.orders` payment/settlement states separately from its lifecycle, then `app.provider_operations`, `app.webhook_inbox`, `app.reconciliation_cases` and `app.order_events`. Check `app.ledger_transactions`/`app.ledger_entries`, `app.reservations` and `app.outbox`. Approval, settlement release, provider transfer and bank payout are different milestones; the local mock does not prove bank arrival.

## Safe steps

1. Check actual provider cost, payout capability, destination snapshot, available funds and reserve before any retry. Missing capability/cost evidence requires operator action; do not substitute an estimate.
2. Lookup an UNKNOWN release using its existing operation/reference. In the local mock process, `reconcile_provider_operations` and `release_ready_settlements` are available through the dev jobs hook. Let their locked eligibility checks decide whether release can run.
3. The cited local implementation releases eligible COMPLETED orders with settlement READY; APPROVED→COMPLETED lifecycle changes are separate work. Do not manually advance states to satisfy the worker.
4. If transfer is confirmed but bank payout failed, investigate the payout account with the provider; do not transfer the order entitlement again. TODO: bank payout integration, admin queue UI and operator retry command.

## Expected result and invariant check

Expected: one confirmed release or a retained actionable case. Verify release ledger conservation, creator net based on the chosen fee policy, platform revenue 0, no duplicate payout notification and no release during an open dispute. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never change an unverified payout destination or treat a transfer receipt as bank payout confirmation.
