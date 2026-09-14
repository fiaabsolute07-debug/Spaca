# W5-C2 evidence: P4 campaign pools, allocations, per-asset settlement, entitlements (Claude, 2026-09-14)

Scope: master §11.3 (authorization behaviour), §11.5, §11.6, §16.7 P4-07/P4-08, and §18 CRY-06, CRY-07, CRY-08, CRY-09, CRY-10 (server and simulated contract), CRY-12.

Environment: **local only**.
- Embedded PostgreSQL 18.4 (`creator_marketplace_test`) as `app_server`.
- The in-process `LocalDevChain` simulates deposits, settlement-contract releases, token transfer failures and NFT ownership.
- Viem EIP-712 signing uses a per-process local signer key.

What was not used: no testnet, no deployed contract, no Foundry, no managed custody, and no real keys or funds.

## What changed

- **Migration `drizzle/0010_campaign_pools.sql`**
  - `orders.payment_rail` gains `POOL`.
  - `campaign_pools` is one per request, with statuses FUNDING / ACTIVE / CLOSED.
  - `pool_templates` is versioned and append-only.
  - `pool_assets` holds per-asset buckets `confirmed_deposit`, `unallocated`, `allocated_active`, `pending_outflow`, `released` and `refunded`.
    - The **`pool_assets_conservation`** CHECK requires deposit = sum of buckets.
    - The **`pool_assets_nonnegative`** CHECK forbids negative buckets.
    - A guard trigger keeps deposit, released and refunded cumulative; rows cannot be deleted.
  - `pool_ledger` is an append-only journal with a unique (movement, reference).
  - `pool_funding_intents` handle pool deposits. `chain_deposits` gains `pool_intent_id`, with constraints for exactly one credit target and one credit per pool intent.
  - `pool_allocations` is unique per (order, item). Terms are immutable, RELEASED and CANCELLED are final, and the template version is linked by foreign key.
  - Also added: `pool_refunds`, `release_authorizations` (single-use nonce records) and `reward_entitlements`.
    - Entitlements are unique per (order, item).
    - One NFT (chain, contract, token id) can back only one live entitlement.
    - There is no USD value column.
- **`src/modules/pools/template.ts`**
  - Exactly one required CASH item on a USD-pegged asset; it must be cent-exact and it defines the order price.
  - TOKEN items require `TOKEN_REWARDS_ENABLED` and an allowlisted asset, and store atomic amount and decimals.
  - PERK items (WHITELIST / ACCESS / COMMUNITY_ROLE / NFT) carry a description, fulfilment method and deadline. NFT perks require `NFT_REWARDS_ENABLED`.
  - Items can be marked required or optional before any hire.
- **`src/modules/pools/balances.ts`**: `moveBalance` covers DEPOSIT, ALLOCATE, DEALLOCATE, RELEASE_START/DONE/FAILED and REFUND_START/DONE/FAILED. Each movement is journaled once per reference. Also contains `refreshPoolStatus`.
- **`src/modules/pools/service.ts`**
  - Pool lifecycle: create (only before any application), template versioning, and a funding intent per asset.
  - `allocateHire` locks the pool asset rows in id order and allocates all required items or nothing. It skips unavailable optional items and requires the creator's verified wallet on the pool network. It creates the entitlements.
  - `returnPoolAllocations` handles a full cancel or refund before work.
  - `settlePoolAllocations` runs one signed authorization per payout attempt. Value moves to `pending_outflow` before the payout and leaves it exactly once. A failed asset returns to active for retry. The contract's released-payout memory turns a lost success into reconciliation rather than a second payment.
  - Also: `refundUnusedPoolBalance`, close pool, fulfil entitlement (NFT ownership is checked on chain against the creator's wallet) and claim, plus the `getPoolData` read model (buckets for the owner, rewards and funding gaps for everyone else).
- **`src/modules/crypto/authorization.ts`**
  - EIP-712 `Release(payoutRef, orderRef, recipient, token, amount, nonce, expiry)` under domain {name, version, chainId, verifyingContract}.
  - Local signer only; it fails closed in production because custody is not implemented.
- **`LocalDevChain`**
  - `executeRelease` acts as the simulated settlement contract. It checks signer, chain, its own contract address and expiry. Each nonce is single-use and each payout reference can succeed once (a repeat returns `ALREADY_RELEASED:<tx>`).
  - Also added: `failTransfersOf(token)` and `setNftOwner`.
  - `getPayoutAdapter` returns the simulator for LOCAL networks; any other network has no adapter.
- **Deposits**: pool funding references are verified like order intents (exact asset, exact amount, finality), then credited with one DEPOSIT movement. A reorg reopens the pool intent.
- **Payments (`funding.ts`)**
  - `applyPoolFunding` moves the order to FUNDED with no checkout. The ledger records `pool_clearing:<pool>` against `order_principal`.
  - POOL refunds return the allocations and move the order CANCELLED → REFUNDED. Partial refunds are refused with `UNAVAILABLE`.
  - POOL release: `COMPLETED` only when every required allocation is `RELEASED`. Otherwise the settlement stays `PENDING` and a partial-payout case is opened.
  - The settlement job retries POOL orders that are still `PENDING`.
- **Requests**
  - A pool-backed request needs quote = CASH value; a stale template gives QUOTE_CHANGED at select or accept.
  - `accept_offer` allocates and funds in the same transaction, and order terms snapshot the pool and template version.
  - The W3-R budget trigger still commits and releases hires.
- **Commands**: `create_campaign_pool`, `update_pool_template`, `create_pool_funding`, `refund_pool_unused`, `close_campaign_pool`, `fulfill_entitlement`, `claim_entitlement`. The old `create_pool` simulation now returns DOMAIN_RULE pointing to the new command.
- **Env rules**
  - `RELEASE_SIGNER_PRIVATE_KEY` is refused in deployed environments.
  - `LOCAL_CHAIN` must be `off` when deployed.
  - The unit test also checks that the key value is not echoed.

## Test evidence

- `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run`: **21 files, 214/214 passed**, including the new `tests/integration/pools.db.test.ts` (8 tests). The pools suite also passed twice in isolation.
- Unit tests: 40/40, including the new env-rule test.
- `tsc --noEmit`: exit 0.
- `release-check`: 4/4 PASS.

| ID | Test | Result |
|---|---|---|
| CRY-06 | Template of 100 USDC + 50 RWD per hire, 2 hires, USDC fully funded. Pool stays FUNDING and the owner view shows RWD missing 100.00; the applicant view has no bucket details. Accept → 422 naming RWD, with no order created and the offer still OFFERED. Once RWD is funded: ACTIVE, accept → FUNDED POOL order with capacity COMMITTED, buckets conserved, `committed_hires` = 1. | PASS (local devnet) |
| CRY-07 | Pool of 100 USDC for 2 hires, two concurrent accepts → [200, 422], one allocation. Direct SQL is refused by the conservation CHECK, the non-negative CHECK, the cumulative-deposit trigger and the immutable journal. | PASS (local devnet) |
| CRY-08 | USDC cash + RWD token (required) + BONUS token (optional), RWD and BONUS transfers failing. The job releases only USDC; RWD stays ACTIVE with TOKEN_TRANSFER_FAILED; the order stays APPROVED/PENDING; a POOL_PAYOUT_PARTIAL case opens. After un-failing RWD: exactly one more transfer (RWD only, cash not paid twice), order COMPLETED/RELEASED. The optional BONUS failure stays retryable without blocking completion. Buckets are conserved, the order ledger nets to 0 and every transfer goes to the creator's verified wallet. | PASS (local devnet) |
| CRY-09 | 300 USDC deposited with one hire allocated at 100. Refund without a buyer wallet → 422. Refund of 250 → 422 ("200.00 USDC" refundable). Non-owner → 404. Refund of all unallocated moves 200 to the buyer's wallet while allocated stays 100 and deposit = 0 + 100 + 200 refunded. Closing with an active allocation → 409. | PASS (local devnet) |
| CRY-10 | Tampered amount or recipient → BAD_SIGNATURE. Other chain domain → WRONG_CHAIN. Other contract → WRONG_CONTRACT. Expired → EXPIRED. Valid → transfer. Replay → NONCE_USED. New nonce for the same payout → ALREADY_RELEASED with the original tx. Forged signer → BAD_SIGNATURE. Exactly 1 transfer happened. | PASS (server + simulated contract); PARTIAL overall: no Solidity contract or Foundry test |
| CRY-12 | NFT perk with `NFT_REWARDS_ENABLED` off → 422. Accepting creates one entitlement per perk (WL required, NFT badge optional) with no USD value column. Claim before fulfil → 409. Creator fulfilling → 404. Buyer fulfils with proof → creator claims → second claim → 409. NFT not owned by the creator's wallet → 422; owned → FULFILLED. The same NFT for another hire → 409 (unique index). | PASS (local devnet) |
| Cancel before work | Order becomes REFUNDED/REFUNDED, allocations CANCELLED, perks CANCELLED, USDC and RWD return to unallocated, the request frees its hire, and the order ledger nets to 0. | PASS (local devnet) |
| Template versions | Quote below the CASH reward → 422. Version 2 changes CASH to 150: the version-1 allocation keeps 100; the pending version-1 application is refused at select with 409; the new hire allocates 150 at version 2 with order price 15000. Updating a template → immutable error. Creator without a verified wallet → 422. | PASS (local devnet) |

## Not done / blocked

- **Solidity settlement contract.** Not written. Foundry fuzz/invariant tests, static analysis, deployment and independent review are all NOT_RUN. CRY-10, CRY-11 and CRY-13 at contract level remain PARTIAL/NOT_RUN, and nothing here may be described as "audited".
- **Custody.** Only a local per-process signer exists; no KMS or multisig. Deployed signing fails closed. CRY-13 (admin pause/role compromise recovery) is NOT_RUN.
- **Payout execution runs inside the database transaction.** That is acceptable only for the in-process simulator. A real network needs an outbox worker with idempotent payout references before testnet use; this is NOT IMPLEMENTED.
- **Partial refunds of pool-funded hires.** Refused, with an operator case.
- **Testnet.** Arc testnet deposits and payouts are BLOCKED on verified network access and custody.
- **UI.** No pool UI; the user is building UI with Codex against `docs/UI_CONTRACT.md`.
