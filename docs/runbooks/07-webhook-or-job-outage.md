# Webhook or job outage

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Baseline `3bddff9`; concurrent P3 changes are unaccepted. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: engineering; finance owns unresolved money cases. HIGH if financial outcomes are unknown.

1. Inspect `/admin/operations`, `app.webhook_inbox` (processed_at, attempts), `app.provider_operations` (PENDING/UNKNOWN), `app.outbox` (FAILED/POISONED/stale PROCESSING), `app.notifications` and `/admin/cases`. Do not expose private payloads or signed tokens while correlating IDs.
2. On an incident an admin can disable `CHECKOUT_CREATION_ENABLED`, `BIDDING_ENABLED` and `PAYOUT_CREATION_ENABLED` from `/admin/flags`, each with a reason. These stop creation, not webhook ingestion, refunds or reconciliation. `LIVE_PAYMENTS_ENABLED` also needs the server environment gate; flipping a DB flag cannot supply live readiness.
3. For local fixtures use `pnpm jobs:dev` against the original Next process, or one `POST /api/dev/jobs` as documented in the index. Read every job's examined/outcomes counts; HTTP 200 is not a per-operation success. Current P3 job additions require Claude's integration before running the changed tree.
4. Finance/admin may retry via `/admin/operations` → `admin_retry_operation` with the original operation ID and reason. Persisted inbox/outbox replay keeps semantic identities. Outbox dispatch reclaims stale processing and parks poison messages; **NOT IMPLEMENTED:** a dedicated operator requeue-poison-outbox command. Preserve the case for engineering.
5. Use `/admin/cases` to assign a qualified operator and resolve only after matching provider facts and ledger/events. Mock Next restart loses provider-side history; retain missing-object cases. A standalone worker process cannot share the in-memory mock provider.

Verify no duplicate funding/release/refund or notification. `app.notifications` EMAIL_SINK never sends email. Inngest wiring, deployed scheduling, alerts, external-email sink and `reconcile:dry-run` are **NOT IMPLEMENTED**; dependencies/env fields alone do not provide them.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
