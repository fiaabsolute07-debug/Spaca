# Auto-accept, dispute and mutual cancellation

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Baseline `3bddff9`; concurrent P3 changes are unaccepted. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: finance/support + engineering; HIGH severity. W1-B implements these workflows; they are not pending scaffolds.

1. Inspect `/admin/orders/[orderId]`, `/admin/operations`, `app.orders`, `app.deliveries`, `app.review_holds`, `app.cancellation_requests`, `app.disputes` and `app.order_events`. `orders_transition_guard` enforces the DB transition matrix and version bumps; delivery content/history is append-only.
2. Work clock is fixed when funding and brief are ready: work_start = max(funded_at, brief_ready_at), due = work_start + turnaround. A late Start click does not move it. `revision`/`approve` on `/orders/[orderId]` carry `delivery_version`; stale versions conflict. Deadline amendments (ORD-12) remain **NOT IMPLEMENTED**.
3. `auto_accept_deliveries` requires elapsed review window, valid latest delivery, READY attachments, consent, buyer-view evidence and no open dispute/pending cancellation. Missing evidence/invalid delivery creates `app.review_holds` plus a case; order stays DELIVERED. `order_reminders` queues due/review/overdue notices into the sink.
4. The actual buyer opening `/orders/[orderId]` records `mark_delivery_viewed`; valid view recovery resolves the evidence hold and restarts a full review window. Do not manufacture buyer views or clear holds through SQL. A quarantined file still prevents auto-accept. There is no general operator “clear hold” command or email-delivery confirmation adapter.
5. Use `/admin/disputes` → `admin_resolve_dispute` with a reason: RESUME (support/finance/admin), APPROVE or REFUND_FULL/REFUND_PARTIAL (finance/admin). RESUME restores the prior state and refreshes a delivered review window; APPROVE queues settlement, not immediate completion.
6. Participant mutual cancellation on `/orders/[orderId]` uses `request_cancellation` / `respond_cancellation` (accept/reject/withdraw). Consent binds version/amount; accepted work consumes quota and confirmed refunds/remainder release follow the existing provider operations. If outcome is UNKNOWN, use `/admin/operations` lookup-first retry.

Verify one serialized order event/decision and unchanged consented amount, with balanced ledger and no duplicate effect. W1-B proves competing order actions and delivery/cancellation races; complete refund/auto-release principal races and actual email-bounce recovery remain PARTIAL in the ledger. The broad jobs hook advances eligible work; it is not a freeze command.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
