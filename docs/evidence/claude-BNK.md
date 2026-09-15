# BNK-01/02/03 evidence: buyer funding by bank transfer (Claude, 2026-09-15)

Scope: master §16 P6-09 and §18 BNK-01 (a bank payment pending for days is never funded before a verified provider fact), BNK-02 (bank funding past its bounded hold, or returned/reversed, handled by its own policy with audit), BNK-03 (bank funding refused through the direct API when switched off or unsupported; bank payouts do not imply bank funding).

Environment: **local only**. Embedded PostgreSQL 18, mock payment provider with a sandbox bank, Next dev server on 3100, system Chrome. No bank, no provider bank rail, no real money.

## What changed

- **Mock provider**
  - Funding intents take `method: 'BANK_TRANSFER'` (omitted = card; card request hashes are unchanged). A bank intent returns `nextAction: BUYER_SENDS_BANK_TRANSFER`.
  - The account needs `bankTransferFunding`, otherwise `UNSUPPORTED_CAPABILITY`. The local sandbox account has it (`MOCK_BANK_TRANSFERS=off` removes it).
  - A bank transfer already sent (PROCESSING) cannot be cancelled.
  - New funding status RETURNED with a signed `funding.returned` webhook; harness `simulateBankReturn`.
- **Migration `drizzle/0024_bank_funding.sql`**: flag `BANK_FUNDING_ENABLED` (off); `orders.funding_method` (CARD/BANK_TRANSFER, set from the provider operation when funding is confirmed); payment status RETURNED; CHECK that only a bank-funded order can be RETURNED (NULL-safe — a test caught a first version that let NULL pass).
- **Payment flow (`funding.ts`)**
  - `ensureFundingIntent(…, method)` refuses BANK_TRANSFER while the flag is off. Switching between card and bank cancels the open attempt first, so one order is never paid twice; a transfer on its way blocks card and crypto checkout.
  - `startBankTransfer` (policy `bank-v1`): creates or reuses the bank intent, moves the reservation (workload claim or DIGITAL entitlement) to a 120-hour bank hold, never the 15-minute card hold, and records `BANK_TRANSFER_REQUESTED`.
  - Funding: PROCESSING only marks the payment PROCESSING; the order is FUNDED only on the verified `funding.succeeded` fact, recording `funding_method=BANK_TRANSFER`.
  - Hold expiry reuses the existing reconciliation rules: an unsent transfer is cancelled and the reservation released; a transfer on its way keeps the reservation in EXPIRY_RECONCILING with a case, and funds the order if it settles; a transfer that then fails is released on the next run. Money arriving for an order that can no longer take it follows the existing LATE_FUNDING case.
  - `funding.returned`:
    - on a FUNDED order that has not started, the order is CANCELLED with payment RETURNED and its reservation released;
    - after work started, the order keeps its status and history, payment RETURNED stops any release, and a HIGH `BANK_FUNDS_RETURNED` case is opened;
    - after the payout, `bank_return_loss` is booked with a HIGH `BANK_RETURN_AFTER_RELEASE` case.
    - Ledger entries balance, event `BANK_FUNDS_RETURNED`, notification `payment.returned` to both parties.
- **Routes**
  - `POST /api/checkout/bank-transfer {order_id}` (buyer): 422 `FEATURE_DISABLED` while off, 400 `UNSUPPORTED_CAPABILITY`, 403 for others, 409 for other state conflicts.
  - `POST /api/dev/mock-bank-transfer {order_id, outcome SENT|SETTLED|FAILED|RETURNED}`: sandbox only (404 outside mock mode, guarded for release-check). It changes the transfer at the mock provider; the order moves only through the signed webhook.
- **UI**: on the order, a buyer sees "Pay by bank transfer" when the flag is on. After choosing it, a "Bank transfer" box shows amount, payment reference, reserved-until, status and the note that receipts and screenshots are not accepted, plus sandbox buttons. There is no upload for payment proof. Card and crypto payment are hidden while a transfer is on its way.
- **E2E infrastructure**: `tests/e2e/global-setup.ts` warms the Next dev routes and both sign-in/join dialogs before the suite, after cold starts caused one-off failures.

## Tests run (2026-09-15)

| Check | Result |
|---|---|
| `tests/integration/bank.db.test.ts` | 4/4 PASS |
| BNK-03 | flag off → 422 FEATURE_DISABLED and no provider operation; flag on with an account that pays out but cannot take transfers → 400 UNSUPPORTED_CAPABILITY; the creator → 403; the reservation stayed on the 15-minute card hold; card checkout then funds the order (`funding_method` CARD) |
| BNK-01 | transfer requested → reference returned, reservation ≥ 119 h, one BANK_TRANSFER_REQUESTED event, repeated request reuses the reference; sandbox SENT → AWAITING_PAYMENT/PROCESSING with no funding time; creator start 409; card checkout 400 ("already on its way"); sandbox SETTLED → FUNDED with `funding_method` BANK_TRANSFER; start 200 |
| BNK-02 hold | expired while on its way → RECONCILING (claim EXPIRY_RECONCILING, one case) → settles → FUNDED; expired before sending → RELEASED, order CANCELLED, a later settle is refused by the provider; expired while on its way then FAILED → next run RELEASED |
| BNK-02 return | returned before work → CANCELLED, RETURNED, NOT_READY, reservation RELEASED, ledger nets to 0, 2 notifications; returned after delivery and approval → APPROVED kept, RETURNED, release job examines nothing, one BANK_FUNDS_RETURNED case, delivery kept; DB refuses RETURNED on a non-bank order |
| `tests/e2e/bank-transfer.spec.ts` | PASS from a cold dev server: admin turns the flag on (audited) → creator_c publishes → buyer_a books → Pay by bank transfer → reference and "Waiting for your transfer", no upload in the box → sandbox send → still Awaiting payment, "On its way" → creator_c has no Start work → sandbox settle → Funded → flag turned back off |
| Browser | bank box on a real order: long reference wraps inside the panel after a CSS fix; card and crypto payment hidden while the transfer is on its way |
| Full `RUN_DB_INTEGRATION=1 vitest run` | 279 passed + 3 skipped; `release-check` PASS (new sandbox route guarded) |

## Limits

- Only the mock provider exists; bank instructions are a reference, not real account details. No KYC, no country or currency eligibility rules.
- The bank hold is a fixed 120 hours (`bank-v1`); there is no business-day calendar and no maximum reconciliation period after it.
- Switching from a bank transfer (not yet sent) to a card keeps the longer reservation.
- Returned funds after work started need an operator; there is no buyer re-funding flow.
