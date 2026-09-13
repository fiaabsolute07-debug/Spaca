# Capacity stuck in hold

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Baseline `3bddff9`; concurrent P3 changes are unaccepted. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: engineering + finance; MEDIUM, HIGH for counter mismatch or possible oversell.

1. Read `app.reservations` (pool_id, bucket_id, order_id, state, units, expires_at) and `app.capacity_buckets`; `app.capacity_pools` holds configuration, not counters. Compare bucket reserved units with HELD+RECONCILING and committed units with COMMITTED+CONSUMED. Triggers derive these counters and the DB CHECK prevents totals above total_units.
2. Follow the order on `/admin/orders/[orderId]` and uncertainty on `/admin/operations` / `/admin/cases`. Reconcile original provider operations before considering expiry; UNKNOWN or captured payments preserve RECONCILING capacity.
3. In the isolated original Next process, the shared local hook runs `reconcile_provider_operations` before `expire_checkout_holds`. Expiry cancels a still-open provider intent before release, and rechecks state under locks. A terminal unpaid checkout releases once; consumed work never returns to inventory, even after refund.
4. Capacity transaction contract: **pool → bucket(s) by start time → order**. Source review found order-first expiry/settlement paths updating reservations through bucket triggers; universal lock-order compliance is not proved. Escalate this consistency review to Claude; do not manually acquire reverse-order locks or repair counters.
5. For request hires inspect `app.hire_offers`, `app.request_budget_reservations` and `/requests/[id]`. OFFERED expires after at most 24h via `expire_hire_offers`; ACCEPTED hands over to checkout expiry. The order trigger commits budget on FUNDED, releases on unpaid cancellation/lapse or full REFUNDED. Partial refunds stay committed. Pre-0007 requests have no reservation backfill; do not trust their zero counters as complete historical obligations.
6. On invariant failure, an admin can disable `CHECKOUT_CREATION_ENABLED` on `/admin/flags` with a reason, preserving webhook/refund/reconciliation. Pool-specific kill switches and automatic repair are **NOT IMPLEMENTED**.

Verify `reserved_units + committed_units <= total_units`, no duplicate claim, and request budget/count conservation. Weekly timezone changes preserve booked intervals but may leave a partial-week gap. No per-slot ACCESS model is accepted yet.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
