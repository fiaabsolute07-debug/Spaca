# Crypto wrong chain or mixed payout

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Baseline `3bddff9`; concurrent P3 changes are unaccepted. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: engineering and the future authorized custody operator. P4 is **TODO**; testnet/live provider access is **BLOCKED**. No crypto recovery has been executed.

1. An admin can inspect `/admin/flags` and keep `CRYPTO_CHECKOUT_ENABLED`, `TOKEN_REWARDS_ENABLED` and `NFT_REWARDS_ENABLED` disabled with an audited reason. The local fiat mock is not a chain verifier.
2. Read existing `app.reward_pools`, `app.orders`, `app.provider_operations` and `app.reconciliation_cases` only as baseline records. If a case already exists, assign it on `/admin/cases`. There is no implemented chain receipt/finality inspection page, indexer, per-asset allocation ledger, mixed-component retry command or custody recovery tool.
3. Preserve any supplied transaction reference as unverified evidence. Do not mark funded, promise recovery, or use `/api/dev/jobs` / `admin_retry_operation` as crypto settlement tools; they reconcile the mock fiat provider.
4. Record the missing verifier/component tooling and owner in engineering handoff. Before future execution, P4 must implement chain/token/recipient/order/finality checks and per-asset conservation; those are requirements, **NOT IMPLEMENTED** commands.

Future acceptance must prove only the failed component retries, confirmed unallocated assets alone are refundable, and unsupported tokens cannot break conservation. No implicit currency conversion, invented USD valuations or mainnet inference from testnet. Do not print custody keys.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
