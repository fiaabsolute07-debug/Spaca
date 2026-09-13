# W2-B evidence: roles, audit, operator backend, feature flags (Claude, 2026-09-13)

Scope: master §14 (operator/admin), §13.3 error codes, §18 SEC-12, SEC-13, OPS-04, OPS-05, FND-05.
Environment: **local only**. Embedded PostgreSQL 18.4 on 127.0.0.1:55432 (`creator_marketplace_test`), the `MockPaymentProvider` as a local test provider, and the `app_server` DB role. No sandbox, testnet or live provider was used. No UI was built; the admin pages are a separate task.

## What changed

| Area | Change |
|---|---|
| Migration `drizzle/0005_roles_audit_flags.sql` | Adds `app.user_roles`: grant/revoke rows with reasons, one active grant per user and role. Privileged roles moved out of `users.roles`, and a CHECK now limits that column to `buyer`/`creator`. `audit_log` gains a required `reason`, an `actor_roles` snapshot, an append-only trigger and indexes, and `app_server` loses UPDATE/DELETE on it. Adds `app.feature_flags`, seeded per §14.4. Resolution and assignment columns added to `reconciliation_cases` and `disputes`, plus moderation columns on `samples`. |
| `src/lib/auth.ts` | The actor's roles are marketplace roles plus **active grants only**. |
| `src/modules/admin/policy.ts` | Adds `requireRole` (suspended actors are refused first), `reasonOf` (at least 10 chars) and `audit(...)`, which records actor, roles snapshot, before/after state and reason. `isFlagEnabled` treats a missing flag as disabled; `assertFlags` returns 422 `FEATURE_DISABLED`. |
| `src/modules/admin/commands.ts` | 11 operator commands. Each checks roles server-side, requires a reason and writes an audit row in the same transaction. |
| `src/modules/admin/queries.ts` | Adds `getOperatorQueues(actor)`, a role-scoped read model (details below), and `getAuditLog(actor, filter)`, available to finance and admin. |
| Command envelope | `admin_*` commands skip the buyer/creator requirement, and the role check happens inside the handler. The suspended allowlist was widened to existing-order commands (`submit_brief`, `request_cancellation`, `respond_cancellation`, `mark_delivery_viewed`). |
| Flags wired | `book` needs BOOKING and CHECKOUT_CREATION. `create_request`/`apply` need REQUESTS; `accept_offer` needs REQUESTS and CHECKOUT_CREATION. `create_auction` needs AUCTIONS, `bid` needs AUCTIONS and BIDDING, `buy_now` needs AUCTIONS and CHECKOUT_CREATION. `create_pool` needs TOKEN_REWARDS. `ensureFundingIntent` needs CHECKOUT_CREATION, `requestCreatorRelease` needs PAYOUT_CREATION. Webhooks, refunds, reconciliation and reads are intentionally **not** gated. |
| Fixtures/seed | The moderator, finance and admin personas get their roles through `user_roles` grants, not `users.roles`. |
| Notifications | New `dispute.resolved` template. |

`getOperatorQueues` scoping:
- **Finance, support or admin** see cases, review holds, provider operations (references redacted to the last 6 characters), failed outbox rows, RECONCILING reservations and overdue orders.
- **Moderators** see pending samples and a dispute list without amounts.

### Dispute outcomes (`admin_resolve_dispute`)

| Outcome | Who | Effect |
|---|---|---|
| `RESUME` | finance, support, admin | Order returns to `status_before_dispute`; a DELIVERED order gets a fresh review window. |
| `APPROVE` | finance, admin | Uses the same `approveOrder` path as the buyer, so the order becomes APPROVED with settlement READY. COMPLETED only follows a provider release. |
| `REFUND_FULL` | finance, admin | Order becomes CANCELLED with a full provider refund and the capacity is consumed. REFUNDED only follows the provider. |
| `REFUND_PARTIAL` | finance, admin | Refunds `refund_amount`, then the remainder is released through the provider. Result is CANCELLED + PARTIALLY_REFUNDED. |

Other rules:
- A dispute can be resolved only once; a second attempt returns 409.
- Admins cannot grant or revoke their own roles, or suspend themselves.
- Only an admin can suspend or reactivate another admin.
- `LIVE_PAYMENTS_ENABLED` cannot be turned on unless the server environment sets `LIVE_PAYMENTS_ENABLED=true`. The command returns 422.

## Test evidence

`RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run` gave **14 files, 160/160 passed**. That includes the new `tests/integration/admin.db.test.ts` with 10 tests.

`tsc --noEmit` exited 0. `scripts/release-check.ts` reported all static checks PASS; gates G3, G5, G6 and G7 stay NOT_RUN or BLOCKED.

| ID | Test | Result (local-mock) |
|---|---|---|
| SEC-12 | A moderator gets 403 on refund, money outcome, role grant and flag change, and the order is unchanged. A finance user with a short reason gets 400. Finance REFUND_FULL succeeds and writes an audit row with actor, roles snapshot, before-state and reason. Updating or deleting audit rows as `app_server` fails. | PASS (local-mock) |
| SEC-13 / SEC-04 | Body fields `actor_id=system`, `roles=admin,finance`, `system_actor`, `actor=SYSTEM` and `buyer_id` are ignored, so an outsider still gets 403. Writing `admin` into `users.roles` is rejected by the CHECK. | PASS (local-mock) |
| Roles | No self-grant. A grant gives access, a revoke removes it (the next command returns 403). Grant and revoke are audited in order. The queue read model refuses non-operators. | PASS (local-mock) |
| §7.2 disputes | RESUME covers both the support permission and the money-outcome denial, the fresh review window, and a 409 on the second resolve. APPROVE → release job → COMPLETED. REFUND_PARTIAL leads to PARTIALLY_REFUNDED, the remainder released and the reservation CONSUMED. | PASS (local-mock) |
| FND-05 | With AUCTIONS off, `create_auction` and `bid` return 422 through the direct API. No auction or bid rows are written, and the auction read model still loads. | PASS (local-mock) |
| OPS-04 | With CHECKOUT_CREATION and PAYOUT_CREATION off, `book` returns 422 and the payment page for an unpaid order returns 400. An in-flight funding webhook still funds its order. Buyer cancel → provider refund → REFUNDED still works, and so does reconciliation. Releases are held (`BLOCKED_UNAVAILABLE`) and the order stays APPROVED/READY. | PASS (local-mock) |
| OPS-05 | A provider accepts the funding create and then times out, leaving the operation UNKNOWN. It appears in the finance queue. `admin_retry_operation` reuses the same `operation_id`, ending in SUCCEEDED with a single journal row. The order state is not forced, and the retry is audited. | PASS (local-mock) |
| Moderation / suspension | A pending sample appears in the moderator queue, and the moderator's queue has no finance data. Approving records `moderated_by`. Self-suspension returns 403. A suspended creator cannot create a service, and reactivation works. | PASS (local-mock) |
| LIVE flag | Enabling it returns 422 and the flag stays false. | PASS (local-mock) |

## Not done / limits (honest)

- **No admin UI yet.** Command result paths point at `/admin/...` pages that do not exist. This is proposed as Codex task C6.
- Audit rows are written by application code inside the same transaction. The DB does not force every privileged mutation to have an audit row, although the audit table itself is append-only for `app_server`.
- Support tickets, incident records and staff 2FA/step-up (§14.2) are not implemented.
- Flags are read per command with no caching or propagation SLA. There is no staging evidence for kill-switch latency.
- Nothing here is evidence for sandbox or live payments. PAYMENT_READINESS rows remain BLOCKED.
