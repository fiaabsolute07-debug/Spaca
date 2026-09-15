# OPS-02 evidence: local restore rehearsal (Claude, 2026-09-15)

Scope: master §18 OPS-02 ("restore a backup into a new environment → verify counts, ledger and files, replay jobs as a dry run → data and invariants correct; no money or email sent again").

Environment: **local only**. Embedded PostgreSQL 18 on 127.0.0.1:55432, local filesystem storage. No staging, provider backups, PITR or remote storage. The embedded PostgreSQL has no `pg_dump`, so the rehearsal uses a repo-native logical backup.

## What was built

- **`pnpm restore:rehearsal`** (`scripts/restore-rehearsal.ts`), options `--source`, `--storage-root`, `--keep`, `--inject-fault`. Local only (refuses NODE_ENV=production).
  1. **Backup**: one REPEATABLE READ READ ONLY snapshot on the source records the obligations and backs up exactly that snapshot (`scripts/lib/logical-backup.ts`): migration list, every `app` table as binary COPY with columns, row count and SHA-256 in `manifest.json`; the stored file of every non-deleted asset, checked against its recorded SHA-256.
  2. **Restore**: a new isolated database `creator_marketplace_restore_<utc>`; schema from the normal migration runner; data loaded with triggers suspended (rows already passed their guards); NOT VALID constraints dropped for the load and re-added NOT VALID afterwards, as pg_dump does; sequences reset. Every file hash and row count is checked against the manifest; files go to an isolated storage root and are matched to their restored asset rows.
  3. **Verify** (`scripts/lib/restore-obligations.ts`), source snapshot versus restore:
     - 16 obligation sets: migrations, table counts, triggers, constraints and not-validated constraints, order money by status/payment/settlement/method/rail, ledger totals by account kind, provider operations, webhook inbox, outbox, holds, creator workloads, request budgets, chain payouts, pool buckets, reconciliation cases, payment disputes / refunds after release / cost adjustments.
     - 8 hard invariants that must be zero: unbalanced ledger transactions, workload counter drift, pool bucket conservation, oversold request budgets, order principal paid out beyond funding, orders released twice, orphan rows, duplicated confirmed chain payouts.
  4. **Jobs dry run**: what each background job would pick up as of the backup instant, computed without running anything, and required to be equal in the source and the restore.
  5. **Replay**: `scripts/lib/restore-replay.ts` runs as the app's own `app_server` role and refuses any database other than a `creator_marketplace_restore_*` copy. It pushes every processed webhook back through the application's normal processing path and fingerprints ledger, events, outbox, orders, cases and claims before and after.
  6. Drops the restored database and backup unless `--keep`.
- **Self-test**: `--inject-fault` deletes one ledger entry from the restored copy before verification.

## Results (2026-09-15, this machine)

| Run | Backup | Load | Files | Replay | Total | Result |
|---|---|---|---|---|---|---|
| dev `creator_marketplace` | 68 tables, 5,972 rows, 1.55 MB, 24 migrations, 151 ms | 251 ms | 14/14 copied and verified after restore | 96 events → 96 ALREADY_PROCESSED, nothing changed | 1.6 s | PASS |
| test `creator_marketplace_test` | 68 tables, 219,615 rows, 50.13 MB, 745 ms | 2.3 s | 346 assets have no file at the source (the integration suite writes to temporary storage); reported, nothing to restore | 3,836 events → all ALREADY_PROCESSED, nothing changed | 4.8 s | PASS |
| dev with `--inject-fault` | — | — | — | — | — | FAILED as expected: table counts, ledger totals and hard invariants differ; "unbalanced ledger transactions: 1" |

- All 8 hard invariants were 0 in both passing runs.
- Jobs dry run on dev, as of the backup instant: 5 settlements ready (the orders whose in-memory mock funding was lost at a dev server restart, see PAY-15/jobs notes), 2 notifications queued, nothing else. These have to be reconciled against provider and email logs before jobs are started on a restored environment.
- Problems found and fixed while building it:
  - piping COPY with backpressure stalled on a reserved connection, so the data is now drained with synchronous writes;
  - loading before NOT VALID constraints refused legacy PUBLISH/DIGITAL versions, so those constraints are re-added after the data;
  - claims of auctions without an order were first miscounted as orphans;
  - an unordered UNION made equal results compare as different.
- Measured local recovery time: 1.6–4.8 s for these datasets; the recovery point is the snapshot instant. These are not staging RPO/RTO figures.

## Limits

- Local logical backup, not provider backups/PITR/pg_dump; no WAL or point-in-time recovery.
- The in-memory mock payment provider and local devnet state are not part of an app database backup. The dry run lists the work that would touch them, but nothing proves remote provider state.
- No staging or production restore was run (the environment is BLOCKED); OPS-03 rollback rehearsal remains separate.
