# Webhook or job outage

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: HIGH; engineering owns recovery; finance operator owns unresolved monetary cases.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

Payments stop progressing, webhook errors rise, jobs stop or notification backlog grows. Proposed alerts include repeated signature failures, payment unmapped >5 minutes, unknown settlement >15 minutes and DB pool saturation; alert wiring is TODO.

## How to detect (read-only)

Check ingress/job logs and correlate request → order → operation → provider reference → inbox/outbox IDs. Read `app.webhook_inbox` age, attempts, signature/source and processed_at; `app.provider_operations` status/updated_at; `app.outbox` status/attempts/available_at; and `app.reconciliation_cases` age/owner/next_action. Compare `app.reservations`, `app.order_events` and `app.ledger_transactions`/`app.ledger_entries` for stalled or duplicate effects.

## Safe steps

1. Verify environment, endpoint and signing configuration without printing keys. Retain invalid events as incident evidence outside the trusted inbox; never disable signature checks.
2. Local tool: `POST /api/dev/jobs` runs `reprocess_webhook_inbox`, `reconcile_provider_operations`, `expire_checkout_holds`, `release_ready_settlements`, then `dispatch_notification_outbox`. Use the original running mock process; the endpoint executes all five, has no per-order selector and is not a dry run.
3. Check returned job outcomes and database effects. Inbox defaults require age >30 seconds; reconciliation >60 seconds. Bounded batches may leave work. Outbox retries stop at five attempts; poison payloads are parked. Fix the cause before retrying; do not reset attempts by hand.
4. If funds cannot be reconciled, contain new checkout/bid/payout creation while preserving safe webhook/reconciliation. TODO: deployed scheduler, alert wiring, audited kill switches, admin queue UI and operator retry command.
5. Reconcile the entire outage interval, including missing events via provider lookup, not just the newest inbox entries. Local API-fetched facts are recorded with source=provider_api_fetch and are not signed webhook deliveries.

## Expected result and invariant check

Expected: backlog ages fall, unknown operations resolve or remain owned cases, holds/release resume safely and sink notifications deduplicate. Verify per-currency ledger balance, one effect per operation, capacity consistency and platform fee 0%. This is local tooling, not deployed recovery evidence. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never disable signing, fabricate provider facts, delete inbox/journal/audit rows or send live email to clear the queue.
