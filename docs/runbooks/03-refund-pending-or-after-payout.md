# Refund pending or requested after payout

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: HIGH; finance operator owns refund/deficit decisions; engineering owns reconciliation.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

Refund remains pending, or a refund is requested after creator settlement has been released.

## How to detect (read-only)

Locate the order and refund operation in `app.provider_operations`; read `app.webhook_inbox`, `app.reconciliation_cases` and `app.order_events`. Use `app.ledger_transactions`/`app.ledger_entries` to compare funded principal, prior refunds, release and pending outflows. Check `app.reservations` and `app.outbox` for associated capacity and notices. Do not infer refundable funds from the order label alone.

## Safe steps

1. Confirm refundable principal and already reserved/pending outflows. Lookup the existing refund before considering a retry; preserve its operation ID and request body.
2. For an existing local mock refund, use the dev jobs hook: `reconcile_provider_operations` plus `reprocess_webhook_inbox` can recover provider confirmation. Cancellation of a funded local order requests a full refund; REFUNDED requires a provider fact.
3. After payout, charge refund and transfer reversal/recovery are separate operations. Escalate a deficit if creator funds are unavailable. TODO: post-payout recovery/partial refund workflow, admin queue UI and operator retry command.
4. Honor the agreed full principal refund. Unrecovered vendor cost belongs to the approved reserve/policy; do not reduce the promised refund or charge unrelated orders.

## Expected result and invariant check

Expected: exactly one provider-confirmed refund and corresponding ledger/event/notification, or an unresolved case with owner. Verify refund does not exceed principal, per-currency ledger conservation and platform fee 0%. Pending is not refunded. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never issue a duplicate refund from a provider dashboard or hide a deficit by deducting another order.
