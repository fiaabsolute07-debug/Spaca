# Auction ended; no winner

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: MEDIUM; HIGH if duplicate order/winner or lost capacity. Escalate to engineering and the authorized auction owner.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

The server deadline passed but the auction is still open. Proposed alert: close overdue by more than 2 minutes (alert wiring TODO).

## How to detect (read-only)

Read `app.auctions` deadline/state, `app.bids` and `app.reservations`; find linked `app.orders` and `app.order_events` for an already committed close/Buy Now. Inspect `app.provider_operations`, `app.webhook_inbox`, `app.reconciliation_cases`, `app.ledger_transactions`/`app.ledger_entries` and `app.outbox` if a winner order/payment already exists. Auction version checks remain a planned gate, not proof from the current baseline.

## Safe steps

1. Use server time and committed valid bids. Confirm no close or Buy Now already won the transaction race.
2. Existing local command: the authenticated auction seller submits `close_auction` through `POST /api/commands` with `auction_id` and the original idempotency key. Follow the existing application form/contract; never impersonate a seller. A different-key close is rejected once closed; this is not an admin close tool.
3. After no bids, verify EXPIRED and capacity release. After valid bids, verify one winner order, its payment deadline and reservation handoff. Use the committed result when close conflicts with Buy Now.
4. TODO: scheduled/idempotent job/admin close workflow, version/deadline hardening, semantic notification repair, admin queue UI and operator retry command. The five-job dev hook does not close auctions.

## Expected result and invariant check

Expected: one committed winner and pending order, or no-bid expiry without an order; capacity moves once. Reconcile any existing payment before releasing its claim. Check no duplicate ledger/outbox effect and platform fee 0%. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never select a winner from screenshots, accept a late bid or assign the next bidder without the specified consent flow.
