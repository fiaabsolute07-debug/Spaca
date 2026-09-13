# Staging and release operations

Status: **NOT_RUN** for every environment setup, deployment, migration rehearsal, restore and rollback procedure below. No staging environment exists. These are plans, not execution evidence. Historical local migration results are recorded separately in [Claude's evidence](evidence/claude-db-integration.md).

## Environment separation — master §19.1

| Component | Local/test | Staging/preview (NOT_RUN) | Production (NOT_RUN) |
|---|---|---|---|
| Database | Dedicated local/test PostgreSQL; fixtures only | Separate project and runtime/migration credentials | Separate project, restricted access, measured backups/retention |
| Payments | In-memory mock; optional sandbox separately gated | Provider sandbox; crypto testnet separately labeled | Eligible live rail after G6; mock routes absent |
| Storage | Test buckets/files | Separate staging buckets and keys | Separate public/private buckets; signed private access |
| Email | Local sink; no external delivery | Sink or explicit safe allowlist | Verified sender and approved recipient policy |
| Jobs | Local dev runner/test clock | Real scheduler, test side effects only | Durable scheduler, reconciliation and alerts |
| Analytics | Test-only | Staging-only | Exclude internal/test activity |
| Secrets | Ignored local environment | Staging secret store/access | Production secret store/access; never inherited by previews |

Never connect a preview to production DB, storage or keys. Without an isolated preview DB, allow read/demo only and disable critical mutations. CI uses a dedicated test DB; untrusted branches receive no production credentials. These separation controls still need implementation/verification.

## Configuration — master §19.2

Reference: [`.env.example`](../.env.example). It is a partial local template, not a complete staging contract. Do not copy its local URLs/passwords to a deployed environment or print secret values.

| Variables | Current template / remaining work (NOT_RUN) |
|---|---|
| `APP_ENV`, `APP_BASE_URL`, `NODE_ENV` | First two present; validate local/test/staging/production and the exact origin. `NODE_ENV` is not listed. |
| `DATABASE_URL`, `DATABASE_MIGRATION_URL` | Present; separate least-privilege runtime and privileged migration access per environment. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVER_SECRET_KEY` | Commented placeholders; auth and server-only secret verification pending. |
| `STORAGE_PUBLIC_BUCKET`, `STORAGE_PRIVATE_BUCKETS` | TODO template, storage integration and access tests. |
| `PAYMENT_PROVIDER`, `PAYMENT_MODE`, `LIVE_PAYMENTS_ENABLED`, `PLATFORM_FEE_BPS` | Last three present; provider selector TODO. Keep mock/sandbox/testnet/live separate; platform fee must equal 0. |
| `THIRD_PARTY_FEE_POLICY` → `FEE_PAYER_POLICY` | Master name maps to the current runtime's `FEE_PAYER_POLICY`; neither is in the template. Production must explicitly choose `CREATOR_AT_COST` or `PLATFORM_SUBSIDIZED`; do not introduce a second competing setting. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION` | First two commented; version TODO. Sandbox blocked without keys; live blocked by readiness. |
| `MOCK_PAYMENT_WEBHOOK_SECRET`, `MOCK_PROVIDER_FEE_BPS` | Existing local runtime knobs absent from template; mock fixtures only, never live credentials or fee quotes. |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | TODO scheduler configuration/integration; no deployed scheduler exists. |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_MODE`, `EMAIL_ALLOWED_RECIPIENTS` | TODO template and deployed delivery configuration. Use sink/allowlist until separately authorized. |
| `ARC_NETWORK_MODE`, `ARC_CHAIN_ID`, `ARC_RPC_URL`, `ARC_USDC_ASSET_CONFIG`, `ARC_SETTLEMENT_CONTRACT_ADDRESS`, `ARC_CONTRACT_VERSION`, `WALLET_PROVIDER_CONFIG` | TODO provider selection, testnet verification and chain/asset/contract validation; no live crypto enablement. |
| `SENTRY_DSN`, `SUPPORT_CONTACT`, `POLICY_VERSION` | TODO template/configuration; monitoring optional, real support/policy details required before live. |

Production startup/release validation must reject nonzero platform fees, mock commerce, live rails with test keys, invalid origin/chain/contract and live email without a sender. Never prefix a secret with `NEXT_PUBLIC_`. Full environment validation is TODO; the existing mock guard checks `NODE_ENV`, `PAYMENT_MODE` and `LIVE_PAYMENTS_ENABLED`, not `APP_ENV`. Explicitly gate deployed dev routes; do not assume the environment label alone protects them.

## Migration and deployment procedure (NOT_RUN)

1. Record candidate commit, ordered migration filenames, versions, flags, target project/domain/region and authorized release owner. Obtain a backup and verified restore point before significant migrations.
2. Review append-only `drizzle/NNNN_*.sql`. Run `./node_modules/.bin/tsx scripts/migrate.ts` with the target's privileged `DATABASE_MIGRATION_URL` supplied securely. Never omit it: the script has a local default. It sorts matching filenames, skips entries in `public.schema_migrations`, and applies each file plus its journal entry in one transaction. Never edit an already applied file.
3. Serialize migration runners in the release pipeline; the script does not supply a deployment-wide lock. Test a blank isolated DB, then rerun and verify skips. Separately upgrade a DB at the previous release, containing representative orders, reservations, ledgers and outbox rows; compare counts and invariants. Record both results. Do not seed production.
4. Deploy backward-compatible application code with new feature flags off. Register environment-specific webhooks and scheduler. Smoke auth, catalog, sandbox booking, workers, private upload/download permissions and bounded health checks. Health/deployment smoke execution is NOT_RUN.
5. Inspect logs, job backlog and reconciliation cases; enable only features whose gates pass. Live payments require G6. Record smoke results, limitations, monitoring window and rollback point.

No `db push`, reset, destructive down migration or production test fixtures. Do not pass production migration credentials to the web runtime or pull-request forks.

## OPS-02: restore rehearsal (NOT_RUN)

Owner: engineering; operator owns backup access, retention and recovery acceptance.

1. Select a timestamped backup and corresponding storage snapshot. Record cutoff, size, migration journal, retention and recovery timer. Restore into a new isolated DB/storage target with outbound money, email and effectful jobs disabled.
2. Check schema/version, row counts, foreign keys, asset references, reservation/capacity totals and ledger conservation per currency. Use integer amounts; platform fee remains 0%.
3. Inventory provider effects from the backup cutoff through the present. Compare operation IDs/references with restored `app.provider_operations`, `app.webhook_inbox`, `app.ledger_transactions`/`app.ledger_entries`, `app.order_events` and `app.outbox`. Reconstruct missing effects through reviewed domain reconciliation before allowing writes.
4. Rehearse inbox/job recovery without external effects and prove no duplicate charge, payout, refund or email. TODO: isolated replay harness and reconciliation dry-run command; `POST /api/dev/jobs` is effectful and is not a dry-run tool.
5. Record measured RPO/RTO, invariant results and redacted evidence. Proposed closed-beta targets are RPO ≤24 hours and RTO ≤4 hours, subject to hosting/backup capability; neither has been measured or promised. Do not promote while post-backup effects remain unresolved.

## OPS-03: rollback plan (NOT_RUN)

Owner: engineering; operator authorizes deployment and resumption of live activity.

1. Use expand-contract migrations; rehearse previous and candidate applications against the additive schema in isolation. Prove both preserve financial writes and process existing events correctly.
2. Define incident triggers: authorization leak, conservation breach, repeated worker failure or failed smoke check. Contain new checkout/bid/payout creation in the affected scope; retain safe webhook ingestion, reads and reconciliation. TODO: verified operator kill switches.
3. Roll back the application to the recorded compatible artifact. Keep financial schema/data; use a reviewed forward migration if compatibility prevents app rollback. Never remove financial columns or reset balances.
4. Reconcile operations and inbox/outbox across the release interval, rerun smoke/invariant checks and record the outcome before re-enabling writes. Never overwrite live DB with an older backup without accounting for external effects since cutoff.

See [restore/rollback runbook](runbooks/10-restore-and-rollback.md) and [release gates](RELEASE_CHECKLIST.md). No staging or production command in this plan was executed for C2.
