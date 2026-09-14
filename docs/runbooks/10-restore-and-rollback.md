# Restore and rollback

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Procedure baseline `3bddff9`; P3 auction/job update verified at `90004fd` (see the index). Concurrent P4 changes are not verified here. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: engineering + infrastructure operator; CRITICAL for corruption or missing obligations. Staging/backup access is **BLOCKED**; OPS-02 restore and OPS-03 rollout/rollback rehearsal are **NOT_RUN**.

1. Record candidate/backup cutoff and inspect `public.schema_migrations`, `app.orders`, `app.provider_operations`, `app.webhook_inbox`, `app.ledger_transactions`, `app.ledger_entries`, `app.outbox`, `app.workload_claims`, `app.creator_workloads`, `app.request_budget_reservations`, `app.storage_assets` and `app.delivery_assets` read-only. Keep schema and file snapshot identities together.
2. Follow [STAGING.md](../STAGING.md) for the isolated-target plan. `scripts/migrate.ts` / `pnpm db:migrate` exists; backup capture/restore, app artifact rollback and isolated external-effect replay commands are **NOT IMPLEMENTED** in this repository. Do not invent a runnable restore command before the target/provider tooling is chosen.
3. On an existing app `/admin/flags` can stop new checkout/bid/payout creation with reasons. This preserves webhook/refund/reconciliation obligations; it does not isolate a restored clone from external side effects. Restore testing needs a separate isolated target and sinks, with jobs stopped.
4. In a provisioned isolated target, check `app.workload_counter_drift` is empty, request held/committed budgets against reservations, per-currency ledger balance, file hashes/references, event/outbox IDs and audit history. Pre-0007 request counters have a known backfill gap; do not infer complete historical budget conservation.
5. Match provider effects after backup cutoff before allowing replay. `/admin/operations` retries and `POST /api/dev/jobs` are effectful; **reconcile:dry-run and isolated replay are NOT IMPLEMENTED**. Do not run them as restore validation against live credentials.
6. Review previous/candidate app compatibility against additive migrations; retain financial schema/writes. No compatible rollback rehearsal is recorded. After future implementation record measured RPO/RTO and unresolved cases before promotion. Proposed RPO ≤24h/RTO ≤4h are unmeasured targets.

Verify no external money/email effects during rehearsal and no duplicate effects afterward. Do not overwrite a live database with an older snapshot or perform destructive down migrations. Documentation does not pass G4/G5 or OPS-02/03.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
