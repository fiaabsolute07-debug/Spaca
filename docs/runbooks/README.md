# Operational runbooks

Updated 2026-09-14. Accepted local baseline **90004fd**; P3 done-local, P4 in progress (Claude). These are local operating instructions and unexecuted incident plans. Evidence: [W1-B](../evidence/claude-W1-B.md), [W2-B](../evidence/claude-W2-B.md), [W2-S](../evidence/claude-W2-S.md), [W3-R](../evidence/claude-W3-R.md), [W4-A](../evidence/claude-W4-A.md). Latest full suite: **195/195, 18 files with DB suites enabled, tsc 0 at 90004fd** (includes unit/provider tests). C3c did not run jobs or incident rehearsals. Platform fee **0%**.

1. [Buyer charged; order not funded](01-buyer-charged-order-not-funded.md)
2. [Creator approved; funds not arrived](02-creator-approved-funds-not-arrived.md)
3. [Refund pending or requested after payout](03-refund-pending-or-after-payout.md)
4. [Capacity stuck in hold](04-capacity-stuck-in-hold.md)
5. [Auction ended; no winner](05-auction-ended-no-winner.md)
6. [Auto-accept, dispute and mutual cancellation](06-auto-accept-dispute-race.md)
7. [Webhook or job outage](07-webhook-or-job-outage.md)
8. [Crypto wrong chain or mixed payout](08-crypto-wrong-chain-mixed-payout.md)
9. [Security or private data incident](09-security-private-data-incident.md)
10. [Restore and rollback](10-restore-and-rollback.md)

Existing operator pages: `/admin`, `/admin/disputes`, `/admin/cases`, `/admin/operations`, `/admin/moderation`, `/admin/users`, `/admin/flags`, `/admin/audit`, `/admin/orders/[orderId]`. Active `app.user_roles` grants authorize server commands; ordinary marketplace roles do not confer privilege. Forms post to `/api/commands` with an idempotency key and a **10–2000 character reason**. `app.audit_log` is append-only. Finance/admin performs money retry/refund; support can assign/resolve cases and RESUME disputes; moderator/admin handles samples/quarantine; admin manages roles/flags. Page visibility is not permission for every action.

At `/admin/flags`, `CHECKOUT_CREATION_ENABLED`, `BIDDING_ENABLED` and `PAYOUT_CREATION_ENABLED` stop new creation. Webhooks, refunds and reconciliation continue. `LIVE_PAYMENTS_ENABLED` cannot turn on unless the server environment also sets it true; G6 eligibility remains required and no real payment adapter exists.

For an isolated local mock fixture in the original Next process, the existing single-run hook is:

```sh
curl --fail-with-body --request POST http://127.0.0.1:3000/api/dev/jobs
```

Use the actual dev port. Existing `pnpm jobs:dev` polls loopback every 30 seconds by default; `JOBS_DEV_URL` selects the origin and `JOBS_DEV_INTERVAL_SECONDS` must be at least 5. Neither command ran in C3c. The route accepts no job/order selector, is effectful, and refuses non-mock/production/enabled-live payment modes; supplied Origin must match. `APP_ENV` alone is not its runtime guard. Claude owns running the hook against the integrated local tree; it is not scoped to auctions.

Local inventory from `runJobsOnce` in `src/modules/jobs/index.ts`, with W4-A evidence for the auction addition (ordered calls):

| Order | Function | Report name | Evidence scope |
|---|---|---|---|
| 1 | reprocessWebhookInbox | reprocess_webhook_inbox | DB baseline replay |
| 2 | indexChainDeposits | chain_indexer | W5-C1 simulated devnet finality/reorg |
| 3 | reconcileProviderOperations | reconcile_provider_operations | DB/W2-B mock lookup/retry |
| 4 | expireCheckoutHolds | expire_checkout_holds | DB baseline safe unpaid release; W7-CAP workload claims |
| 5 | expireHireOffers | expire_hire_offers | W3-R OFFERED expiry/budget release |
| 6 | closeDueAuctions | close_due_auctions | **Verified local-db+mock: W4-A AUC-05/06 concurrent no-bid/winner close** |
| 7 | autoAcceptDeliveries | auto_accept_deliveries | W1-B consent/view/window; W2-S file validity |
| 8 | releaseReadySettlements | release_ready_settlements | DB/W1-B release then COMPLETED |
| 9 | sendOrderReminders | order_reminders | W1-B due/review/overdue |
| 10 | dispatchNotificationOutbox | dispatch_notification_outbox | DB dedupe, local sink, poison handling |
| 11 | cleanupStorage | cleanup_storage | W2-S abandoned/unattached cleanup |
| 12 | checkWorkloadCounters | check_workload_counters | W7-CAP: opens one HIGH case when `app.workload_counter_drift` has rows; never repairs |

The local tree has **twelve jobs** (`extend_capacity_horizon` from W6-D was removed in W7-CAP). `close_due_auctions` starts due SCHEDULED auctions and closes due ones: no bids → NO_BIDS; a winner gets one pending order with a 24 h hold, funding → SETTLED, unpaid expiry → WINNER_DEFAULTED. See [runbook 05](05-auction-ended-no-winner.md) for `cancel_auction`, `admin_invalidate_bid` and `GET /api/auctions/{id}/snapshot`. Re-read the inventory after P4 integration; these results do not verify future jobs or deployed scheduling.

Read each returned `reports` entry, `examined` and `outcomes`; HTTP success alone is insufficient. Batches/retry ages can leave pending work. Mock provider state is in memory: use the original process; Next restart loses provider history. `app.notifications` persists in-app delivery and EMAIL_SINK; it does not send email. `admin_retry_operation` takes the original operation ID but reconciles its associated order (potentially several operations), not a guaranteed single-row retry.

For read-only diagnosis join `app.provider_operations.order_id` to orders; a case's `provider_operation_id` references journal `id`, while retries take journal `operation_id`. Sum integer `app.ledger_entries.amount_minor` by transaction/currency (join `app.ledger_transactions.id`), never across currencies. Bucket counters derive from reservation states; request budget/count counters derive from budget reservations. Use `/admin/cases` for audited assignment/resolution, not SQL force-state updates.

**NOT IMPLEMENTED:** Inngest integration/deployed scheduling, alert wiring, real payment and Supabase Storage adapters, antivirus, external email delivery, `reconcile:dry-run`, backup/restore replay CLI, dedicated poisoned-outbox retry and general ReviewHold clear command. Installed dependencies/config placeholders are not working integrations. See [staging plan](../STAGING.md) and [release gates](../RELEASE_CHECKLIST.md).
