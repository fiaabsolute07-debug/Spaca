# W9-ARC evidence: SpacaEscrow (model A), payout outbox, crypto rail settlement, Arc testnet readiness (Claude, 2026-09-15)

Scope: master §11.1–11.4 and §11.7 (decision 4A: non-custodial escrow), §6.4 (no provider/chain call inside a DB transaction), §18 CRY-01..14, P4-10. User granted network access and Foundry on 2026-09-15.

Environment:
- **Local:** embedded PostgreSQL 18 and Foundry 1.8.1 (forge/anvil/cast, installed with foundryup attestation verification).
- **Solidity dependencies (pinned):** forge-std v1.16.2 (`bf647bd6`), OpenZeppelin Contracts v5.4.0 (`c64a1edb`).
- **Arc testnet:** read-only checks only (no deployment: the deployer is unfunded).

## Arc facts verified (docs + live RPC, 2026-09-15)

- `docs.arc.io` connect page:
  - chain id 5042002;
  - RPC `https://rpc.testnet.arc.io`;
  - explorer `testnet.arcscan.app`;
  - faucet `faucet.circle.com`;
  - native USDC gas 18 decimals.
- Contract addresses page: USDC ERC-20 interface `0x3600…0000`, 6 decimals; apps should use the ERC-20 interface for balances and transfers.
- EVM differences page:
  - deterministic finality on inclusion (1 confirmation);
  - Osaka baseline;
  - minimum base fee 20 gwei;
  - blocklisted address reverts value transfers.
- Live checks (`scripts/arc-testnet.ts check`): `eth_chainId` = 0x4cef52 (5042002); USDC `decimals()` = 6; head block ~62.11M.

## What changed

- **`contracts/`** (Foundry project; `install-deps.sh` pins dependencies, lib/out ignored):
  - `src/SpacaEscrow.sol`:
    - Buckets keyed by `escrowRef`; the first deposit fixes payer and token; `paymentRef` is single-use.
    - Fee-on-transfer receipts refused.
    - `release` / `releaseBatch` / `refund` (always to the payer) with EIP-712 domain `SpacaEscrow` v1. Each authorization binds payout, bucket, recipient/token/amount, nonce and expiry; payout references are paid once.
    - `setFrozen` (signed); `guardianFreeze`; `reclaim` by the payer after the reclaim time, even while paused, unless frozen.
    - `pause` (guardian/owner), `unpause` (owner). Ownable2Step; bounded reclaim delay (7–365 days); no owner withdrawal.
  - `script/Deploy.s.sol`: deploys, allowlists the token and transfers ownership in two steps.
  - Tests in `test/`.
- **Server**
  - `src/modules/crypto/abi.ts`: escrow ABI/events.
  - `authorization.ts`: Release/Refund/Freeze typed data; production refuses the local signer.
  - `chain.ts`:
    - The simulator applies the contract's rules: buckets, token match, nonce/payout reuse, frozen, paused, balance cap, refund to payer.
    - A configured RPC overrides the simulator for LOCAL (anvil) and TESTNET.
    - `getPayoutAdapter` builds `evm.ts` from `CHAIN_EXECUTOR_KEY_<id>`.
  - `evm.ts`: viem simulate, write and receipt; revert names mapped; `findPayout` via `payoutUsed` + events.
  - `deposits.ts`: `Funded` decoding; `WRONG_ESCROW` when the bucket is not the order's (or the pool asset's) bucket.
- **Migration `drizzle/0014_escrow_payouts.sql`**
  - Adds `escrow_ref` on intents/deposits (backfilled).
  - `app.chain_payouts` outbox: immutable terms; CONFIRMED/FAILED final.
  - Authorization kinds extended; `outcome` UNKNOWN allowed.
- **`src/modules/crypto/payouts.ts`**
  - `enqueueChainPayout` runs in the business transaction.
  - `dispatchChainPayout`:
    - lock, sign and commit;
    - submit outside any transaction;
    - CONFIRMED + effect (in a savepoint, so a failing effect never rolls back an on-chain confirmation);
    - RETRY for EnforcedPause/BucketFrozen;
    - UNKNOWN for RPC/receipt problems, reconciled with `findPayout` before re-signing;
    - FAILED with a HIGH case after contract rejections or 8 attempts.
  - Job `dispatch_chain_payouts` runs after `release_ready_settlements`.
- **Crypto rail (`funding.ts`)**
  - Refunds and releases queue ORDER_REFUND and ORDER_RELEASE (full, agreed partial or remainder). A creator without a wallet on the deposit chain gives RETRY with a committed NO_PAYOUT_WALLET case.
  - Effects complete the order, write balanced ledger entries (`chain_clearing:<chainId>`) and notifications.
  - Disputes queue FREEZE; resolution queues UNFREEZE first.
- **Pools (`pools/service.ts`)**
  - Allocations and unused refunds are queued (one payout reference per attempt), moving value to `pending_outflow` at queue time.
  - Effects move RELEASE_DONE/FAILED and REFUND_DONE/FAILED; completion uses `finalizePoolOrder`, which never queues.
  - The pool refund recipient is the funding wallet (the contract fixes it).
- **Jobs**: `release_ready_settlements` handles CRYPTO/POOL rails without the mock card provider.
- **Checkout UI**: crypto panel shows escrow contract, bucket and reference, and plain-language protection copy. "Pay with browser wallet" (EIP-1193): switch chain, approve the exact amount if needed, `fund`, wait for the receipt, then server verification.
- **Release gate**: `checkMainnetCryptoBlocked` in `scripts/release-check.ts` (PASS), unit-tested with four failing variants.
- **Operations**
  - `scripts/arc-testnet.ts check|register`.
  - `docs/ARC_TESTNET.md`, `docs/adr/002-escrow-custody.md`.
  - `.env.example` lists chain variables without values.

## Verification

| Check | Result |
|---|---|
| `forge test` (contracts/) | **17/17**: 16 unit/fuzz (fuzz 5,000 runs each) + invariant suite 256 runs × depth 64 = 16,384 calls across fund/release/refund/reclaim/freeze/pause. Invariants hold: escrow token balance = Σ open buckets; deposits = held + paid out; released + refunded ≤ deposited per bucket. |
| Unit/fuzz coverage | Signed release pays once (nonce reuse, payout reuse); wrong signer, tampered recipient, expiry, wrong token, overdraw, other contract/chain domain; fee-on-transfer refused; payer/token mismatch on top-up; refund only to payer with partial release accounting; atomic batch; reclaim timing, frozen blocks reclaim, reclaim works while paused; guardian freeze blocks release and refund; **CRY-13** pause blocks fund/release, guardian cannot unpause, signer rotation invalidates old authorizations; bounded delay; existing reclaim times never move; two-step ownership; reentrant token blocked by the guard; fuzzed any non-signer key rejected. |
| `forge lint src` | 3 × block-timestamp (expiry/reclaim comparisons, acceptable at minute scale), 10 × require-revert-in-loop (batch is atomic by design) |
| `RUN_DB_INTEGRATION=1 vitest run` | **248 passed, 3 skipped** (the anvil suite without RUN_ANVIL), 27 files; tsc exit 0 |
| `RUN_DB_INTEGRATION=1 RUN_ANVIL=1 vitest run tests/integration/escrow.anvil.test.ts` | **3/3 on a real EVM with the compiled contract** (see list below) |
| `scripts/release-check.ts` | all PASS including the new mainnet crypto row |
| Migration 0014 | applied to the test DB (then a manual one-off correction of pool escrow refs to the per-asset formula, before commit) and the dev DB |

Anvil suite (`tests/integration/escrow.anvil.test.ts`):
- **Release:** book → crypto intent → buyer approve + `fund` → server verifies the `Funded` log → FUNDED → deliver/approve → creator links wallet → release queued (balance unchanged) → dispatched → creator USDC balance +650.000000 and bucket 0 → order COMPLETED. The receipt succeeded. A crash-duplicated payout row fails with `InsufficientBucketBalance` and the creator balance is unchanged.
- **Refund:** cancelling a funded order while the escrow is paused leaves the refund in RETRY (`EnforcedPause`) with the buyer balance unchanged. After unpause it confirms, the buyer balance is restored and the order is REFUNDED.
- **Wrong bucket:** a deposit into the wrong bucket is REJECTED `WRONG_ESCROW` and the order stays AWAITING_PAYMENT.

DB suites with the simulator:
- **`crypto.db.test.ts`:** cancelled crypto order refunded to the paying wallet through the outbox with a balanced ledger; approved order releases once (RETRY + case without wallet, then CONFIRMED); dispute FREEZE → resolution UNFREEZE + ORDER_REFUND applied in order.
- **`pools.db.test.ts`:**
  - CRY-08 queued (no chain call in the settlement transaction), then per-asset retry.
  - CRY-09 refund pending → REFUNDED to the funding wallet with conservation at every step.
  - CRY-10 escrow authorizations: bad signature, chain/contract domain, expiry, overdraw, nonce/payout reuse, forged signer, refund recipient fixed.
  - CRY-13 pause keeps payouts waiting and completes after unpause without double pay.

## Security note from this task

While generating the Arc testnet keys, a shell word-splitting mistake printed two **freshly generated, never funded, never used** private keys to the session log. They were destroyed immediately and replaced by new keys written straight to `contracts/.env.local` (mode 600, git-ignored) without being displayed. Only the new public addresses are known: deployer/executor `0x7758186cD9FE0156fd5F631e5c944445D9c1e97F`, release signer `0x4721DD4B6f1C9b66BDf22784B988EAAEBB7663e2`. Nothing was deployed or funded with the exposed pair.

## Not done / blocked

- **Arc testnet deployment and on-testnet run: BLOCKED.** The deployer holds 0 USDC, and the Circle faucet needs a human (CAPTCHA). Steps are in `docs/ARC_TESTNET.md`.
- **Browser wallet flow:** implemented, typechecked and wired, but not exercised in a browser with a real wallet (no extension in the test browser).
- **Custody:** KMS/multisig for signer/owner/guardian NOT IMPLEMENTED; production refuses signing. No independent audit.
- **Not built:**
  - worker batching with `releaseBatch`;
  - UI for payer `reclaim`;
  - bank off-ramp/KYC.
- **Pool buckets are not frozen during a hire dispute** (shared by other hires).
