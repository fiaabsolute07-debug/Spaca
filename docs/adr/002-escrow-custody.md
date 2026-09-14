# ADR 002: Non-custodial escrow on Arc (model A) and key roles

Status: accepted by the product owner on 2026-09-15 for testnet. Mainnet remains gated (master §11.7).

## Decision

Buyer funds for crypto orders and campaign pools are held in the `SpacaEscrow` contract (`contracts/src/SpacaEscrow.sol`), not in a spaca-controlled wallet or database balance.

- **Buckets.** Each order has its own bucket: `escrowReference('order', orderId)`. Each campaign pool has one bucket per asset: `escrowReference('pool', poolId:poolAssetId)`. A bucket holds a single ERC-20 token and remembers the wallet that first funded it.
- **Ways out.** Funds leave a bucket only through:
  1. a release signed by the release signer, capped by what the bucket holds, with each payout reference paid once;
  2. a refund signed by the release signer, which always goes to the funding wallet;
  3. the payer's own `reclaim` after the bucket's reclaim time (60 days on testnet), unless the bucket is frozen for a dispute. This works even while the contract is paused.
- **No owner access.** The owner has no withdrawal or transfer function.
- **Payout outbox.** The server never calls the chain inside a database transaction. Business transactions queue `app.chain_payouts`, and the `dispatch_chain_payouts` worker signs, submits and reconciles them (`src/modules/crypto/payouts.ts`).

This is **not trustless** and must never be marketed as trustless: the release signer decides who is paid.

## Roles

| Role | Holds | Can | Cannot | Testnet | Before real money |
|---|---|---|---|---|---|
| Owner | no funds | allowlist tokens, rotate signer/guardian, set reclaim delay for new buckets, unpause | move escrowed funds | generated deployer key in `contracts/.env.local` (git-ignored) | multisig; two-step transfer (`acceptOwnership`) |
| Guardian | no funds | pause; freeze a bucket in an incident | unpause; move funds | same as owner | separate on-call key/multisig |
| Release signer | no funds | authorize releases/refunds/freezes (EIP-712, chain + contract + bucket + payout + nonce + expiry bound) | exceed a bucket's balance; refund to anyone but the payer | `RELEASE_SIGNER_PRIVATE_KEY` env, local only; `getReleaseSigner()` refuses production | managed key (KMS/HSM) with audit log; NOT IMPLEMENTED |
| Executor (relayer) | gas only | submit signed authorizations | authorize anything | `CHAIN_EXECUTOR_KEY_<chainId>` env | secret store; low balance alerts |

## Consequences

- A compromised release signer can redirect unreleased buckets up to their balance. Mitigations:
  - the guardian pauses (payer reclaim still works) and the owner rotates the signer;
  - payouts are queued per business event and audited in `release_authorizations`;
  - the worker never re-signs an UNKNOWN payout before checking the chain.
- A dispute freezes the order bucket (`FREEZE` payout) so the payer cannot reclaim mid-dispute; resolution queues `UNFREEZE` before the release or refund.
- Pool buckets are not frozen per hire, because other hires draw from them.
- Micro budgets: `releaseBatch` exists in the contract. The worker currently submits one release per transaction; batching is a follow-up once gas data from Arc testnet exists.
- Bank off-ramp and user balances from §11.7's first draft are not built. Withdrawals are releases to verified wallets; off-ramp needs a licensed partner.

## Before mainnet (all open)

- Independent security review (Foundry unit/fuzz/invariant tests and `forge lint` are not an audit).
- Multisig owner and guardian.
- Managed signer with rotation runbook.
- Arc mainnet availability re-verified.
- Legal review of holding funds in escrow for users.
- `chain_networks_mainnet_blocked` CHECK lifted only by a reviewed migration. `scripts/release-check.ts` fails if a migration enables MAINNET.
