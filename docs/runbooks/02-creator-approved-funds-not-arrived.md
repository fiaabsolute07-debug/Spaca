# Creator approved; funds not arrived

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Procedure baseline `3bddff9`; P3 auction/job update verified at `90004fd` (see the index). Concurrent P4 changes are not verified here. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: finance + engineering; HIGH severity. Inspect lifecycle and money independently on `/admin/orders/[orderId]`.

1. Read `app.orders` (APPROVED, payment SUCCEEDED, settlement READY), `app.provider_operations`, `app.disputes`, `app.reconciliation_cases` and `app.ledger_entries`. Check `/admin/flags`: `PAYOUT_CREATION_ENABLED=false` holds new releases.
2. Eligible `release_ready_settlements` runs through the shared local hook; it releases APPROVED orders, or a CANCELLED order's agreed unrefunded remainder. **Confirmed `release.succeeded` moves APPROVED → COMPLETED**. Approval alone never proves transfer or bank arrival.
3. Finance/admin retries UNKNOWN operations on `/admin/operations` using `admin_retry_operation` and the same operation ID/reason. Missing payout capability stays READY with a case; use `/admin/cases` to assign it. Respect the provider-cost policy: CREATOR_AT_COST deducts actual cost without markup; PLATFORM_SUBSIDIZED preserves gross entitlement.
4. Confirm `SETTLEMENT_RELEASED` in `app.order_events`, balanced per-currency ledger entries and deduplicated `app.outbox`. An open dispute prevents release. A bank payout after transfer has no local adapter/status integration: **NOT IMPLEMENTED**, sandbox credentials **BLOCKED**; do not repeat the transfer.

Verify: exactly one confirmed release or a visible unresolved case. Local mock provider success is not evidence that a creator received bank funds.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
