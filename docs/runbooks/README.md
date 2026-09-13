# Runbook index

Scope: master §20, P1C and OPS-08. All incident rehearsals here are **NOT_RUN**. Existing local mock tests are evidence for individual behaviors, not staging/live operational acceptance. Platform fee is always **0%**.

1. [Buyer charged; order not funded](01-buyer-charged-order-not-funded.md)
2. [Creator approved; funds not arrived](02-creator-approved-funds-not-arrived.md)
3. [Refund pending or requested after payout](03-refund-pending-or-after-payout.md)
4. [Capacity stuck in hold](04-capacity-stuck-in-hold.md)
5. [Auction ended; no winner](05-auction-ended-no-winner.md)
6. [Auto-accept and dispute race](06-auto-accept-dispute-race.md)
7. [Webhook or job outage](07-webhook-or-job-outage.md)
8. [Crypto wrong chain or mixed payout](08-crypto-wrong-chain-mixed-payout.md)
9. [Security or private data incident](09-security-private-data-incident.md)
10. [Restore and rollback](10-restore-and-rollback.md)

## Tools available today

For an isolated local mock fixture, use the same Next.js process that holds the in-memory provider:

```sh
curl --fail-with-body --request POST http://127.0.0.1:3000/api/dev/jobs
```

Verify the local target/port first. This is an effectful recovery hook, not a diagnosis or dry run; it can release all eligible mock settlements and expire holds. It accepts no per-order/job selector and runs, in order:

1. `reprocess_webhook_inbox`
2. `reconcile_provider_operations`
3. `expire_checkout_holds`
4. `release_ready_settlements`
5. `dispatch_notification_outbox`

Inspect each returned `reports` entry and its `outcomes`; HTTP success alone does not mean every operation recovered. Batches and age/retry limits can leave work pending. Notifications go to the in-app timeline and local email sink, not external email. Do not restart the process during a mock money recovery: provider memory is not durable across restarts.

The route rejects production `NODE_ENV`, non-mock payment mode and enabled live payments; browser Origin must match when supplied. Its guard does not check `APP_ENV`. Use only local fixtures; deployed dev-route exclusion and complete environment guards still require verification. No scheduler is wired. [Claude's evidence](../evidence/claude-db-integration.md) records 83/83 local PostgreSQL/mock tests; C2 did not execute this curl command or any job.

## Tools still TODO

- Admin queue UI: age, severity, owner, next action, restricted order/provider evidence and audited resolution.
- Operator retry command: scoped original operation/key, authorization, reason and audit. The internal job functions are not an operator CLI.
- Deployed scheduler, alert wiring, operator checkout/bid/payout kill switches, privileged audit/finance resolution, reconciliation dry-run and isolated restore replay.

Never substitute SQL UPDATE/DELETE for a missing recovery command. Diagnose read-only, preserve the case and escalate to its engineering/operator owner. Every runbook forbids forcing paid state, setting balances or retrying with a new key. Keep semantic event/operation identities stable. A later domain-created attempt after verified terminal non-application is a separate business attempt, not permission for an operator to invent a retry key.

Correlate `app.provider_operations.order_id`, `operation_id` and `provider_reference`; `app.reconciliation_cases.provider_operation_id` references the journal row's `id`. Inbox events carry event/payload identifiers; outbox links via `aggregate_id` and `semantic_key`. Inspect only necessary redacted fields. For ledger checks join `app.ledger_entries.transaction_id` to `app.ledger_transactions.id`, sum integer `amount_minor` per transaction/currency, and require zero; never net different assets/currencies together.

[Payment readiness](../PAYMENT_READINESS.md) · [Staging/restore plan](../STAGING.md) · [Release gates](../RELEASE_CHECKLIST.md)
