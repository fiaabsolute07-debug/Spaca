# PAY-16 evidence: provider costs that change after capture (Claude, 2026-09-15)

Scope: master §18 PAY-16 ("the provider's actual fee differs from the estimate or arrives late → reconcile before/after settlement → a clear cost policy and cap, no retroactive debt or arbitrary negative net").

Environment: **local only**. Embedded PostgreSQL 18 and the in-process mock payment provider (`MOCK_PROVIDER_FEE_BPS` fixture cost at capture). No real provider fee reports.

## What changed

- **Policy `cost-v1` (`src/modules/payments/cost-policy.ts`, pure function `lateCostShares`)**
  - Before the creator payout, under CREATOR_AT_COST: the creator bears a late increase only up to a cap of `LATE_COST_CAP_BPS` of the order amount (default 100 = 1%, cumulative per order, 0–10% accepted) and never so much that their net stops being positive. The platform bears the rest. A late decrease lowers the creator's cost, never below zero.
  - After the payout was sent (settlement PENDING or RELEASED): nothing is taken back. An increase is a platform expense; a lower final cost the creator already paid becomes a credit owed to them.
  - PLATFORM_SUBSIDIZED, or an order with nothing left to settle to the creator (refunded): the platform bears every change.
- **Mock provider**: signed `funding.fee_updated` webhook with the new actual cost of a captured funding; harness `simulateFeeAdjustment(reference, actualFee)`.
- **Migration `drizzle/0023_provider_cost_adjustments.sql`**: `app.provider_cost_adjustments`, one immutable row per provider fact (previous and actual cost, delta, creator share, platform share, creator credit, phase, fee payer, cap in bps and minor units, policy version).
  - CHECKs: delta = actual − previous; shares add up to the delta; no creator share after payout, under a subsidized policy or against the direction of the change; a credit only after payout on a decrease.
  - Insert trigger: the creator's cumulative late increases never exceed the recorded cap. Updates and deletes are refused.
- **Payment flow (`applyLateProviderCost` in `funding.ts`)**
  - A cost update that arrives before its funding fact throws, so the inbox keeps it for `reprocess_webhook_inbox` instead of dropping or misapplying it. Duplicates are ignored by event id.
  - The creator's share moves `orders.provider_fee_minor` (the cost deducted from the payout) only before the payout.
  - Ledger `PROVIDER_COST_ADJUSTED`: an increase debits `provider_fee_expense:mock` and credits `provider_clearing:mock`; a decrease does the reverse, with any creator credit booked to `creator_cost_credit:<order>`. With the release posting, the platform's net cost equals its share.
  - Event `PROVIDER_COST_ADJUSTED` with the split. MEDIUM cases: `LATE_PROVIDER_COST_ABOVE_CAP`, `LATE_PROVIDER_COST_AFTER_RELEASE`, `LATE_COST_CREDIT_OWED`.
- **Operator view**: "Provider cost changes" table on `/admin/orders/[orderId]`.

## Tests run (2026-09-15)

| Check | Result |
|---|---|
| `tests/unit/cost-policy.test.ts` | 6/6 PASS: cap and cumulative cap; net stays positive (share 499 when 500 would leave a zero net, 0 when there is no room); decreases before payout floored at zero; after payout no share and a credit capped at what the creator paid; subsidized and no-settlement cases; env cap bounds |
| `tests/integration/payments.db.test.ts` | 19/19 PASS (3 new PAY-16 tests) |
| Before payout | captured cost 19.50 → 26.00: creator 6.50 (the 1% cap), platform 0 → 39.00: creator 0, platform 13.00, one ABOVE_CAP case; replayed webhook reported duplicate; payout net 624.00 (650 − 26); after completion `provider_fee_expense` totals 13.00 and the order ledger nets to 0; DB refuses a forged row above the cap and any update |
| After payout | completed with cost 19.50 and net 630.50 → 24.50: platform 5.00, AFTER_RELEASE case → 4.50: credit 19.50 owed to the creator (`creator_cost_credit` −19.50), CREDIT_OWED case; order fee, version and the release net unchanged; ledger nets to 0 |
| Early update | cost update before the funding fact: webhook 500, nothing stored; after funding, the inbox job applies it once (creator 6.50 capped, platform 13.50) |
| Full `RUN_DB_INTEGRATION=1 vitest run` | 275 passed + 3 skipped (anvil opt-in) |
| Browser | the admin order page renders the new "Provider cost changes" table (empty for an order without changes) |

## Limits

- The fee payer policy is still the `FEE_PAYER_POLICY` environment setting read at the time of each fact, not a per-order snapshot; the cap is recorded per adjustment.
- Credits owed to creators are recorded and flagged; there is no payout flow for them.
- The platform fee stays 0 and the fee model is undecided; this policy only covers the provider's own cost.
