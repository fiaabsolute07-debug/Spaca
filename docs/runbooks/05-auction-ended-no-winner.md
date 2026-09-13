# Auction ended; no winner

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Baseline `3bddff9`; concurrent P3 changes are unaccepted. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: Claude for P3 integration; engineering/operator for incidents. MEDIUM, HIGH for duplicate winner/order or lost claim.

1. Read `/auctions/[id]`, `app.auctions`, `app.bids`, `app.reservations` and related `app.orders`. Compare server deadline and committed sale path; screenshots are not winner evidence. Use `/admin/orders/[orderId]` and `/admin/operations` only for an already-created payment obligation.
2. At accepted baseline `3bddff9`, the seller's `close_auction` command through `POST /api/commands` accepts `auction_id` and the standard idempotency envelope after the deadline. It returns one winner order with a 24h hold, or no-bid EXPIRED with released capacity. A second close is rejected. This is historical local behavior, not acceptance of P3 v2 or an instruction to impersonate a seller.
3. **P3 IN_PROGRESS:** current `src/modules/jobs/index.ts` adds `closeDueAuctions` / `close_due_auctions` to `runJobsOnce`. Read-only inspection confirms the code exists; execution/NO_BIDS/WINNER_DEFAULTED and race results are **NOT_RUN under C3's evidence set**. Claude must review its migration, tests and final command contract before using the updated recovery flow.
4. Do not execute the broad dev hook while Claude changes P3. Once integration is verified, use the documented hook in the original local process and inspect every report. Preserve the existing auction reservation on order handoff; never allocate a second unit or autocharge a runner-up.

Verify one canonical winner/order/claim, or a terminal no-sale outcome backed by the accepted version. Late payment/resold-capacity recovery follows runbook 01. Deployed auction scheduling and alerting are **NOT IMPLEMENTED**; a local close function is not a deployed scheduler.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
