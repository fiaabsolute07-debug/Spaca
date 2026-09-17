# Small releases go out together (master §11.7, 2026-09-17)

§11.7 lists three things still missing from the Arc money path. Two are blocked on the outside world (deploying to
Arc testnet needs the faucet; bank off-ramp needs a licensed provider, KYC and custody). The third was buildable:

> **Chưa có:** Worker gom lô `releaseBatch` (contract đã hỗ trợ).

The spec's reason is the point of the feature: *"Để khoản vài USD không bị phí mạng và độ trễ làm đắt, các release
nhỏ được gom lô (batch) theo chu kỳ hoặc ngưỡng; mỗi release vẫn có authorization một lần và reference riêng để
đối soát."* A micro campaign paying five creators a few dollars each should not pay five network fees.

## A note on what was asked for

The handoff's next-steps list said "nạp/rút số dư Arc" — a per-user balance with deposit and withdraw. §11.7's own
**15/09/2026 decision, model A (non-custodial)** rules that out: *"số dư tổng theo user (bước 1–2 của bản nháp)
**chưa làm và không cần cho mô hình A**"*, and "withdraw to a wallet" is defined there as the release to the
creator's proven wallet, which already exists. Building a custodial balance would have contradicted the
architecture the user settled on, so the unfinished item in the same section was built instead.

## What was built

- **`ChainPayoutAdapter.executeReleaseBatch?`** (`src/modules/crypto/chain.ts`) — optional, so an adapter without
  it simply keeps sending one at a time.
- **EVM adapter** (`src/modules/crypto/evm.ts`) — `releaseBatch(Release[], bytes[])`, through the same simulate-
  then-send path as a single release. The ABI and the contract already had it (`contracts/src/SpacaEscrow.sol`,
  `releaseBatch`, covered by `contracts/test/SpacaEscrow.t.sol`).
- **Local devnet simulator** (`LocalDevChain`) — mirrors the contract's all-or-nothing behaviour: it applies each
  release in turn and rolls the whole lot back if any one is refused, so a rejected batch leaves nothing half
  paid, exactly as a reverted transaction would. `snapshot()` / `restore()` cover nonces, payout references,
  buckets and the transfer log.
- **`dispatchChainPayoutBatch(ids)`** (`src/modules/crypto/payouts.ts`) — signs one authorization per payout,
  records each in `release_authorizations`, sends one transaction, then finishes each payout row individually.
- **`dueReleaseBatches()`** — groups due releases by chain and token: `ALLOCATION` and `ORDER_RELEASE` only, at
  most `BATCH_MAX_AMOUNT_ATOMIC` (50 USDC at 6 decimals) each, `BATCH_MAX_SIZE` 10 per transaction, and at least
  `BATCH_MIN_SIZE` 2 or it is not worth batching.
- **`dispatch_release_batches`** job, running just before `dispatch_chain_payouts` in `runAllJobs`.

## The safety rules it keeps

- **Nobody is paid twice.** Each release keeps its own `payoutRef` and nonce, so the contract refuses a repeat
  whatever the transaction shape. Batching changes the envelope, never the accounting.
- **A refused batch marks nobody FAILED.** `releaseBatch` is all-or-nothing and the revert does not say which
  member caused it, so every member goes back to `RETRY` with `BATCH_REJECTED:<code>` and the ordinary
  one-at-a-time worker sorts out who was really at fault. Marking them FAILED would blame the innocent.
- **An unknown outcome stays unknown.** A batch submitted without a receipt sets every member to `UNKNOWN`, and
  the existing `findPayout` reconciliation runs before anything is signed again.
- **Refunds and freezes never batch.** A refund's recipient comes from the bucket and a freeze moves no money;
  only releases name a recipient, so only releases are grouped.
- **Anything large goes alone.** A release worth more than the ceiling is its own transaction, where a revert
  costs nothing else.

## Tests

`tests/integration/release-batch.db.test.ts` — 6 tests:

- small releases group by chain and token; a release over the ceiling is left out;
- refunds are never batched;
- a batch pays every member in one transaction, each with its own payout reference and exactly one authorization
  row, and the amounts add up;
- **a refused batch pays nobody**: a bucket holding enough for only the first of two releases reverts the
  transaction, both rows go to `RETRY` with `BATCH_REJECTED`, no transaction hash is recorded and the simulator
  shows no transfers at all — which is also what proves the rollback;
- a single payout takes the ordinary path rather than a batch of one;
- the `dispatch_release_batches` job reports no errors and confirms its payouts.

`tests/integration/jobs.db.test.ts` gains `dispatch_release_batches` in the list of jobs the local runner runs.

## Results

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `RUN_DB_INTEGRATION=1 vitest run` | **400 passed, 3 skipped** (52 files, 1 skipped) |
| `cd contracts && forge test` | **17 passed**, 0 failed |

A second full run showed one failure, `digital.db.test.ts` XPL-05 (concurrent license holds). It passes on its own
and is unrelated to this change — it is a timing-sensitive concurrency test that flakes under load.

One flake of my own was found and fixed while doing this: `landing.db.test.ts` asked for the first 200 creators,
and the test database has grown past **13,315** creators with a published service, so the fixture sorted off the
end. Those lookups now ask for far more than the database holds and say so if that is ever exceeded.

## Still not done in §11.7

- Deploy to Arc testnet — waiting on the faucet (CRY-01).
- Bank withdrawal / off-ramp, KYC, and KMS or multisig custody — all need real providers and legal sign-off.
- A batch is sent as soon as two are due; there is no time-window accumulator yet ("theo chu kỳ"), which would
  need the real scheduler listed in `docs/NEXT_SESSION.md` §5.3.
