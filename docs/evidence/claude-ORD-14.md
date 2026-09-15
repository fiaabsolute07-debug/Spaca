# ORD-14 evidence: card payment disputes after completion (Claude, 2026-09-15)

Scope: master §18 ORD-14 ("payment dispute after COMPLETED → chargeback webhook → historical work kept; payment dispute, evidence and alert handled separately").

Environment: **local only**. Embedded PostgreSQL 18 and the in-process mock payment provider. No card network, no real provider dispute API, no evidence submission to a provider.

## What changed

- **Mock provider (`src/modules/payments/providers.ts`)**
  - Signed webhook types `dispute.opened`, `dispute.won`, `dispute.lost` (object type `dispute`, statuses OPEN/WON/LOST, `fundingReference` of the disputed capture). They are parsed and verified like every other provider fact; a tampered body fails the signature.
  - Test harness only (never exposed over HTTP): `simulateChargeback(fundingReference, amount?)` for a captured funding (partial amounts allowed up to the capture) and `simulateChargebackOutcome(reference, 'WON' | 'LOST')`.
- **Migration `drizzle/0021_payment_disputes.sql`**: `app.payment_disputes` (provider reference unique per provider, funding reference, amount, currency, OPEN/WON/LOST, order and settlement status when opened, evidence snapshot, opening/closing event ids and times).
  - CHECKs tie `closed_at` and `closed_event_id` to a decided status.
  - A trigger makes everything recorded at opening immutable and allows OPEN → WON/LOST once. Deletes are refused.
- **Payment facts (`src/modules/payments/funding.ts`, `applyDisputeEvent`)**
  - Matched to the order through the funding operation's provider reference; unknown payments and decisions without an opening open an `UNMATCHED_PAYMENT_DISPUTE` case and record nothing. A dispute larger than the capture or in another currency opens `UNEXPECTED_PAYMENT_DISPUTE`.
  - Opening:
    - never touches the order row, deliveries, approval or reviews;
    - stores an evidence snapshot of timestamps and counts only (brief ready, funded, work start, deadline, approval, completion, delivery versions with validation and buyer-viewed times, message count, buyer reviews, order disputes, auto-accept consent) — no brief, delivery or message text;
    - writes `PAYMENT_DISPUTE_OPENED`, opens a HIGH `PAYMENT_DISPUTE` case for operators and notifies the creator (`payment.disputed`, stage OPENED).
  - WON/LOST close the dispute once (a repeated fact is a duplicate; a contradicting one opens `CONFLICTING_PAYMENT_DISPUTE`). LOST books `CHARGEBACK_LOST` (`chargeback_loss:<order>` debit, `provider_clearing:mock` credit) and opens a HIGH `CHARGEBACK_LOST` case. Nothing is debited from the creator.
- **Settlement**: `release_ready_settlements` skips orders with an OPEN or LOST payment dispute, so a creator release still pending is frozen until the dispute is won (or an operator decides).
- **Operator view**: `/admin/orders/[orderId]` has a "Card payment disputes" table (redacted provider reference, amount, status, order state when opened, evidence summary, opened/closed).

## Tests run (2026-09-15)

| Check | Result |
|---|---|
| `tests/integration/payments.db.test.ts` | 13/13 PASS (3 new ORD-14 tests) |
| Completed order, dispute lost | tampered dispute webhook 400; genuine one processed once, replay reported duplicate; dispute OPEN with order COMPLETED/RELEASED at opening, evidence has 1 valid delivery and 1 buyer review and contains no brief or delivery text; one PAYMENT_DISPUTE case and one creator notification; LOST closes it, ledger `chargeback_loss` +65000 / `provider_clearing` −65000 and the order ledger still nets to 0; one CHARGEBACK_LOST case; order status, version, completion time and settlement unchanged; deliveries, reviews and all non-dispute events unchanged; the order's ledger touches only principal, provider clearing and the chargeback loss; DB refuses re-deciding, editing evidence or deleting the dispute |
| Approved, release pending | partial dispute (20000) opened → release job examines nothing, settlement stays READY; WON → no loss booked, release proceeds and the order completes |
| Unknown payment / orphan decision | signed dispute for an unknown funding reference opens UNMATCHED_PAYMENT_DISPUTE; a LOST decision with no recorded opening records no dispute and no loss and opens one case |
| `tests/providers.test.ts`, `tests/integration/jobs.db.test.ts` | PASS (template renders; release job unchanged for undisputed orders) |
| Full `RUN_DB_INTEGRATION=1 vitest run` | 263 passed + 3 skipped (anvil opt-in) |

## Limits

- The mock provider has no dispute deadline, evidence upload or representment API; operators answer outside spaca.
- A lost dispute is booked as a platform loss. Recovery from the creator (PAY-15) and dispute fees are not modelled.
- Buyers are not notified by spaca; the dispute comes from their own bank.
- Crypto and pool rails have no chargebacks and are unaffected.
