# PAY-15 evidence: refunds after the creator was paid (Claude, 2026-09-15)

Scope: master §18 PAY-15 ("transfer already released, then a refund; reversal with insufficient balance → a clear deficit/recovery case, never fake recovered creator funds") and §8 funds-flow rules (a refund does not reverse a transfer by itself; recovery is a separate operation that can fail; no deficit hidden behind a fake balance).

Environment: **local only**. Embedded PostgreSQL 18 and the in-process mock payment provider. No real connected accounts, balances or reversals.

## What changed

- **Mock provider (`src/modules/payments/providers.ts`)**
  - `reverseTransfer({releaseReference, orderId, amount, currency}, operationId)` (journaled kind `reversal.create`): pulls money back from a succeeded creator transfer, never more than was transferred. With a payee balance configured (`payeeBalances` option, `setPayeeBalance` harness) a reversal larger than that balance fails with `INSUFFICIENT_BALANCE` and moves nothing; the same operation id can be retried later. A success emits a signed `reversal.succeeded` webhook and returns the principal to the charge.
  - `refund` accepts `source: 'PLATFORM_BALANCE'`: a refund of an already-transferred charge paid from the platform's own balance, still limited to what was captured. Without it, refunds must fit the principal still held (unchanged).
- **Migration `drizzle/0022_post_release_refunds.sql`**: `app.post_release_refunds` (order, amount, reason, requester, status RECOVERING/DEFICIT/REFUND_PENDING/REFUNDED, `recovered_minor`, `covered_minor` with approver and reason).
  - CHECKs: recovered + covered ≤ amount; REFUND_PENDING/REFUNDED only when fully recovered or covered; otherwise the gap is visible; a cover always names who approved it and why.
  - One unfinished refund per order.
  - Guard trigger: terms immutable; amounts never decrease; an approved cover cannot be rewritten; **`recovered_minor` must equal the confirmed reversals recorded on provider operations for that refund**; REFUNDED requires the provider-confirmed buyer refund operation. Deletes are refused.
- **Payment flow (`src/modules/payments/funding.ts`)**
  - `startPostReleaseRefund`: card orders whose settlement is RELEASED, at most what the creator received (minus earlier refunds after release), not while a card payment dispute is open or lost. Records the refund, then attempts the reversal.
  - Reversal refused → DEFICIT, event `REFUND_DEFICIT_OPENED` (with the provider code and the available balance when given), HIGH `REFUND_DEFICIT` case. No refund, no ledger entry, no notification. A timeout keeps RECOVERING and retries the same operation.
  - `reversal.succeeded` fact → `recovered_minor`, ledger `REVERSAL_RECOVERED` (`provider_clearing:mock` debit, `post_release_refund:<order>` credit), event `REFUND_AFTER_RELEASE_RECOVERED`, then the buyer refund (`refund:after-release:<id>`).
  - `refund.succeeded` for that operation → REFUNDED, ledger `REFUND_SETTLED` (`post_release_refund` debit, `provider_clearing` credit), event `REFUND_AFTER_RELEASE_CONFIRMED`, buyer `refund.updated` notification. The order stays COMPLETED.
  - `coverPostReleaseDeficit`: only from DEFICIT and only when no reversal for the refund can still move money; ledger `PLATFORM_COVERED_REFUND` (`platform_loss:<order>` debit), then a PLATFORM_BALANCE buyer refund. A reversal that succeeds after a cover reduces `platform_loss` and opens a `REVERSAL_AFTER_COVER` case.
- **Operator commands** (finance/admin, reason + audit): `admin_refund_after_release {order_id, amount, reason}`, `admin_retry_refund_recovery {refund_id, reason}`, `admin_cover_refund_deficit {refund_id, reason}`. `/admin/orders/[orderId]` shows the refund form when the settlement is RELEASED and a "Refunds after release" table with recovered/covered amounts and Retry/Cover actions for deficits.

## Tests run (2026-09-15)

| Check | Result |
|---|---|
| `tests/integration/payments.db.test.ts` | 16/16 PASS (3 new PAY-15 tests) |
| Deficit then recovery | buyer calling the command 403; amount above the transfer 409; creator balance 10.00 vs refund 400.00 → DEFICIT, recovered 0, one REFUND_DEFICIT case, no buyer refund operation, no notification, no `post_release_refund` ledger; second refund 409; DB refuses setting recovered money or REFUNDED without provider facts; balance raised to 500.00 → retry uses the single `reversal:<id>` operation → REFUNDED with 40000 recovered; `post_release_refund` and the order ledger net to 0; one buyer notification; order still COMPLETED; 2 audit rows |
| Platform cover | creator balance 0 → DEFICIT → cover with reason → REFUNDED with covered 65000 by the finance user, ledger `platform_loss` 65000, provider shows 65000 refunded; retry and second cover 409; the refunded row cannot be edited |
| Wrong path | an order not yet paid out 409; an order under a card payment dispute 409 ("card payment dispute") |
| Full `RUN_DB_INTEGRATION=1 vitest run` | 266 passed + 3 skipped (anvil opt-in) |
| Browser (dev server, finance persona) | on a completed order the admin page offered "Refund after release"; 25.00 → "Reversal accepted…", table showed Refund pending with 25.00 recovered; after the local jobs delivered the provider refund → Refunded, Done; events REQUESTED → RECOVERED → CONFIRMED |

## Limits

- The refund is capped at what the creator received; refunding the provider fee part on top is not offered.
- Reversals are all-or-nothing; there is no partial recovery or instalment plan, and no automatic offset against the creator's future payouts.
- The buyer refund after a successful reversal is requested when the reversal fact is processed; its own webhook arrives with the next delivery (next command or job run), like other provider facts.
- Crypto and pool rails are excluded (escrow payouts).
