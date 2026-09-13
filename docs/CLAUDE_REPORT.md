# CLAUDE_REPORT — payment provider contract, mock adapter, notifications

Date: 2026-09-13 · Author: Claude (desktop Code) · Assignment: docs/COLLABORATION.md "Claude assignment".

## Status

| Item | Status | Evidence |
|---|---|---|
| `src/modules/payments/providers.ts` — contract + `MockPaymentProvider` | DONE (local unit level) | 34 provider tests pass, strict typecheck clean |
| `src/modules/notifications/index.ts` — templates, dispatcher, local sink | DONE (local unit level) | 9 notification tests pass |
| `tests/providers.test.ts` | DONE | 44/44 pass after phase 2 (restart-safe event ids test added) |
| Sandbox/live payment verification | NOT_RUN | Out of scope. No Stripe/Arc calls, no credentials, no network. |
| DB persistence of operations / inbox / outbox / ledger | DONE for mock funding/refund (phase 2) | `src/modules/payments/funding.ts`, `tests/integration/payments.db.test.ts` |

Phase 1 edited only assigned files. Phase 2 edited lead-owned files **with the user's explicit approval** (listed below). No install, commit, deploy, email, network or real money.

## Phase 2 — user-approved build continuation (hand back to Codex)

The user asked Claude to keep building and hand back to Codex afterwards. Full evidence, with exact commands, outputs and a defect table, is in **`docs/evidence/claude-db-integration.md`**.

Headline results:
- **PostgreSQL:** the P0 blocker does not reproduce outside the Codex runner. PG 18.4 started; migrate and seed pass and are idempotent.
- **Tests:** `RUN_DB_INTEGRATION=1 vitest run` gives 68/68; `tsc` exit 0; `next build --webpack` passes.
- **Defects fixed (A–G):** the client-side `sandbox_pay` mark-paid, concurrent idempotency replay, `close_auction` always failing, anonymous request/auction pages crashing, refund marked without a provider, mock event-id collision after restart, and the Postgres socket path.

### Files changed or added in phase 2

| File | Owner | Change |
|---|---|---|
| `scripts/postgres.ts` | lead | TCP-only postmaster (`unix_socket_directories=`) |
| `src/app/api/commands/route.ts` | lead | advisory lock for idempotency; `sandbox_pay` → 403; `cancel` cancels open provider intent; `refund` requests provider refund; post-commit mock webhook delivery; `close_auction` `for update of a`; `PaymentFlowError` mapping |
| `src/lib/read-model.ts` | lead | anonymous `actor?.id ?? null` (2 queries) |
| `src/app/[[...path]]/page.tsx` | lead | "Fund in local sandbox" command replaced by a form posting to the local test provider checkout (shown only in mock mode) |
| `src/app/api/webhooks/mock-payment/route.ts` | new | raw-body signed webhook endpoint; 404 outside mock mode; 400 invalid; 500 retryable |
| `src/app/api/dev/mock-checkout/route.ts` | new | local stand-in for provider-hosted checkout (buyer-only, same-origin, 404 outside mock mode) |
| `src/modules/payments/funding.ts` | new | journal, intent, cancel, refund, webhook inbox processing, ledger, outbox, reconciliation cases |
| `src/modules/payments/providers.ts` | Claude | per-instance event-id nonce |
| `tests/providers.test.ts` | Claude | event-id uniqueness test |
| `tests/integration/harness.ts`, `commands.db.test.ts`, `payments.db.test.ts` | new | DB-backed suites (opt-in `RUN_DB_INTEGRATION=1`) |
| `docs/evidence/claude-db-integration.md` | new | evidence |

### `src/modules/payments/funding.ts` exports

`MOCK_PROVIDER`, `PaymentFlowError`, `PaymentFlowErrorCode`, `mockPaymentsEnabled()`, `getMockPaymentProvider()`, `setMockPaymentProviderForTests(provider)`, `ProviderCallResult`, `ensureFundingIntent(tx, buyerId, orderId)`, `completeMockCheckout(buyerId, orderId, outcome)`, `cancelOpenFunding(tx, orderId)`, `requestProviderRefund(tx, order, reason)`, `WebhookReceipt`, `deliverPendingMockWebhooks()`, `receivePaymentWebhook(rawBody, headers)`.

**Mock mode gate:** `NODE_ENV !== 'production'`, `PAYMENT_MODE` unset or `mock`, and `LIVE_PAYMENTS_ENABLED !== 'true'`.
- The webhook secret is `MOCK_PAYMENT_WEBHOOK_SECRET`, or a public local fixture when unset.
- `MOCK_PROVIDER_FEE_BPS` (0–1000, default 0) sets a provider-cost fixture.

### Semantics

- **Operation ids:**
  - `fund:<orderId>:<attempt>`: the latest attempt is reused unless the provider reported it FAILED/CANCELED or rejected it
  - `cancel:<fundingReference>`
  - `refund:<orderId>:full`
- **Journal:** request hashes come from `computeRequestHash`. Journal status is `PENDING | SUCCEEDED | UNKNOWN | FAILED`, and `outcome.fundingStatus` / `refundStatus` come only from webhooks and never regress from SUCCEEDED.
- **Webhook pipeline:**
  1. `verifyWebhook`
  2. `insert … on conflict do nothing` into `webhook_inbox`, in its own commit
  3. a transaction that locks the inbox row, skips it if already processed, applies the event, and marks it processed
  4. on failure, `attempts+1` and rethrow (5xx)
- **`funding.succeeded`:**
  - Matches the journal by provider reference, then locks the order and checks amount and currency against the snapshot. A mismatch opens an `AMOUNT_MISMATCH` case.
  - If the order is not AWAITING_PAYMENT/HELD, or payment already succeeded, it opens a `LATE_FUNDING` or `DUPLICATE_FUNDING` case.
  - Otherwise:
    - order → FUNDED, and `provider_fee_minor` is recorded
    - reservation → COMMITTED; pool moves 1 unit from reserved to committed
    - `PAYMENT_CONFIRMED` event
    - balanced ledger `funding:mock:<ref>`: `provider_clearing:mock` = amount − fee, `provider_fee_expense:mock` = fee, `order_principal:<order>` = −amount
    - outbox `notify:payment.confirmed:<order>` and `notify:order.new:<order>`
- **`funding.processing` / `failed` / `canceled`:** only move PENDING/PROCESSING, and only for the latest attempt.
- **`refund.succeeded`:** only from `REFUND_PENDING`, full amount → REFUNDED, balanced reversal ledger, outbox `notify:refund.updated:SUCCEEDED:<order>`. `refund.failed` opens a `REFUND_FAILED` case.

## Phase 3 — durable jobs, settlement release, notification timeline (user-approved)

Evidence: `docs/evidence/claude-db-integration.md` → "Phase 3".
- `RUN_DB_INTEGRATION=1 vitest run` → 83/83, twice.
- Without the DB flag: 49 passed, 34 skipped.
- `tsc` exit 0; `next build --webpack` passes.
- 5 mutants against `funding.ts`, all killed.

### Files changed or added in phase 3

| File | Change |
|---|---|
| `drizzle/0002_notifications.sql` | new migration. `app.notifications` is the durable in-app timeline and local email sink, with a unique dedupe key and status `DELIVERED` / `EMAIL_SINK`. It also adds partial indexes for outbox, inbox, reservation expiry and provider-operation scans. |
| `scripts/migrate.ts` | applies every `drizzle/NNNN_name.sql` in order instead of a hardcoded list |
| `src/modules/jobs/index.ts` | new jobs, each re-checking state under row locks: `expireCheckoutHolds`, `reprocessWebhookInbox`, `reconcileProviderOperations`, `releaseReadySettlements`, `dispatchNotificationOutbox`, `runJobsOnce`. All accept `JobScope { limit?, orderId? }`. |
| `src/modules/notifications/store.ts` | new: `DatabaseNotificationSink`, `listInAppNotifications(recipientId, limit)` |
| `src/modules/payments/funding.ts` | adds release (`requestCreatorRelease`, `feePayerPolicy`, `applyReleaseEvent`); `processVerifiedEvent`, `eventFromInboxRow`, `applyFetchedProviderFact`; `refundReasonFor`; exported deduplicating `openCase`; journal matching by reference **or** signed operation id; funding accepts `RECONCILING` holds |
| `src/app/api/dev/jobs/route.ts` | new: `POST` runs all jobs once in the Next process. 404 outside mock mode; cross-origin 403. |
| `src/app/api/commands/route.ts` | cancelling a FUNDED order automatically requests the full provider refund (a case is opened if that cannot be requested); approve message no longer implies money moved |
| `src/app/[[...path]]/page.tsx` | dashboard "Notifications" timeline; "Approve delivery" label; "Check refund with provider" retry on cancelled orders with a pending refund |
| `tests/integration/jobs.db.test.ts` | new, 15 DB tests |

### Semantics

- **Hold expiry:**
  - An expired `HELD`/`RECONCILING` reservation of an `AWAITING_PAYMENT` order first cancels any open provider intent.
  - If the provider already captured funds, or an attempt is unresolved, the reservation becomes `RECONCILING` with one case; a later verified success still funds the order.
  - Otherwise the order becomes `CANCELLED` with `HOLD_EXPIRED`, the unit is released, and a Buy Now/auction order marks its auction `EXPIRED`.
- **Release:** runs for `COMPLETED` + `READY` + `SUCCEEDED` orders with no OPEN/UNDER_REVIEW dispute.
  - The operation is `release:<order>:full`.
  - Net is `amount − provider_fee` under `CREATOR_AT_COST` (the sandbox default), or `amount` under `PLATFORM_SUBSIDIZED`. `FEE_PAYER_POLICY` is required in production.
  - `RELEASED` only after `release.succeeded`, with a balanced ledger `release:mock:<ref>` and a payout notification. `release.failed` gives `FAILED` + case + notification.
  - `PAYEE_NOT_CAPABLE` keeps the order `READY`, opens one case, and later runs retry the same operation.
- **Reconciliation:**
  - `PENDING`/`UNKNOWN` journals are resolved by `lookupOperation`: applied → `SUCCEEDED`. When not applied, funding/cancel → `FAILED` (no money moved); refund/release are retried under the same id.
  - Applied operations without a terminal fact fetch provider status. The result is recorded as inbox `fetch:<ref>:<status>` (`signature_verified=false`, `source=provider_api_fetch`) and processed idempotently. A missing provider object opens a case.
- **Outbox dispatch:**
  - Claims `notification` rows with `for update skip locked`; stale `PROCESSING` rows are reclaimed after 5 minutes.
  - Delivers through `NotificationDispatcher` into `DatabaseNotificationSink`, deduplicated on recipient + semantic key + channel.
  - Exponential backoff, maximum 5 attempts; invalid template/params are parked (`POISONED`).

### Known limits left for Codex (not fixed, not claimed)

1. **Remote calls inside DB transactions.** Provider calls still run inside DB transactions. That is safe for the in-memory mock, because stable operation ids replay after a rollback. A Stripe adapter must split journal-commit and the remote call.
2. **No scheduler.** Nothing calls the jobs automatically. Locally, `POST /api/dev/jobs` runs them; deployed environments need Inngest/cron functions calling `src/modules/jobs`.
3. **In-memory mock state.** Mock provider state lives in the Next process. Jobs touching the provider must run in that process, and a dev restart loses provider-side history (reconciliation then opens `PROVIDER_OBJECT_MISSING`).
4. **Disputes have no resolution.** There is no finance/operator command (refund or release decision, evidence, owner), and no admin queue for `reconciliation_cases`. Partial refunds open a case.
5. **Notifications are minimal.** No mark-as-read, no stored preferences (so marketing is always suppressed, since it requires opt-in), and email is captured locally only.
6. **Hold duration.** The checkout hold is the lead's 30 minutes; master §2 proposes 15.
7. **UI not verified in a browser.** No screenshots and no click-through, because signing in requires entering credentials.
8. **Stale Mirai notes.** `docs/MIRAI_PROVIDER.md`, `README.md`, `docs/BUILD_STATUS.md`, `docs/HANDOFF.md` and `docs/evidence/p0-foundation.md` still describe Mirai, which the user dropped; Codex should remove them.

## Files

- `src/modules/payments/providers.ts`
- `src/modules/notifications/index.ts`
- `tests/providers.test.ts`
- `docs/CLAUDE_REPORT.md`

Both modules are self-contained (only `node:crypto`), so they don't race with shared contracts.

## Exports — `src/modules/payments/providers.ts`

Constants: `PLATFORM_FEE_BPS` (= `0`), `PLATFORM_FEE_ATOMIC` (= `0n`), `DEFAULT_MAX_ATOMIC_AMOUNT`, `MOCK_SIGNATURE_HEADER` (`x-mock-signature`), `DEFAULT_WEBHOOK_TOLERANCE_SECONDS` (300).

Functions:
- `platformFeeFor(amount): bigint` → always `0n`
- `assertZeroPlatformFee(fee, field?)` → throws `NONZERO_PLATFORM_FEE` for any nonzero value
- `assertAtomicAmount(value, rules?)`, `parseAtomicAmount(value, rules?)`: bigint only, or a canonical integer string. No floats, exponents or leading zeros.
- `assertOperationId(id)`: 8–255 chars `[A-Za-z0-9:_.-]`, must start alphanumeric
- `canonicalize(value)`, `computeRequestHash(kind, payload)`: sorted-key, type-tagged encoding (`5n` ≠ `5` ≠ `"5n"`) hashed with SHA-256. The lead can store this as `inputHash`.
- `signMockWebhook(rawBody, secret, timestampSeconds)`, `verifyMockWebhookSignature({rawBody, signatureHeader, secrets, nowSeconds, toleranceSeconds?})`
- `isProviderError(error, code?)`

Classes: `ProviderError` (`code`, `retryable`, `outcome: 'NOT_APPLIED' | 'UNKNOWN'`, `operationId`, `details`), `MockPaymentProvider`.

Types: `ProviderMode`, `AtomicAmount`, `AtomicAmountRules`, `ProviderErrorCode`, `ProviderErrorOutcome`, `MerchantAndPayeeContext`, `Capabilities`, `FundingStatusCode`, `TransferStatusCode`, `RefundReason`, `FundingInput`, `FundingIntent`, `FundingStatus`, `CancelResult`, `ReleaseInput`, `ReleaseResult`, `ReleaseStatus`, `RefundInput`, `RefundResult`, `RefundStatus`, `OperationKind`, `OperationLookup`, `ProviderOperationRecord` (suggested journal DTO for master §8.4; not persisted here), `WebhookEventType`, `VerifiedEvent`, `PaymentProvider`, `VerifySignatureInput`, `FailureEffect`, `FailureInjectionRule`, `MockPaymentProviderOptions`, `WebhookDelivery`, `SimulatedFundingOutcome`.

### `PaymentProvider` interface (master §8.3 + one addition)

`capabilities`, `createFundingIntent(input, operationId)`, `getFundingStatus`, `cancelFunding(reference, operationId)`, `verifyWebhook(rawBody: Uint8Array, headers: Headers)`, `releaseToCreator(input, operationId)`, `getReleaseStatus`, `refund(input, operationId)`, `getRefundStatus`. All methods are async.

**Addition:** `lookupOperation(operationId): Promise<OperationLookup | null>`. This is needed to recover after an `UNKNOWN` outcome (PAY-10/11). A Stripe adapter would implement it with metadata/idempotency-key search plus its own journal.

### Semantics the lead can rely on

- **Fee:** `FundingInput.platformFee` and `ReleaseInput.platformFee` are required and must be `0n`. Every result DTO reports `platformFee: 0n`. `providerFee` is a separate actual-cost fact, and is `null` until the provider reports it.
- **Idempotency:** the provider journal binds an `operationId` to `(kind, requestHash)` the first time it sees that id.
  - Same id + same payload replays the **original** response as a deep copy (`structuredClone`). For the current state, use `get*Status`.
  - Same id + different payload or a different kind throws `IDEMPOTENCY_CONFLICT`. This attempt is not counted and nothing is applied.
  - Concurrent calls are safe: the check-and-apply section is synchronous, so a 10× `Promise.all` produces exactly one intent.
  - Business rejections (`INVALID_STATE`, `REFUND_EXCEEDS_REFUNDABLE`, `PAYEE_NOT_CAPABLE`, …) are **not** cached. Once the state is fixed, a retry with the same key can succeed. The key stays bound to its payload.
  - Input-shape errors (`INVALID_AMOUNT`, `NONZERO_PLATFORM_FEE`, unsupported currency, bad id) are thrown before the journal and bind nothing.
- **Failure injection** (`failureInjection` rules, consumed in order, `times` defaults to 1):
  - `ACCEPT_THEN_TIMEOUT`: the effect is applied, then `PROVIDER_TIMEOUT` with outcome `UNKNOWN`.
  - `TIMEOUT_BEFORE_ACCEPT`: nothing is applied, but the error is still `PROVIDER_TIMEOUT` with outcome `UNKNOWN`.
  - `UNAVAILABLE`: `PROVIDER_UNAVAILABLE` with outcome `NOT_APPLIED`.
  - In every case the caller must retry or look up with the **same** operationId.
- **Principal:** releases and refunds reserve against one principal. `amount ≤ funded − Σ(release pending+succeeded) − Σ(refund pending+succeeded)`. FAILED transfers free their reservation. `fullyRefunded` is true only when SUCCEEDED refunds equal the funded amount.
  - This is a deliberate conservative choice (master §8.5).
  - A real Stripe charge can be refunded after a transfer. That deficit/recovery flow (PAY-15) is a separate operation and is not modelled in the mock.
- **Release guards:** funding must be `SUCCEEDED`, and order, currency and payee must match the funding. If the payee lacks payout capability, release throws `PAYEE_NOT_CAPABLE` (PAY-12).
- **Funding state:** `REQUIRES_ACTION → PROCESSING → SUCCEEDED | FAILED`, and `REQUIRES_ACTION | PROCESSING → CANCELED`. SUCCEEDED/FAILED/CANCELED never regress. Cancelling after success throws `INVALID_STATE`; refund instead. Cancel is idempotent (`alreadyCanceled`).
- **No `markPaid`.** Provider-side facts come only from the test-harness methods `simulateFundingOutcome`, `simulateReleaseOutcome`, `simulateRefundOutcome`, `takeWebhookDeliveries` and `redeliverWebhook`. **Never wire these to an HTTP route or server action.**
- **Mode:** the constructor throws `LIVE_MODE_NOT_SUPPORTED` unless the mode is `test`.
- **Webhooks:** the header is `t=<unix>,v1=<hex HMAC-SHA256>` over `"${t}." + raw body bytes`.
  - Signatures are compared with `crypto.timingSafeEqual` on 32-byte buffers. Multiple secrets are accepted (rotation).
  - Timestamps must be within ±300 s.
  - Mode and account are checked from the **signed body**, not from headers (`WEBHOOK_CONTEXT_MISMATCH`).
  - Amounts travel as strings and are parsed to bigint.
  - Redelivery keeps the same `eventId` and the same bytes, so the inbox dedupes on `(provider, mode, eventId)`. That dedupe is the lead's job.
- References are deterministic from `accountId + operationId` (e.g. `mock_fund_<24 hex>`).

## Exports — `src/modules/notifications/index.ts`

- Constants: `NOTIFICATION_TEMPLATES` (21 templates), `CURRENCY_EXPONENTS` (USD/EUR/GBP 2, JPY/VND 0, USDC 6).
- Functions:
  - `renderNotification(templateId, params)`
  - `formatAtomicAmount(amount, currency)`: string math, no floats
  - `notificationDedupeKey(recipientId, semanticEventKey, channel)`: SHA-256 hex, so no raw ids in keys
- Classes: `NotificationError`, `LocalNotificationSink` (in-memory; `failNext(n)`, `messages(filter)`, `clear()`), `NotificationDispatcher` (`dispatch(request) → ChannelOutcome[]`, `attempts()`).
- Types: `NotificationChannel`, `NotificationCategory`, `NotificationErrorCode`, `NotificationTemplateParams`, `NotificationTemplateId`, `NotificationTemplate`, `RenderedNotification`, `OutboundNotification`, `NotificationSink`, `RecipientPreferences`, `NotificationDeliveryStatus`, `ChannelOutcome`, `NotificationAttempt`, `NotificationRequest`, `NotificationDispatcherOptions`.

Templates (master §14.2): `auth.email_verification_requested`, `auth.password_reset_requested`, `payment.pending`, `payment.confirmed`, `order.new`, `order.brief_missing`, `order.due_soon`, `order.delivered`, `order.revision_requested`, `order.approved`, `payout.succeeded`, `payout.failed`, `refund.updated`, `dispute.opened`, `request.application_received`, `request.hire_offer`, `auction.outbid`, `auction.won`, `auction.expired`, `pool.asset_missing`, `marketing.new_offers`.

Rules:
- **Subjects** are static strings, so no params ever reach a subject.
- **Params** are typed per template. Undeclared params are rejected, which blocks smuggling brief or private text. Values are validated by kind:
  - route-safe ref
  - text of 1–120 chars without control characters
  - ISO-UTC instant
  - bigint amount
  - asset code
- **Links** are internal paths matching `^/[A-Za-z0-9_\-/]*$`: no query strings and no tokens. Auth templates carry no reset/verify token; Supabase Auth owns those emails.
- **Dedupe** is on recipient + semanticEventKey + channel.
  - Claims are taken synchronously, so concurrent duplicates get `DUPLICATE_SUPPRESSED`.
  - A FAILED delivery retries on the same key until `maxAttempts` (default 5).
  - Reusing a key for a different rendered payload throws `DEDUPE_KEY_REUSED`.
  - Every attempt is logged.
- **Preferences:** marketing is opt-in (default off → `SUPPRESSED_BY_PREFERENCE`). Transactional and security notifications ignore the marketing preference.
- **Delivery:** only `LocalNotificationSink` exists, and it never does network I/O. A Resend sink is the lead's decision, with a staging allowlist.
- **Limitation:** dedupe state is in memory per dispatcher instance. Production needs a DB unique constraint on the dedupe key, with the outbox as the durable claim.

## Commands run (exact) and results

Environment: `export PATH=/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH` → `node v24.19.0`, `vitest/5.0.0 darwin-arm64`, `tsc 7.0.2`. Dependencies were already installed by the lead; I ran no install.

1. `./node_modules/.bin/vitest run tests/providers.test.ts --reporter=verbose`
   → `Test Files 1 passed (1)`, `Tests 43 passed (43)`.
   - The first run had 1 failure: my test expected a conflict attempt to increment `attemptCount`. I decided conflicts are not attempts and fixed the test expectation; the implementation was unchanged.
2. `./node_modules/.bin/tsc -p <scratchpad>/tsconfig.claude.json`
   - This config extends the project `tsconfig.json`, adds `noUncheckedIndexedAccess`, and includes only my 3 files.
   - → exit 0, after fixing 3 type errors: a generic on the cancel `runIdempotent` call, a template lookup cast, and a test index access.
3. `./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false`
   → 0 errors in my files. The only error is in the lead's in-progress file: `src/app/[[...path]]/page.tsx(25,1): error TS1005: '}' expected.`
4. Mutation sanity check on a scratchpad copy (repo untouched). Each mutant was killed by the suite:

   | Mutant | Failing tests |
   |---|---|
   | `timingSafeEqual` → always true | 1 |
   | Principal ignores pending transfers | 2 |
   | Hash-conflict check removed | 3 |
   | Replay removed (re-apply) | 4 |
   | Timestamp tolerance removed | 1 |
   | Notification SENDING not deduped | 1 |
   | Nonzero platform fee allowed | 2 |

I did not run the full `pnpm test`, because the lead's integration tests may need the Postgres runtime that is still being set up.

## Acceptance mapping (unit-level only; the DB/route parts remain the lead's)

- PAY-01/18 fee zero on the adapter surface
- PAY-02 fixture: fee 300 on 10 000, release 9 700
- PAY-05 double submit / same-key retry / conflict
- PAY-06 no markPaid
- PAY-07 redelivery same event id
- PAY-08 no regression from SUCCEEDED
- PAY-09 invalid signature / wrong account
- PAY-10/11 accept-then-timeout + lookup + same-key retry
- PAY-12 payee capability
- PAY-13 release vs refund on the same principal
- PAY-14 refunds pending+succeeded ≤ funded
- PAY-17 amount validation

All of these are still NOT_RUN in `docs/ACCEPTANCE.md` terms, because they need the DB/inbox/route integration.

## Suggested integration for lead

- Construct `new MockPaymentProvider({ webhookSecrets: [process.env.MOCK_WEBHOOK_SECRET], now })` only when `PAYMENT_PROVIDER=mock` and not in production.
- Persist `computeRequestHash(kind, payload)` plus the operationId in `ProviderOperation` **before** the remote call.
  - On `ProviderError.outcome === 'UNKNOWN'`, mark the operation UNKNOWN and reconcile with `lookupOperation` or a same-key retry.
- The webhook route passes the raw bytes and `request.headers` to `verifyWebhook`, then inserts into the inbox, unique on `(provider, mode, eventId)`.
- Call `NotificationDispatcher` from the outbox worker, with `semanticEventKey` derived from the business event and order version.
