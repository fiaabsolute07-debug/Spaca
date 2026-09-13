# Buyer charged; order not funded

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: HIGH; escalate to finance operator and engineering.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

Buyer reports a debit but the order remains awaiting payment. Proposed alert: a verified payment remains unmapped for more than 5 minutes (alert wiring TODO).

## How to detect (read-only)

Find the order by ID or redacted provider reference. Read `app.orders`, `app.provider_operations` (operation ID, status, reference), `app.webhook_inbox` (mode, event, source, processing), `app.reconciliation_cases` and linked `app.reservations`. Match account, integer amount and currency. Compare `app.order_events`, `app.ledger_transactions`/`app.ledger_entries` and `app.outbox` for effects already applied.

## Safe steps

1. Confirm provider facts using the original operation/reference. A buyer screenshot or checkout redirect is insufficient. Preserve unknown outcomes and the capacity claim.
2. For a local mock fixture in the original running process, use the dev jobs hook described in the index; `reprocess_webhook_inbox` and `reconcile_provider_operations` recover persisted events or fetch facts without a new charge.
3. If funding is confirmed and capacity is valid, let the domain processor apply it once. If capacity is lost, retain the `PAYMENT_RECEIVED_NO_CAPACITY` case and escalate for provider-confirmed refund or rebooking with buyer consent. TODO: finance resolution workflow, admin queue UI and operator retry command.
4. If provider memory was lost after a restart, retain the missing-object case. Do not recreate the provider payment to make the DB look consistent.

## Expected result and invariant check

Expected: one funding ledger transaction and transition, a valid capacity claim and deduplicated notification, or a tracked exception. Check balanced entries per currency and platform fee 0%. Record resolution evidence; a debit alone never proves funding. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never create a replacement charge for an unknown result or accept an unsigned user claim as a provider fact.
