# Buyer charged; order not funded

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Baseline `3bddff9`; concurrent P3 changes are unaccepted. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: finance + engineering; HIGH severity. Symptom: a debit is reported while `app.orders` is AWAITING_PAYMENT.

1. Open `/admin/orders/[orderId]` and `/admin/operations`; correlate `app.provider_operations` with `app.webhook_inbox`, `app.order_events`, `app.reservations` and `app.reconciliation_cases`. Check original reference, account, amount and currency; a screenshot/return URL is not funding evidence.
2. Finance/admin may submit `admin_retry_operation` from `/admin/operations` with the existing `operation_id` and reason. This performs lookup-first reconciliation for the associated order, potentially including its other operations; it is not a single-operation dry run. Inspect the returned outcomes and `/admin/audit`.
3. For an isolated local fixture in the original Next process, the shared `POST /api/dev/jobs` hook reprocesses persisted inbox events and fetches missing mock provider facts. Funding may come from a verified webhook or `provider_api_fetch`; the latter deliberately has `signature_verified=false`.
4. UNKNOWN/captured-before-cancel keeps a RECONCILING claim. If already released, retain the `LATE_FUNDING` case; assign via `admin_assign_case` on `/admin/cases`. Automatic refund/rebook consent for a resold slot is not proved; escalate instead of forcing funding. After a Next restart, `PROVIDER_OBJECT_MISSING` cannot be repaired by inventing a payment.

Verify: one funding effect in `app.ledger_transactions`/`app.ledger_entries`, one transition/outbox semantic effect, and valid bucket commitment; otherwise keep the case open. Alerts for delayed funding and real-provider diagnosis tooling are NOT IMPLEMENTED.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
