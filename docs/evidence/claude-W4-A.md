# W4-A evidence: P3 auctions v2 (Claude, 2026-09-14)

Scope: master §5.3, §10 and §16.6 (P3-01..08), §18 AUC-01..14.
Environment: **local only**.
- Embedded PostgreSQL 18.4 (`creator_marketplace_test`) as `app_server`.
- `MockPaymentProvider` as the local test provider.
- Next dev browser check against the dev DB.

## What changed

**Migration `drizzle/0008_auctions_v2.sql`**
- **Auction states.** The enum is now SCHEDULED, LIVE, AWAITING_WINNER_PAYMENT, SETTLED, NO_BIDS, WINNER_DEFAULTED and CANCELLED. Legacy CLOSED rows became SETTLED; legacy EXPIRED rows became NO_BIDS (no bids) or WINNER_DEFAULTED (had bids).
- **New auction columns.** `first_valid_bid_at` (write-once), `current_bid_id`, `winning_bid_id`, `payment_due_at`, `terms_snapshot`, `version`, `closed_at`, `cancel_reason`, plus a 7-day maximum duration (NOT VALID for legacy rows).
- **`auction_guard` trigger.**
  - Enforces the §10.2 transitions.
  - LIVE → CANCELLED is only allowed before the first bid.
  - Price, times, version and terms are frozen after the first valid bid.
  - `first_valid_bid_at` can never be reset.
  - Deletes are refused.
- **Bids.**
  - A per-auction `sequence`, unique per auction.
  - A `request_key` (the command idempotency key), unique per bidder and auction.
  - Status ACCEPTED/INVALIDATED with who invalidated it, why, and when.
  - Immutable except for invalidation; deletes are refused.
- **`auction_purchase_intents`.**
  - Kinds are WINNER (with a bid) and BUY_NOW.
  - Status is ACTIVE, FUNDED, DEFAULTED or EXPIRED.
  - A unique order per intent, and at most one ACTIVE or FUNDED intent per auction.
  - Existing auction orders were backfilled.
- **`orders_auction_sync` trigger.** Order FUNDED → intent FUNDED and auction SETTLED. Order CANCELLED while still unpaid → intent DEFAULTED/EXPIRED and auction WINNER_DEFAULTED. The auction never reopens.

**`src/modules/auctions/commands.ts`**
- **`create_auction`.**
  - Requires a published service.
  - Buy Now must be above the starting price.
  - The start cannot be more than 5 minutes in the past, and the auction runs at most 7 days.
  - The claimed week must still fit the work after `ends_at` + 24 h winner window + turnaround.
  - Stores a terms snapshot. Status is LIVE when the start has already passed.
- **`bid`.**
  - Locks the auction row and checks DB `now()` against start and end.
  - The first bid may equal the starting price; later bids need highest valid + increment.
  - The sequence is assigned inside the transaction.
  - Updates the pointer and `first_valid_bid_at`, and notifies the outbid bidder.
- **`buy_now`.**
  - Only before the first valid bid ever; otherwise 409 BUY_NOW_UNAVAILABLE.
  - Checkout hold TTL is 15 minutes.
- **`closeAuction` (shared by the job and the command).**
  - Idempotent under the row lock.
  - No bids → NO_BIDS, and the claim is released once.
  - Otherwise the winner gets a pending order, the claim moves onto it with a 24 h expiry, and a WINNER intent is created.
- **`cancel_auction`.** Seller only, before any bid. **`recomputeHighestBid`** is exported for moderation.

**Other files**
- **Admin.** `admin_invalidate_bid` (moderator/admin, with reason). Keeps the history row, recomputes the leader and bid count, leaves `first_valid_bid_at` unchanged, and writes an audit entry.
- **Jobs.** `closeDueAuctions` starts due SCHEDULED auctions and closes due ones; it is part of `runJobsOnce`. `expireCheckoutHolds` no longer writes the auction status itself; the trigger does.
- **Errors.** BUY_NOW_UNAVAILABLE now maps to 409.
- **Read models.**
  - `getAuctionData(actor, id)` returns `server_now`, `version`, `accepting_bids`, highest bid, next minimum, `buy_now_available` and viewer standing: NONE, WINNING, OUTBID, WON_PAY, BOUGHT_PAY, WON, LOST, DEFAULTED, SELLER or CANCELLED.
  - Bidders are shown under per-auction pseudonyms (md5 of auction + bidder); ids are never exposed. Only ACCEPTED bids are listed.
  - `getMyBids(actor)` returns the user's auctions with their standing.
- **API.** `GET /api/auctions/[id]/snapshot`, read-only.
- **UI.**
  - `AuctionLivePanel` polls every 5 s while the tab is visible, refetches on visibility/online, counts down on the server clock, and shows a stale-connection notice.
  - The auction page shows terms, pseudonymous history, bid/Buy Now only when the snapshot allows, and seller cancel/close.
  - The `/auctions` list gains a "My bids" table.

## Test evidence

- `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run`: **18 files, 195/195 passed**. This includes the new `tests/integration/auctions.db.test.ts` (11 tests).
  - TEST_PLAN 7 was updated for the §13.3 status codes.
  - The jobs test now expects WINNER_DEFAULTED where it used to expect EXPIRED.
- `tsc --noEmit` exit 0.
- `release-check`: all 4 static checks PASS.

| ID | Test | Result |
|---|---|---|
| AUC-01 | Claim HELD. Bucket end ≥ ends_at + 24 h + 72 h turnaround. Terms snapshot stores prices and the winner window. Pool reserved = 1. A >7-day auction, Buy Now equal to the start price, and a start 1 h in the past each return 400. | PASS (local-mock) |
| AUC-02 | A $99 bid on a $100 start → 422. A first bid of $100 → 200. Two concurrent $110 bids → [200, 422], and the loser's message names $120. Sequences are 1 and 2. | PASS (local-mock) |
| AUC-03 | SCHEDULED auction: bid and Buy Now → 422. After `ends_at`, with status still LIVE and no job run, a bid → 422 "ended" and `bid_count` is unchanged. | PASS (local-mock) |
| AUC-04 | Seller bid → 403. Suspended bidder → 403. The highest bid is unchanged. | PASS (local-mock) |
| AUC-05 | Two concurrent close jobs on a no-bid auction record NO_BIDS once. The claim is RELEASED once and the pool is reserved 0. A third run examines nothing. | PASS (local-mock) |
| AUC-06 | Two concurrent jobs plus the seller command produce 1 intent and 1 order ($130, fee 0, winner = highest bidder). `payment_due_at` is ≈24 h and equals the hold expiry. Viewer standings are WON_PAY and LOST. After payment: SETTLED, intent FUNDED, My bids shows WON. | PASS (local-mock) |
| AUC-07 | A concurrent first bid and Buy Now leave exactly one success. If Buy Now won: bid → 422, 1 order, 0 bids. If the bid won: Buy Now → 409, 0 orders. | PASS (local-mock) |
| AUC-08 | A bidder trying to invalidate → 403. A moderator invalidates → pointer and price null, bid count 0, `first_valid_bid_at` unchanged, row INVALIDATED, audit written, public history empty. Buy Now → 409. Resetting `first_valid_bid_at` → trigger error. | PASS (local-mock) |
| AUC-09 | After bidding starts, a $200 bid above the old $150 Buy Now price → 200. Buy Now → 409. Terms edits → "frozen" error. | PASS (local-mock) |
| AUC-10 | The winner's 24 h hold expires: provider intent CANCELED, order CANCELLED, auction WINNER_DEFAULTED, intent DEFAULTED. There is still only 1 order (no runner-up charge), and the pool is reserved 0. | PASS (local-mock) |
| AUC-11 | The Buy Now hold is ≤15 min. On expiry the auction becomes WINNER_DEFAULTED and the intent EXPIRED. Bid and Buy Now → 422. Setting status back to LIVE → trigger error. | PASS (local-mock) |
| AUC-12 | 3 rounds of concurrent cancel and first bid: exactly one outcome each round. When cancel loses, it returns 409. | PASS (local-mock) |
| AUC-13 | The snapshot has `server_now`, and `version` increases after a bid. Standings go NONE → OUTBID/WINNING. Pseudonyms do not contain user ids. The GET route returns 200 with the viewer's standing, and 404 for an unknown id. | PASS (local-mock) |
| AUC-14 | A signed funding success arriving after the default gives: order stays CANCELLED, auction stays WINNER_DEFAULTED, one LATE_FUNDING case, pool reserved stays 0. | PASS (local-mock) |

**Browser check (dev DB, fixture personas, no passwords).**
1. creator_c created an auction starting at $100 with Buy Now at $400.
2. buyer_a bid $100. Their page showed "You are the highest bidder", version 2, with Buy Now hidden.
3. buyer_b bid $150 from the same browser session store.
4. Within one poll (≤6.5 s) buyer_a's panel showed $150, next minimum $160, "You have been outbid · your best $100.00", version 3.
5. The mobile-width layout rendered correctly.

## Not done / limits

- **Seller payout readiness is not checked at scheduling** (AUC-01 mentions it). The mock provider has no payout-capability model; this needs the real provider's capability check.
- **Metrics are not implemented** (P3-07 "≥3 bidders/uplift"). There is also no separate outbid email beyond the in-app outbox notification.
- **No E2E for the multi-user browser race.** The DB suite covers races at the SQL level.
- **No real-time transport.** Polling only, which is sufficient per §10.6.
