# Fund button and Funds page (2026-09-16)

User request: "thêm nút fund, nối các hoạt động tiền vào đây, nút này ở bên cạnh nút account" — a Fund button next to Account that gathers the money activity. Environment: LOCAL dev server, embedded PostgreSQL (dev and test at migration 0030), mock payment provider, local devnet. Nothing deployed; no real money.

## What it does
- A Fund button beside Account opens a panel with the account's money at a glance and links into each kind of money activity; **Open Funds** leads to `/funds`.
- `/funds` gathers what to pay, what is held for work, refunds, releases, campaign reward pools, on-chain payouts, the money activity feed and wallets.
- Numbers come from the order amount and the double-entry ledger (`src/modules/funds/queries.ts`); the fee model is undecided, so nothing is computed from one.
- `drizzle/0030_funds_indexes.sql` indexes `ledger_transactions(order_id)` and `ledger_entries(transaction_id)`, which the sums need.

## A money bug the page exposed (fixed in `1f7ad3e`)
The first version of the page showed performance-campaign orders with part of their principal still "held" after settlement. Tracing the ledger: the provider had accepted the refund of the unused hold, but the confirming webhook was rejected as UNEXPECTED_REFUND, so no REFUND_SETTLED entry was written and the order never became PARTIALLY_REFUNDED. The refund handler now recognises `refund:<order>:performance`; the performance tests check the books after settlement (principal balance zero, refund settled, no unexpected or failed refund case) and fail without the fix. Orders already settled in the local dev database before the fix keep their open cases and still show that amount as held — the page reports what the books say, and nothing was edited by hand.

## Proof
- `RUN_DB_INTEGRATION=1 vitest run tests/integration/funds.db.test.ts` — 2 passed: one order followed from To pay (240 USD, 1 order; the creator sees it as awaiting payment) → paid (held 240 for both sides, activity "Payment captured") → delivered, approved and released (held 0, released 240, activity "Released to the creator" then "Payment captured"), with a third account seeing nothing; a cancelled order refunded in full shows "Refunded to you" 90 and "Refunded to the buyer"; the summary route answers 401 without a session, 403 from another origin, and 200 `no-store` with the same figures.
- Dev data check: an order refunded 25 USD after release reads held 0, refunded 25, released 100, matching its `post_release_refunds` row.
- `playwright test tests/e2e/funds.spec.ts` — 3 passed: Fund is the button right before Account; the panel shows dollar figures (not placeholders), the five buyer links and the sandbox note; Escape closes it with focus back on Fund; Open Funds shows the five buyer sections and no payouts section; the panel's To pay equals the page's; Money activity lands on its section; a creator gets "Your earnings and payouts", Payouts on chain, no Pay for orders, and creator figures; a visitor has no Fund button; on a 375 px touch phone the panel stays inside the screen.
- Screenshots at 1280 px (menu open, buyer page with folded lists) checked by eye.

## Limits
- No deposit or withdrawal of a balance: this marketplace funds each order or pool directly, and the Arc balance model (deposit, withdraw to wallet or bank) is not built. The Fund menu links only to money flows that exist.
- Bank payouts to creators remain BLOCKED (PAY-19); card and bank orders are released by the test provider and appear under Money activity only.
- Lists show the latest 50 rows each.
