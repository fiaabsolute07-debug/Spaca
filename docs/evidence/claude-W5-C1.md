# W5-C1 evidence — P4 crypto checkout rail, local devnet (Claude, 2026-09-14)

Scope: master §11.1–11.4, §16.7 P4-01 (registry part), P4-02, P4-05, P4-06 (order funding/labels), and §18 CRY-01..05, CRY-11 (allowlist part), CRY-14 (gate part).

Environment: **local only**.
- Embedded PostgreSQL 18.4 (`creator_marketplace_test`) as `app_server`.
- An **in-process simulated devnet** (`LocalDevChain`), with receipts, logs, block hashes, confirmations, reorgs, outages and re-inclusion.
- **No Arc testnet, no RPC, no contract deployment, no Foundry. No real keys or funds.**
- Arc docs were not re-verified, since network access was not authorized. The testnet reader exists as code but was never run.

## What changed

**Migration `drizzle/0009_crypto_rail.sql`**
- `chain_networks`
  - Modes: LOCAL / TESTNET / MAINNET.
  - CHECK: MAINNET can never be enabled; TESTNET needs `verified_at`.
- `chain_assets`
  - Native vs ERC-20, with per-interface `decimals` and `balance_key`.
  - CHECK: only STANDARD transfer behaviour can be allowlisted, which rejects fee-on-transfer and rebasing tokens.
  - CHECK: USD-pegged assets need at least 2 decimals.
- `wallet_challenges` and `wallets`: single-use nonce; one active owner per chain+address.
- `orders.payment_rail`: MOCK_PROVIDER or CRYPTO.
- `crypto_payment_intents`
  - Exact atomic amount, settlement recipient, and an opaque sha256 bytes32 reference.
  - At most one open intent and one confirmed intent per order.
- `chain_deposits`
  - Unique (chain_id, tx_hash, log_index).
  - Guard trigger: identity is immutable and final states are terminal.
  - One CREDITED deposit per intent; no deletes.
- `chain_checkpoints`.

**`src/modules/crypto/*`**
- `abi.ts`: the `OrderFunded(paymentRef, payer, token, amount)` settlement event.
- `chain.ts`
  - `ChainReader` interface.
  - `LocalDevChain` simulator, shared via `globalThis` so every Next route sees the same devnet.
  - A viem RPC reader for verified testnets (unexercised).
- `registry.ts`: exact USD-cent ↔ atomic conversion, decimal format/parse without floats, token→asset lookup, reference builder.
- `wallets.ts`
  - EIP-4361-style message built by the server; checked with viem `verifyMessage`.
  - Bound to domain, URI, chain, nonce and expiry; single-use.
  - Rate-limited to 10 challenges per 10 minutes.
- `deposits.ts`
  - `verifyChainTransaction` trusts only receipt logs emitted by the network's settlement address.
  - Rejection reasons: TX_REVERTED, NO_SETTLEMENT_EVENT, EVENT_FROM_UNTRUSTED_CONTRACT, UNSUPPORTED_ASSET, UNKNOWN_REFERENCE, WRONG_CHAIN, WRONG_ASSET, UNDERPAID, OVERPAID, WRONG_SENDER, DUPLICATE_PAYMENT, NOT_CENT_EXACT. Each is recorded with a case; unmatched deposits get one case per deposit.
  - Deposits stay pending until the configured confirmations are reached on a canonical block.
  - Indexer `scanChainDeposits` advances its checkpoint only after the whole range is processed.
  - `recheckPendingDeposits` marks deposits that are no longer canonical as REORGED and reopens the intent.
- `commands.ts` — `create_crypto_payment`:
  - Needs the CRYPTO_CHECKOUT_ENABLED and CHECKOUT_CREATION_ENABLED flags.
  - Buyer only; order AWAITING_PAYMENT with a live hold; no card attempt in progress.
  - The asset must be USD-pegged and allowlisted. An optional verified wallet binds the sender.

**Payments (`funding.ts`)**
- `applyChainFunding` gives crypto the same guards as provider funding:
  - exact amount;
  - AWAITING_PAYMENT with a HELD or RECONCILING hold, otherwise a LATE_FUNDING / DUPLICATE_FUNDING case;
  - a balanced ledger `chain_clearing:<chain>` / `order_principal`;
  - `payment_rail=CRYPTO`, and a PAYMENT_CONFIRMED event carrying rail, network mode, tx, log and atomic amount.
- `cancelOpenFunding` refuses to cancel while a deposit is pending finality, so an expiring hold goes RECONCILING instead of being released. It cancels intents that are still awaiting a deposit.
- Crypto refunds and payouts return `UNAVAILABLE`, which opens a case, until the chain settlement adapter exists.

**Jobs and routes**
- `chain_indexer` job, part of `runJobsOnce`.
- `POST /api/wallets/challenge`, `POST /api/wallets/verify`, `POST /api/crypto/deposits` (the tx hash is only a hint).
- `POST /api/dev/local-chain/pay`: devnet wallet simulator. It returns 404 in production or when LOCAL_CHAIN=off.

**UI**
- Order next-step panel:
  - "Pay with stablecoin" options, with interface and decimals shown.
  - Server-issued instructions: exact amount, network, settlement address, reference, deadline, status.
  - A LOCAL DEVNET / TESTNET badge.
  - "Simulate wallet payment (local devnet)" and a "Check payment" hash form.
  - The card button is hidden while a crypto intent is open.
- The order header shows the network badge on crypto-funded orders (CRY-01 receipt label).

**Seed**
- Local devnet 1337001, mode LOCAL, 3 confirmations.
- USDC native (18 decimals) and USDC token interface (6 decimals) as separate registry entries.
- The flag stays off by default.

## Test evidence

- `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run`: **20 files, 206/206 passed**.
  - Includes the new `tests/integration/crypto.db.test.ts` (8 tests) and `tests/unit/crypto-units.test.ts` (3 tests).
  - The crypto suite passed twice more in isolation after the unmatched-case fix.
- `tsc --noEmit` exit 0.
- `release-check`: 4 PASS, including the dev route production guard and "no funding writes outside funding.ts".

| ID | Test | Result |
|---|---|---|
| CRY-01 | Intents and receipts carry `network_mode` LOCAL. The UI badge reads "LOCAL DEVNET · simulated, no real funds". PAYMENT_CONFIRMED records rail/mode. | PARTIAL: local label proven; testnet rail BLOCKED |
| CRY-02 | All of these return a result and leave the order AWAITING_PAYMENT: fake hash → NOT_FOUND; untrusted emitter → EVENT_FROM_UNTRUSTED_CONTRACT; reverted tx → TX_REVERTED; unallowlisted fee-on-transfer token → UNSUPPORTED_ASSET; unknown reference → UNKNOWN_REFERENCE with an unmatched case; underpaid by 1 atomic unit → UNDERPAID, intent EXCEPTION, case. A deposit on another chain returns NOT_FOUND for the buyer and WRONG_CHAIN for the indexer. A wallet-bound intent paid from another address → WRONG_SENDER. An outsider checking an intent → 404. | PASS (local devnet) |
| CRY-03 | Verifying the same hash again → DUPLICATE. An indexer rescan credits nothing new. There is exactly 1 ledger transaction. A second payment for a paid intent → DUPLICATE_PAYMENT with 1 credited deposit. | PASS (local devnet) |
| CRY-04 | 6-decimal interface: 650000000 atomic = 65000 cents. 18-decimal native: 650×10^18 atomic. Ledger is balanced at ±65000. Unit tests cover exact round trips on huge values, non-cent amounts refused, 1-atomic formatting, and parse rejecting excess precision or exponent notation. | PASS (local devnet / unit) |
| CRY-05 | At 1/3 confirmations the deposit is PENDING; hold expiry → RECONCILING, not released; cancel is refused. During an RPC outage, scan and recheck report RPC_UNAVAILABLE and the checkpoint is unchanged. Back online: the indexer credits, the hold is COMMITTED, a second run adds no extra ledger rows. After a reorg the deposit is REORGED and the intent reopens; a replacement tx credits once and the old hash stays REORGED. | PASS (local devnet) |
| CRY-11 (allowlist part) | DB refuses to allowlist a REBASING token. An unallowlisted FEE_ON_TRANSFER token → UNSUPPORTED_ASSET. | PARTIAL: contract-level malicious-token tests NOT_RUN (no contract) |
| CRY-14 (gate part) | DB refuses an enabled MAINNET network and an unverified enabled TESTNET. A LOCAL network is unavailable in production code paths. | PARTIAL: release-check has no mainnet row yet; testnet BLOCKED |
| Wallet proof (P4-02) | Forged signature, wrong domain and other user are refused. A valid link works once; reuse → already used. The same address for another account → 409. An expired challenge is refused. | PASS (local) |
| Late funds | Order cancelled → intent CANCELLED. A later final deposit is credited with LATE_FUNDING: the order stays CANCELLED and one LATE_FUNDING case opens. A crypto-funded order cancelled before work → REFUND_PENDING, and a REFUND_NOT_REQUESTED case names the missing chain adapter. | PASS (local devnet) |

**Browser check** (Next dev, dev DB, fixture personas, no passwords or keys):
- **Flag.** The admin enabled CRYPTO_CHECKOUT_ENABLED with an audit reason.
- **Checkout.** buyer_a booked. The order page offered "Pay 650.00 USDC (native/token) on Local devnet (simulated)", and the chosen option showed:
  - the exact amount, chain 1337001, settlement address, 64-hex reference and deadline;
  - status AWAITING DEPOSIT and the LOCAL DEVNET badge.
- **Payment.** "Simulate wallet payment (local devnet)" led to FUNDED / SUCCEEDED, a PAYMENT CONFIRMED timeline entry and the header network badge; the card button disappeared.
- **Bug found and fixed during this check.** Next dev bundled the pay and verify routes separately, so each had its own chain instance and verify said "Transaction not found". The devnet now lives on `globalThis`, like the mock provider.

## Not done / blocked (honest)

- **Arc / testnet.** Docs are not re-verified and no chain id, RPC, decimals or finality policy is configured; `createRpcChainReader` was never executed. **BLOCKED:** needs network access authorization and verified configuration.
- **Settlement contract** (§11.3 fund/release/refund/freeze/pool functions), Foundry unit/fuzz/invariant tests, deployment and security review: **NOT_RUN**. The tools are not installed and installs were not authorized. CRY-10/11/13 at contract level are NOT_RUN.
- **Crypto refunds and creator payouts:** not implemented; they open operator cases.
- **Pools, allocations, mixed payouts, entitlements** (P4-07/08; CRY-06..09, CRY-12): next task, W5-C2.
- **Other gaps:**
  - The mainnet go-live checklist (P4-10) and a release-check crypto row are not written.
  - There is no custody ADR yet.
  - Wallet UI linking (browser wallet injection) is not built; only the API is, plus the devnet simulator.

## Process note

- **What went wrong.** Commit `48e0704` (C3 docs) unintentionally contained the staged pure rename `src/modules/storage/http.ts → src/lib/json-route.ts`. It was staged by `git mv` before the docs commit. At that single commit the asset routes still import the old path and do not type-check.
- **Where it is fixed.** This commit (W5-C1) updates the imports.
- **Why history was not rewritten.** The no reset/rebase rule applies.
- **Prevention.** Check `git diff --cached --stat` before committing selected paths.
