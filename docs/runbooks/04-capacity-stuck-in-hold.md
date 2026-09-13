# Capacity stuck in hold

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: MEDIUM; HIGH if counters disagree or oversell is possible. Escalate to engineering; finance operator resolves payment uncertainty.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

An expired checkout still occupies capacity, or available units disagree with reservations.

## How to detect (read-only)

Read `app.reservations` state, units, expiry, pool/order/auction links and `app.capacity_pools`. Follow `app.provider_operations`, `app.webhook_inbox` and `app.reconciliation_cases` for the linked payment. Compare `app.order_events`, `app.ledger_transactions`/`app.ledger_entries` and `app.outbox`. Trace any request/auction handoff before applying a timer.

## Safe steps

1. UNKNOWN or unavailable provider results keep the claim. Determine whether each payment attempt is captured or terminal/cancelled before releasing capacity.
2. For local mock fixtures, the dev jobs hook runs reconciliation before `expire_checkout_holds`. The expiry job rechecks the order/reservation under locks and cancels an open payment before release; unresolved payment keeps RECONCILING.
3. Compare pool counters with reservation totals using the current schema and state rules; include weekly bucket counters when integrated. If they disagree, contain new bookings for that pool and escalate. TODO: audited pool kill switch/diagnostic repair, admin queue UI and operator retry command.
4. Confirm a transferred auction/accepted-hire claim is owned by the new order; a previous expiry timer must not release it. Do not run broad jobs until their other effects are safe.

## Expected result and invariant check

Expected: RELEASED exactly once for a terminal unpaid checkout, or a preserved claim and case while funds are unresolved. Check no oversell, no double decrement, correct order event, balanced money ledger and platform fee 0%. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never decrement capacity counters by hand, shorten expiry to bypass reconciliation or release a captured/unknown payment claim.
