# Restore and rollback

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: CRITICAL for data loss/conservation failure; engineering incident lead and authorized operator own promotion.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

Database corruption/loss, a failed deployment or incompatible schema requires recovery. OPS-02 restore and OPS-03 rollback are NOT_RUN; no staging environment exists.

## How to detect (read-only)

Record release/backup cutoff, `public.schema_migrations`, DB/storage identity and error window. Inventory `app.provider_operations`, `app.webhook_inbox`, `app.reconciliation_cases`, `app.reservations`, `app.outbox`, `app.ledger_transactions`/`app.ledger_entries` and `app.order_events`. Compare pre-incident counts and provider references; financial effects can exist after the latest backup.

## Safe steps

1. Follow [STAGING.md](../STAGING.md) OPS-02/03. Restore to an isolated DB/storage environment with live payments, outbound email and effectful jobs disabled. Record backup cutoff and start time.
2. Verify schema/version, foreign keys, counts, asset references, integer ledger conservation per currency and reservation/capacity totals. Platform fee remains 0%.
3. Inventory all provider effects from cutoff to present, including operations missing from the restored journal. TODO: reconciliation dry-run and isolated replay harness, admin queue UI and operator retry command. Do not use `POST /api/dev/jobs` as dry run: it executes all five effectful local jobs.
4. Prefer app rollback to a recorded artifact compatible with the additive schema, or a reviewed forward fix. Keep financial schema/writes intact. Rehearse old/new application compatibility before promotion.
5. Promote only after reviewed reconciliation proves no duplicated charge/payout/refund or notification and the operator authorizes target resumption. Measure RPO/RTO; proposed ≤24-hour RPO and ≤4-hour RTO are unverified targets, not commitments.

## Expected result and invariant check

Expected: isolated restore and compatible rollback with retained financial writes, all post-cutoff effects accounted for, and no external side effects during rehearsal. Attach measured timings, checks and unresolved cases before release; documentation alone does not pass OPS-02/03. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never restore an old DB over live money without reconciliation, run production db push/reset, delete financial columns in a down migration or replay live email/money during a rehearsal.
