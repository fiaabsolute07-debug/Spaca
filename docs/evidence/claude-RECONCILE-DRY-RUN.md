# `reconcile:dry-run` (master §17.4, 2026-09-17)

`pnpm reconcile:dry-run` is one of the scripts §17.4 requires, with one rule attached to it: *"`reconcile:dry-run`
không gửi tiền."* `docs/STAGING.md` recorded it as **NOT IMPLEMENTED** and warned against passing
`POST /api/dev/jobs` off as a substitute, because the jobs route is effectful — it retries payouts and moves money.

## What it does

Reads the books and the chain, reports where they disagree, changes nothing. Exit code 1 means drift for a person
to look at. The script imports no command, job or payout dispatcher, so it cannot send money even by mistake.

| Check | What disagreeing means |
|---|---|
| Double-entry balance | A ledger transaction whose entries do not sum to zero in its own currency: money appeared or vanished inside one transaction. Currencies are never netted against each other. |
| Finished orders hold no principal | An order that is COMPLETED, REFUNDED or CANCELLED still carrying a balance on `order_principal:<id>`: work has stopped but money is still recorded against it. |
| Open reconciliation cases | Questions someone already raised. The books are not called clean while they sit. |
| No payout is stuck mid-flight | `SUBMITTING` for 15 minutes or more (its outcome is unknown), or out of retry attempts, so nothing will move it again. |
| Chain payouts match the escrow | Per payout reference, through `findPayout`: recorded as paid but the escrow never sent it, or not recorded while the escrow already paid it — the second is the dangerous one. |
| Escrow buckets cover what was paid out | Confirmed releases and refunds against what the chain says was deposited. Spending more than a bucket held means the books describe money that does not exist. |

## Reporting what it could not check

A reconciliation that quietly skips half the estate is worse than none, so "unchecked" is printed as loudly as
"drift" and never as a pass:

- `checkPayoutsAgainstChain` returns **UNCHECKED**, not PASS, when there are payouts but no escrow answered for
  any of them. Same for `checkBucketsCovered`. A clean PASS with "(0 compared)" is only possible when there was
  genuinely nothing to compare.
- Networks whose escrow could not be reached are named.
- The mock payment provider keeps its objects in the dev server's process memory, so after a restart there is
  nothing on the provider side to reconcile against. The report says so every time rather than implying the
  provider was verified.

## Structure

`scripts/lib/reconcile-rules.ts` holds the judgement as pure functions over plain rows, and
`scripts/reconcile-dry-run.ts` does the reading and printing — the same split `release-check.ts` uses, and what
lets the rules be tested without a database or a chain. Errors are caught and reported without echoing the
message, because rows and connection strings pass through here.

## What it found on the development database

```
PASS      | double-entry balance (297 transactions)
FAIL      | finished orders hold no principal (236 orders)
          - order 3f3f6b84…a12b is CANCELLED but still holds -25000 minor units of principal
          - order 3f8748cf…105a is COMPLETED but still holds -4000 minor units of principal
          - order 77362fa3…8fb is COMPLETED but still holds -4000 minor units of principal
          - order a703297e…5bb is COMPLETED but still holds -4000 minor units of principal
FAIL      | no open reconciliation case (14 open)
          - 13 × PROVIDER_OBJECT_MISSING, REFUND_REJECTED, UNEXPECTED_REFUND
PASS      | no payout is stuck mid-flight
PASS      | chain payouts match the escrow (0 compared)
UNCHECKED | escrow buckets cover what was paid out
UNCHECKED | payment provider operations
DRIFT | 2 of 7 checks disagree with the outside world; nothing was changed.
```

Both failures are known, pre-existing development data, which is the useful part: the tool independently found
what the handoff already describes.

- The **$40 and $80 holds** are the performance-bonus rows created before the `1f7ad3e` webhook fix;
  `docs/HANDOFF_PROMPT.md` records them as "vài đơn performance trong DB dev vẫn có case UNEXPECTED_REFUND/
  REFUND_FAILED mở và /funds hiện phần giữ (40–80 USD)".
- Most open cases are `PROVIDER_OBJECT_MISSING`, which `docs/NEXT_SESSION.md` §2.3 predicts whenever the dev
  server restarts and the in-memory mock provider loses its objects.
- **232 of the 236 finished orders net to zero**, which is what gives the rule its credibility: it is not
  flagging a whole class, it is flagging four rows that are genuinely wrong.
- "0 compared" for chain payouts is honest here: the development database holds no `chain_payouts` rows at all.

Nothing was fixed. A dry run reports; changing payment facts by hand is forbidden, and these need the console or
the pending database cleanup.

## Tests

`tests/unit/reconcile-rules.test.ts` — 15 tests, no database needed. They cover each rule's pass and fail sides
and, specifically, that comparing nothing is reported as UNCHECKED rather than agreement, that two currencies are
never netted against each other, and that the report separates drift from what could not be looked at.

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `vitest run tests/unit/reconcile-rules.test.ts` | **15 passed** |
| `tsx scripts/reconcile-dry-run.ts` | ran against the development database, exit 1, findings above |

## Not covered yet

- Provider-side reconciliation needs a real provider; the mock cannot support it (`docs/STAGING.md` §4).
- Bucket coverage only answers where a chain reader exists in the running process. The LOCAL simulator lives in
  the dev server, so a full answer there needs either the deployed testnet escrow or a shared simulator.
- `docs/STAGING.md` still lists `smoke:staging` and `test:contracts` as not implemented; only this one is done.
