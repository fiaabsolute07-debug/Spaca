# Security matrices and concurrency races (Claude, 2026-09-15)

Scope: PARTIAL rows closed with executed tests. SEC-01, SEC-02, SEC-04, SEC-08, SEC-10, FND-05 and PAY-09 are covered by `tests/integration/security.db.test.ts`. PAY-13, PAY-14, CAP-04, CAP-10 and REQ-07 are covered by `tests/integration/races.db.test.ts`; the PAY-13 race also covers the refund-versus-release gaps noted for ORD-10 and ORD-15.

Environment: **local only**. Embedded PostgreSQL 18, mock payment provider, real route handlers, separate buyer and creator accounts. Races use `Promise.all` against the database with no mocked locks.

## Security (`security.db.test.ts`, 7/7)

| Row | What ran |
|---|---|
| SEC-01 | A second buyer on a delivered order is refused (403) for `approve`, `revision`, `dispute`, `message`, `request_cancellation`, `cancel`, `review`, `mark_delivery_viewed`, `refund_digital_purchase` and `request_deadline_extension`, and for card checkout (403). Bank-transfer and crypto payment requests are refused too. `getOrderData` returns null. The order status, version and payment are unchanged, with no message or dispute rows; the real parties can still message. (Private downloads were already covered by W2-S.) |
| SEC-02 | A rival creator gets `getOrderData` null (no brief); `start`, `deliver`, `message` and `request_deadline_extension` are refused (403); answering the buyer's cancellation request is refused (403); a DELIVERY upload intent on the order is refused (404); `update_service` on the other creator's listing is refused and the title is unchanged. The delivery count and `creator_id` are unchanged. |
| SEC-04 | `book` with forged `price`, `amount`, `amount_minor`, `platform_fee(_minor)`, `provider_fee_minor`, `currency`, `payee_account_id`, `creator_id`, `buyer_id`, `status` and `payment_status` still creates 650.00 USD, fee 0, the service's creator, the real buyer, AWAITING_PAYMENT/PENDING. Checkout with a forged amount, payee or fee creates a provider funding of 65000 to the creator's payee with fee 0. Deliver and approve with forged payout fields still release net 65000, and the order completes with fee 0. |
| SEC-08 | Cross-origin approve, checkout, bank transfer and upload intent all return 403. After the session expires, approve, book, checkout and bank transfer return 401 and the order stays DELIVERED. |
| SEC-10 | A creator suspended mid-order can still accept the buyer's deadline proposal and the buyer's full-refund cancellation; the provider confirms and the order ends REFUNDED. The suspended creator can still read the order, and `create_service` is refused (403). |
| FND-05 | With `CRYPTO_CHECKOUT_ENABLED` off, a direct `create_crypto_payment` returns 422 naming the flag and writes no intent. |
| PAY-09 | A correctly signed `funding.succeeded` whose body says `mode: live` is refused (400) before the inbox; no inbox row, and the order stays AWAITING_PAYMENT. |

## Races (`races.db.test.ts`, 5/5, stable over 3 consecutive runs)

| Row | Race | Result |
|---|---|---|
| PAY-13 (+ORD-10/15 gaps) | A full-refund cancellation accepted by the creator, against the buyer approving and the release job, over 4 rounds with staggered starts. Automatic approval is checked to skip while the request is open. | Every round: exactly one of the two commands succeeds, and exactly one provider money operation exists — refund (order REFUNDED) or release (order COMPLETED, request EXPIRED). Order principal and the order ledger net to 0. The test requires both outcomes to occur across the rounds. |
| PAY-14 | Three concurrent refunds after release (300/400/500), then two concurrent refunds of the remainder+0.01 and the exact remainder, then 0.01 more. | 1 success + 2×409, then 200 + 409, then 409. Two refunds total 65000, both REFUNDED from provider facts; the provider shows 65000 refunded; the ledger nets to 0. |
| CAP-04 | An exclusive DIGITAL license whose first buyer's payment attempt is UNKNOWN (accepted then timed out); its hold expiry runs against three rival buyers at once. | All rivals get 409; the expiry reconciles (entitlement EXPIRY_RECONCILING). Reconciliation resolves the attempt, the provider confirms payment and the first buyer's order is delivered. A later rival still gets 409; one live entitlement exists throughout. |
| CAP-10 | The provider's funding webhook for a hire order against its hold expiry job, 3 rounds. | Every round ends FUNDED, claim ACTIVE, budget reservation COMMITTED, one FUNDING_CAPTURED, request counters equal to the reservations. The expiry reconciled first in 8 of 9 recorded rounds and the webhook won in 1. |
| REQ-07 | `accept_offer` against `expire_hire_offers` with expiry offsets of 0–75 ms, 6 rounds. | Each offer ends ACCEPTED (order, HELD claim and HELD reservation) or EXPIRED (no order, reservation RELEASED); request counters always equal the reservations. Over 3 runs: 12 accepted, 6 expired. |

Full `RUN_DB_INTEGRATION=1 vitest run`: 291 passed, 3 skipped (anvil opt-in).

## Not closed here

- ESLint cannot run: `typescript-eslint` refuses TypeScript 7.0, which the project uses. A config was tried and removed; fixing it needs a tooling dependency change (for example running lint against a TypeScript 6 API).
- SEC-07 (script/URL/SSRF in the browser) and SEC-11 (log and bundle secret scan) remain PARTIAL.
