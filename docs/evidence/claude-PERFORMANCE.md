# Performance campaigns: fixed fee plus a capped view bonus (2026-09-16)

Master §9.6. Environment: LOCAL — embedded PostgreSQL (dev and test at migration 0026), mock payment provider, **mock view metrics**. No platform API is connected, nothing was deployed, and no real money moved.

## What it does

- A PUBLISH campaign can pay a fixed fee per post plus a bonus for measured views. Behind `PERFORMANCE_CAMPAIGNS_ENABLED`, off by default.
- The bonus is capped twice: per creator (`bonus_cap`), and by views (`floor(baseline_median × median_multiplier)`), where the median is the creator's own recent posting median, frozen at hire in `app.performance_baselines`.
- The campaign holds the maximum for each hire (fee + bonus cap) when the creator is hired, so the buyer can never be charged more than they saw. Whatever the bonus does not use is refunded at settlement.
- The post is measured once, `measure_after_days` after it goes live. A count that does not look earned is held with a reason and a `PERFORMANCE_BONUS_REVIEW` case instead of being paid.
- After `verify_days`, the bonus becomes final: the order releases the fixed fee plus the earned bonus, and the unused hold is refunded to the buyer through the provider.

## Where it lives
- `drizzle/0026_performance_campaigns.sql`: campaign columns with a completeness CHECK, `performance_baselines` (immutable), `performance_measurements` (terms and measured facts immutable, decided status terminal), and `orders.performance_refund_minor`.
- `src/modules/publish/performance.ts`: the arithmetic, in integers.
- `src/modules/publish/metrics.ts`: the **mock** source (`mock-metrics-v1`), deterministic from handle and post link.
- `src/modules/publish/performance-service.ts`: scheduling, measuring, approving.
- `src/modules/requests/commands.ts`: campaign terms, and the hire that freezes the baseline and holds the maximum.
- `src/modules/jobs/index.ts`: `measure_performance_posts`, `settle_performance_bonuses`, and the release gate.
- `src/modules/payments/{providers,funding}.ts`: the `PERFORMANCE_UNUSED_HOLD` refund reason and the split between refund and release.
- UI: `src/components/campaign/brief-type-picker.tsx`, campaign page facts, `src/components/order-workspace/performance-panel.tsx`.

## Runs
- `tsc --noEmit`: exit 0.
- `vitest run tests/unit/performance.test.ts`: 6 passed. The spec's worked example (20 USD fee, 2 USD per 1,000 views, 80 USD cap, median 8,000) gives a 24,000 view cap, a 48 USD bonus on a 150,000-view post, a 68 USD payout and 32 USD back to the buyer. Whole thousands only, never above the cap, exact fractional multipliers, and deterministic mock metrics.
- `RUN_DB_INTEGRATION=1 vitest run tests/integration/performance.db.test.ts`: 4 passed.
  - The hire freezes the median (and the baseline row refuses edits), holds 100 USD for a 20 USD fee, and refuses a quote that is not the fixed fee.
  - The checkpoint measures once; a measured count cannot be rewritten; nothing releases while the measurement is scheduled or in its checking period; after it, the release operation is `release:<order>:performance` for fee + bonus minus the provider cost, and the unused hold is refunded as `refund:<order>:performance`.
  - A held bonus writes its reason, opens the review case, leaves `performance_refund_minor` null, and blocks both release and refund.
  - Refusals: flag off, wrong category, a budget below one maximum hire, and a creator with fewer than 10 qualifying posts.
- Browser (dev server, flag on): Post a brief shows the posting terms only for PUBLISH and "How you pay" only when the flag is on; choosing the bonus model reveals the six fields and states "You pay at most $100.00 per creator". A campaign created this way lists paid per post $20.00, bonus per 1,000 views $2.00, most bonus $80.00, most per creator $100.00, counted after 7 days then checked for 7, and a views cap of 3× the creator's median.

## Limits
- **View counts are simulated.** `mock-metrics-v1` invents a plausible history per handle; connecting a real read-only account is the work master §9.6 describes, and its API terms and cost are still unchecked.
- The spec leaves the defaults open (checkpoint, multiplier, checking period). The code uses 7 days, 3× and 7 days, all set per campaign.
- Fraud signals are the two the mock can express (views far above the median, engagement too low for the views). Repeat-reply and coordinated-account checks are not implemented.
- A held bonus needs an operator decision; there is no operator screen for it yet, only the case and the database row.
- Baselines are read at hire time only, and the "median grew too fast" flag from the spec is not implemented.
