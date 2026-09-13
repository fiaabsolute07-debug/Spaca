# Operational runbooks

Updated 2026-09-14. Accepted baseline **3bddff9**; Claude is concurrently implementing P3. These are local operating instructions and unexecuted incident plans. Evidence: [W1-B](../evidence/claude-W1-B.md), [W2-B](../evidence/claude-W2-B.md), [W2-S](../evidence/claude-W2-S.md), [W3-R](../evidence/claude-W3-R.md), [C6 review](../evidence/claude-review-C6.md). Latest full suite: 184/184, 17 files with DB suites enabled, tsc 0; C3 did not run jobs or incident rehearsals. Platform fee **0%**.

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

Use the actual dev port. Existing `pnpm jobs:dev` polls loopback every 30 seconds by default; `JOBS_DEV_URL` selects the origin and `JOBS_DEV_INTERVAL_SECONDS` must be at least 5. Neither command ran in C3. The route accepts no job/order selector, is effectful, and refuses non-mock/production/enabled-live payment modes; supplied Origin must match. `APP_ENV` alone is not its runtime guard. Do not run the changing P3 tree until Claude integrates it.

Read directly from `runJobsOnce` in `src/modules/jobs/index.ts` during C3 (ordered calls):

| Order | Function | Report name | Evidence scope |
|---|---|---|---|
| 1 | reprocessWebhookInbox | reprocess_webhook_inbox | DB baseline replay |
| 2 | reconcileProviderOperations | reconcile_provider_operations | DB/W2-B mock lookup/retry |
| 3 | expireCheckoutHolds | expire_checkout_holds | DB baseline safe unpaid release |
| 4 | expireHireOffers | expire_hire_offers | W3-R OFFERED expiry/budget release |
| 5 | closeDueAuctions | close_due_auctions | **Concurrent P3 addition: NOT_RUN in allowed evidence** |
| 6 | autoAcceptDeliveries | auto_accept_deliveries | W1-B consent/view/window; W2-S file validity |
| 7 | releaseReadySettlements | release_ready_settlements | DB/W1-B release then COMPLETED |
| 8 | sendOrderReminders | order_reminders | W1-B due/review/overdue |
| 9 | dispatchNotificationOutbox | dispatch_notification_outbox | DB dedupe, local sink, poison handling |
| 10 | cleanupStorage | cleanup_storage | W2-S abandoned/unattached cleanup |

The accepted baseline has **nine jobs**, excluding `closeDueAuctions`; the current working tree has ten after Claude's concurrent addition. This source inventory grants no P3 acceptance. Re-read this function after integration before updating the runbook; do not infer an auction job from an old list or a package dependency.

Read each returned `reports` entry, `examined` and `outcomes`; HTTP success alone is insufficient. Batches/retry ages can leave pending work. Mock provider state is in memory: use the original process; Next restart loses provider history. `app.notifications` persists in-app delivery and EMAIL_SINK; it does not send email. `admin_retry_operation` takes the original operation ID but reconciles its associated order (potentially several operations), not a guaranteed single-row retry.

For read-only diagnosis join `app.provider_operations.order_id` to orders; a case's `provider_operation_id` references journal `id`, while retries take journal `operation_id`. Sum integer `app.ledger_entries.amount_minor` by transaction/currency (join `app.ledger_transactions.id`), never across currencies. Bucket counters derive from reservation states; request budget/count counters derive from budget reservations. Use `/admin/cases` for audited assignment/resolution, not SQL force-state updates.

**NOT IMPLEMENTED:** Inngest integration/deployed scheduling, alert wiring, real payment and Supabase Storage adapters, antivirus, external email delivery, `reconcile:dry-run`, backup/restore replay CLI, dedicated poisoned-outbox retry and general ReviewHold clear command. Installed dependencies/config placeholders are not working integrations. See [staging plan](../STAGING.md) and [release gates](../RELEASE_CHECKLIST.md).
