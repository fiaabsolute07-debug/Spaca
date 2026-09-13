# Crypto wrong chain or mixed payout

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: HIGH; engineering and finance operator; authorized custody owner for any signing.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

A supplied transaction hash does not match the intended chain/asset, or one CASH/TOKEN component is paid while another fails. Crypto recovery/testnet execution is NOT_RUN; no live crypto readiness is claimed.

## How to detect (read-only)

Locate the order and `app.reward_pools`, then correlate `app.provider_operations`, `app.webhook_inbox`, `app.reconciliation_cases`, `app.order_events`, `app.ledger_transactions`/`app.ledger_entries`, `app.reservations` and `app.outbox`. These baseline tables are not proof of complete multiasset accounting. TODO: durable allocation/component records, chain receipt/finality verifier and component-level recovery inspection.

## Safe steps

1. Keep crypto checkout/pool spending disabled until capability and security gates pass. Verify actual chain ID, contract/version, asset, decimals, recipient, amount and finality using the selected provider; a user-supplied hash is insufficient.
2. Classify wrong-chain/asset deposits as exceptions. Preserve evidence without promising recovery of assets outside platform control.
3. For mixed payouts, preserve the successful component and its unique operation; lookup then retry only the unresolved component with the same key. TODO: verified component retry tool, admin queue UI and operator retry command.
4. Compare on-chain holdings with pool funding, allocations, refunds and outflows per asset. Stop new spending on a conservation breach. The local five-job hook handles mock fiat/notifications, not chain recovery.

## Expected result and invariant check

Expected after future implementation: independently evidenced components, no double release, asset-by-asset conservation, capacity unchanged by unsupported deposits and platform fee 0%. Testnet and live must have separate accounts/configuration/evidence; this procedure has not run. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never repay a successful component, convert asset units implicitly, bypass finality or print/export a private key to debug.
