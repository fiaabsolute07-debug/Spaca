# Refund pending or requested after payout

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Procedure baseline `3bddff9`; P3 auction/job update verified at `90004fd` (see the index). Concurrent P4 changes are not verified here. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: finance; HIGH severity. Use `/admin/orders/[orderId]`, `/admin/disputes` and `/admin/operations`.

1. Inspect `app.orders`, `app.cancellation_requests`, `app.disputes`, `app.provider_operations` and `app.ledger_entries`. Compare consented `cancellation_refund_minor`, prior releases and confirmed refunds; do not substitute a new amount during recovery.
2. Before work, the participant's `cancel` action on `/orders/[orderId]` starts the funding/refund workflow. After work, `request_cancellation` and `respond_cancellation` require counterparty consent bound to the order version. A stale request cannot approve different terms.
3. Finance/admin can use `admin_refund_order` on `/admin/orders/[orderId]` only for CANCELLED orders with SUCCEEDED/REFUND_PENDING payment. It retries the existing agreed/full refund. For open disputes, use `admin_resolve_dispute` on `/admin/disputes`: REFUND_FULL or REFUND_PARTIAL (partial `refund_amount`), with a reason. Support can RESUME but cannot choose money outcomes.
4. Reconcile on `/admin/operations` with `admin_retry_operation`, then verify provider-confirmed full REFUNDED or CANCELLED + PARTIALLY_REFUNDED. `release_ready_settlements` handles an agreed remainder. Work already consumed stays CONSUMED in `app.reservations`.
5. For REQUEST orders, inspect `app.request_budget_reservations` and `app.requests`: full refund releases budget through the order trigger; partial refund keeps it COMMITTED. Other hires must remain intact on `/requests/[id]`.

Verify balanced refund/remainder ledger and `/admin/audit` reasons. Post-transfer reversal, insufficient-balance deficit recovery and bank payout reversal are **NOT IMPLEMENTED**. Keep an assigned `/admin/cases` case; the mock principal guard does not simulate recovered creator funds.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
