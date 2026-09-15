# ORD-12 evidence: deadline extensions by agreement (Claude, 2026-09-15)

Scope: master §18 ORD-12 ("buyer/creator agreed deadline extension → new immutable amendment; metrics use the agreed deadline").

Environment: **local only**. Embedded PostgreSQL 18, mock payment provider, Next dev server on 3100, system Chrome.

## What changed

- **Migration `drizzle/0020_order_amendments.sql`**
  - `app.order_amendments`: kind `DEADLINE_EXTENSION`, `deadline` DELIVERY (moves `delivery_due_at`) or REVISION (moves `revision_due_at`), proposer, counterparty, reason (10–2000), `old_due_at`, `new_due_at`, `order_version`, `policy_version` `amend-v1`, status REQUESTED/ACCEPTED/REJECTED/WITHDRAWN/EXPIRED.
    - CHECKs: proposer ≠ counterparty; new date after the old one; `responded_at` set exactly when decided.
    - One open proposal per order (unique partial index).
    - Trigger `order_amendment_guard`: proposed terms never change; a decided amendment never changes again. Deletes are refused.
  - Trigger `orders_delivery_due_guard`: once set, `orders.delivery_due_at` only moves to the new date of an amendment accepted in the same transaction. This also turns ORD-04 ("the due date is fixed once set") into a database rule.
  - Trigger `orders_amendment_expiry`: any order status change except FUNDED → IN_PROGRESS expires the open proposal and records `DEADLINE_EXTENSION_EXPIRED`. Covers commands, jobs and operator actions.
- **`src/modules/orders/amendments.ts`**
  - `request_deadline_extension {order_id, new_due_at (UTC datetime-local), reason}`: either party, on FUNDED/IN_PROGRESS (delivery deadline) or REVISION_REQUESTED (revision deadline); not on DIGITAL purchases. The new date must be after the current deadline, at least one hour from now and at most 90 days later. Event `DEADLINE_EXTENSION_REQUESTED`; notification `order.deadline_extension_requested` to the other party.
  - `respond_deadline_extension {amendment_id, decision accept|reject|withdraw}`: locks the order, then the amendment. Only the counterparty accepts or declines; only the proposer withdraws. Accepting requires the deadline to be exactly the one proposed against (compared in SQL, microsecond precision) and the new date not to have passed; it records ACCEPTED, moves the deadline, bumps the order version and writes `DEADLINE_EXTENDED`. Notification `order.deadline_extension_resolved` to the proposer.
  - Suspended accounts may still use both commands on existing orders. Both account types may use them.
- **Read model and UI**: `getOrderData().amendments` (newest first, with proposer name) and `active_amendment`. The order page has a "Deadline" panel: current deadline, the open proposal with Accept/Decline or Withdraw, a proposal form (suggests two days after the current deadline) and the list of past changes. Hidden for DIGITAL purchases.
- **Metrics**: lateness on delivery (`DELIVERED.late`), the overdue queue/reminders and the creator on-time rate all read `orders.delivery_due_at`, so they use the agreed deadline.
- **Tests that moved deadlines directly** (ORD-04, ORD-13) now respect the guard: ORD-04 asserts the direct write is refused; ORD-13 builds a genuinely overdue order by backdating the clock inputs of a Buy Now order before the real clock rule sets its deadline.

## Tests run (2026-09-15)

| Check | Result |
|---|---|
| `tests/integration/orders.db.test.ts` | 22/22 PASS (4 new ORD-12 tests; ORD-04 and ORD-13 rewritten) |
| Accept path | proposal leaves the deadline unchanged; proposer accept 403, outsider 403, counterparty withdraw 403, second open proposal 409; counterparty accept moves the deadline to the proposed instant, ACCEPTED row + `DEADLINE_EXTENDED` event + one notification row; second accept 409; DB refuses editing the amendment, re-deciding it, deleting it and moving the deadline again directly |
| Rules | earlier date 400, more than 90 days 400, short reason 400; a proposal made while FUNDED can still be answered after work starts; declined and withdrawn proposals keep the deadline |
| Expiry | delivering expires the open proposal (EXPIRED + event); accepting it afterwards 409; nothing to extend while delivered 409 |
| Metrics | an order 8 h overdue on its original deadline, extended by agreement and then delivered: `DELIVERED.late=false`; after completion the on-time rate is 1 of 1 |
| `tests/e2e/deadline.spec.ts` | PASS: creator_c proposes on the order page (deadline unchanged, no accept button for the proposer) → buyer_a sees the reason and accepts → deadline changes and the history shows Accepted → no horizontal overflow at 390 px |
| `tests/providers.test.ts` | new templates render with static subjects and internal links |
| Full `RUN_DB_INTEGRATION=1 vitest run` | 260 passed + 3 skipped (anvil opt-in) |

## Limits

- Only the delivery deadline has a database guard; revision deadlines move through the same command, but `revision_due_at` is also legitimately reset by revisions and deliveries, so the database does not pin it.
- Only later deadlines can be proposed; there is no agreed shortening.
- The date field is UTC (labelled); the page does not convert to the viewer's time zone.
