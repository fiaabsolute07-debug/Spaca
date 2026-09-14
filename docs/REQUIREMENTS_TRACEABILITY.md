# Requirements traceability

As of 2026-09-14; all **80** master §16 task IDs. Baseline **90004fd**; platform fee always **0%**. Claude coordinates, runs DB/browser suites and commits; Codex is dispatched via `codex exec`.

Phase delivery: P0/P1A done-local; P1B done-local with mock provider (sandbox/live BLOCKED); P1C docs done (staging/live BLOCKED); P2 done-local with REQ-11 PARTIAL; P3 done-local; P4 IN_PROGRESS (Claude); P5–P6 TODO. These phase labels do not imply every subtask or §18 row is complete.

`DONE-local` means the listed local task scope is delivered and evidenced, not sandbox/live readiness or every linked acceptance ID passing. `PARTIAL` preserves a missing part of the master task; `TODO` is unaccepted phase work (P4 is in progress); `BLOCKED` identifies missing external prerequisites. Paths are existing implementation or explicitly planned. Exact test provenance/status is in [ACCEPTANCE.md](ACCEPTANCE.md); only its approved evidence sources and git history support status. Latest full run: 195/195, 18 files with DB suites enabled, tsc 0 at `90004fd` ([W4-A](evidence/claude-W4-A.md)); no C3c application test rerun.

| Master task | Implementation path(s) | Acceptance IDs | Status | Gap / evidence scope |
|---|---|---|---|---|
| P0-01 | docs/evidence/p0-foundation.md; docs/HANDOFF.md | FND-01 | DONE-local | P0 audit and git/config record; clean-clone acceptance separate. |
| P0-02 | docs/PRODUCT_SPEC.md; docs/REQUIREMENTS_TRACEABILITY.md | PAY-01, PAY-18, OPS-08 | DONE-local | P0 spec + C3 complete master mapping; product gates remain separate. |
| P0-03 | package.json; pnpm-lock.yaml; .node-version | FND-01, FND-02 | PARTIAL | Pinned runtime/lock; C4 frozen install/CI execution NOT_RUN. |
| P0-04 | src/app/; src/components/; scripts/lib/env-rules.ts | FND-01, SEC-11, OPS-07 | DONE-local | C1 explicit App Router segments, shell/error boundaries and tsc/build. |
| P0-05 | src/lib/auth.ts; src/lib/db.ts; src/app/api/auth/; drizzle/0001_marketplace.sql | SEC-01–04, SEC-08, FND-04 | PARTIAL | Local PostgreSQL roles/auth pass; Supabase auth/Data API environment missing. |
| P0-06 | drizzle/0001_marketplace.sql; drizzle/0002_notifications.sql; scripts/migrate.ts | FND-02, SEC-03, PAY-01 | DONE-local | DB/W1-A blank and populated upgrade, durable core schema. |
| P0-07 | src/lib/commands.ts; src/lib/db.ts; src/modules/commands.ts; src/modules/payments/providers.ts | PAY-05, PAY-17, CAP-01, SEC-04 | PARTIAL | Local auth/money/idempotency/races pass; full boundary matrix remains. |
| P0-08 | src/lib/fixtures.ts; scripts/seed.ts; src/app/api/dev/session/; src/app/admin/ | FND-04, FND-07, SEC-08 | PARTIAL | W2-B role grants; W1-B/W3-R/C6 fixture sessions; full auth flows unverified. |
| P0-09 | src/modules/storage/; src/modules/notifications/; src/modules/jobs/ | FND-06, SEC-05, OPS-01 | PARTIAL | W2-S upload intents + DB sink/outbox pass; Inngest NOT IMPLEMENTED. |
| P0-10 | src/modules/payments/providers.ts; tests/providers.test.ts | PAY-05, PAY-07–10, PAY-13, PAY-14, PAY-17, PAY-18 | DONE-local | Provider contract unit suite; mock duplicate/out-of-order/timeout coverage. |
| P0-11 | .github/workflows/ci.yml; scripts/env-check.ts; scripts/release-check.ts; README.md | FND-01, FND-02, OPS-08 | PARTIAL | C4 env/release scripts and CI authored; clean clone/frozen CI NOT_RUN. |
| P1A-01 | src/modules/catalog/commands.ts; src/app/settings/profile/; src/app/sign-up/ | FND-04, SEC-07, SUP-06, XPL-01 | PARTIAL | Profile/URL/timezone and fixture journeys; complete onboarding unverified. |
| P1A-02 | src/modules/storage/; src/modules/catalog/commands.ts; drizzle/0006_storage_assets.sql | SUP-01, SEC-06, SEC-14 | PARTIAL | W2-S upload/scope/moderation tests; sample upload UI and Supabase missing. |
| P1A-03 | src/modules/catalog/commands.ts; drizzle/0003_supply_capacity.sql | SUP-03, SUP-04, MOD-02, XPL-02, XPL-03 | PARTIAL | W1-A immutable service versions; PUBLISH/ACCESS phase work TODO. |
| P1A-04 | scripts/seed.ts; docs/PRODUCT_SPEC.md | SUP-05, SUP-06, ORD-05 | PARTIAL | Seed SKU present; complete template/checkout terms acceptance not recorded. |
| P1A-05 | src/modules/capacity/; drizzle/0003_supply_capacity.sql | CAP-01–12 | PARTIAL | Weekly bucket transaction tests; per-slot model and full race matrix absent. |
| P1A-06 | src/lib/read-model.ts; src/modules/orders/lifecycle.ts; src/app/creators/; src/app/services/ | SUP-02, SUP-06, REV-03, DSC-01, DSC-04 | PARTIAL | W1-A honest read model; W1-B test-excluded reputation; OG/share checks absent. |
| P1A-07 | src/modules/catalog/commands.ts; src/lib/read-model.ts | SUP-01, SUP-04, SEC-10 | PARTIAL | Publish/pause/archive tested; complete conflict UI coverage absent. |
| P1A-08 | tests/integration/supply.db.test.ts; tests/unit/weeks.test.ts | CAP-01, CAP-02, CAP-07, CAP-08 | DONE-local | W1-A 20 concurrent buyers/shared pool/DST and exclusion tests. |
| P1B-01 | src/modules/catalog/commands.ts; src/modules/orders/commands.ts; src/modules/capacity/; src/modules/payments/funding.ts | ORD-01, SUP-03, CAP-01, PAY-05 | DONE-local | W1-A/W1-B booking snapshot/consent/hold and local funded journey; free-text brief. |
| P1B-02 | src/app/api/dev/mock-checkout/; src/modules/payments/providers.ts | PAY-04–06, PAY-12 | BLOCKED | Mock checkout works; hosted provider sandbox adapter/credentials missing. |
| P1B-03 | src/modules/payments/funding.ts; src/app/api/webhooks/mock-payment/ | PAY-07–10, PAY-20 | DONE-local | DB verified mock inbox, replay/order independence and ledger; sandbox BLOCKED. |
| P1B-04 | src/modules/orders/lifecycle.ts; src/modules/payments/funding.ts; src/lib/read-model.ts | ORD-02–04, CAP-03, CAP-04 | DONE-local | W1-B fixed work clock, funding commits capacity and queues action. |
| P1B-05 | src/modules/orders/; src/modules/storage/; src/app/orders/; src/components/order-workspace/ | ORD-05–08, SEC-01, SEC-02, SEC-05 | DONE-local | W1-B versions/revision/approve + W2-S private files, local browser delivery. |
| P1B-06 | src/modules/orders/commands.ts; src/modules/jobs/ | ORD-09–16, CAP-12 | PARTIAL | Auto-accept/ReviewHold/mutual cancellation pass locally; notification and race gaps. |
| P1B-07 | src/modules/payments/funding.ts; src/modules/jobs/ | PAY-01–03, PAY-11, PAY-12, PAY-19, PAY-20 | PARTIAL | Mock release/cost/reconcile; real bank payout and external journal boundary missing. |
| P1B-08 | src/modules/admin/commands.ts; src/modules/orders/commands.ts; src/modules/payments/funding.ts | PAY-13–16, CAP-05, ORD-13, ORD-15 | PARTIAL | W1-B/W2-B full/partial audited refunds; post-transfer deficits/late-cost gaps. |
| P1B-09 | src/modules/orders/lifecycle.ts; src/modules/orders/commands.ts | REV-01–03, OPS-06 | PARTIAL | W1-B review eligibility/dedupe/on-time counts; repeat/weekly aggregates incomplete. |
| P1B-10 | tests/integration/; tests/e2e/ (C5 authored; NOT_RUN) | ORD-01, ORD-10, PAY-11, PAY-13, OPS-07 | PARTIAL | W1-B browser booking and DB races; C5 E2E/mobile authored, execution NOT_RUN; keyboard coverage remains TODO. |
| P1C-01 | docs/STAGING.md; docs/runbooks/10-restore-and-rollback.md | OPS-02, OPS-03 | PARTIAL | C2/C3 staging/restore/rollback docs done; rehearsal environment BLOCKED. |
| P1C-02 | docs/PAYMENT_READINESS.md; docs/STAGING.md; src/modules/jobs/ | FND-06, PAY-12, PAY-19, OPS-01 | BLOCKED | Readiness docs exist; hosting/provider access and deployed jobs/alerts absent. |
| P1C-03 | docs/PAYMENT_READINESS.md; docs/RELEASE_CHECKLIST.md; src/modules/payments/funding.ts | PAY-02–04, PAY-16, OPS-08 | PARTIAL | C2 policy/cost checklist; real entity, reserve and provider decisions missing. |
| P1C-04 | src/modules/admin/; src/app/admin/; src/components/admin/ | SEC-12, SEC-13, OPS-04, OPS-05 | DONE-local | W2-B/C6 audited queues, role-scoped pages, DB tests and browser matrix. |
| P1C-05 | Creator onboarding runbook/consent records (planned) | SUP-01, SUP-02, OPS-05 | TODO | Three real creators, consent records and onboarding runbook not evidenced. |
| P1C-06 | Buyer journey/outreach draft (planned) | ORD-01, OPS-07 | TODO | Buyer outreach/journey draft for authorized operator not evidenced; no sending. |
| P1C-07 | docs/RELEASE_CHECKLIST.md; docs/PAYMENT_READINESS.md; docs/ACCEPTANCE.md | OPS-08, FND-01, FND-02 | PARTIAL | C2/C3 gates and C4 checks; staged release-candidate evidence BLOCKED. |
| P1C-08 | docs/evidence/ (future authorized real transaction record) | OPS-06; G7 (no dedicated §18 market ID) | BLOCKED | Authorized live rail/buyer/transaction evidence absent. |
| P2-01 | src/modules/requests/commands.ts; drizzle/0007_requests_v2.sql; src/app/buyer/requests/new/ | REQ-01, REQ-10 | DONE-local | W3-R request version/deadline/budget/count tests and browser form. |
| P2-02 | src/modules/requests/commands.ts; src/lib/read-model.ts; drizzle/0007_requests_v2.sql | REQ-01–04 | DONE-local | W3-R private versioned quotes, samples snapshot and expiry tests. |
| P2-03 | src/app/requests/[id]/page.tsx; src/lib/read-model.ts | REQ-03, REQ-11 | PARTIAL | REQ-11: manual comparison exists; no sort/filter controls. |
| P2-04 | src/modules/requests/commands.ts; src/modules/capacity/ | REQ-05–07, REQ-09, CAP-10 | PARTIAL | W3-R budget/count/capacity plan tests; true expiry/funding race absent. |
| P2-05 | src/modules/requests/commands.ts; src/modules/payments/funding.ts | REQ-06, REQ-09, ORD-01, PAY-01 | DONE-local | W3-R one canonical order per accepted offer; mock funding browser pass. |
| P2-06 | src/lib/read-model.ts; src/modules/requests/commands.ts | REQ-08, REQ-10 | DONE-local | W3-R campaign refund/lapse aggregates and close preserve existing hires. |
| P2-07 | src/modules/jobs/index.ts; src/modules/notifications/; drizzle/0007_requests_v2.sql | REQ-07, REQ-08, CAP-10, OPS-06 | PARTIAL | Offer expiry/notifications/full-refund budget sync; hires/application analytics missing. |
| P2-08 | tests/integration/requests.db.test.ts; tests/integration/commands.db.test.ts; tests/e2e/ (C5 authored; NOT_RUN) | REQ-01–11, CAP-10 | PARTIAL | W3-R stale/double/concurrent DB tests; multi-hire E2E and timer races absent. |
| P3-01 | src/modules/auctions/commands.ts; drizzle/0008_auctions_v2.sql; src/app/creator/auctions/new/ | AUC-01, CAP-09 | PARTIAL | W4-A AUC-01: exclusive capacity, scheduling and frozen terms tested; seller payout readiness check still missing. |
| P3-02 | src/modules/auctions/commands.ts; drizzle/0008_auctions_v2.sql; src/lib/read-model.ts | AUC-02–04, AUC-09 | DONE-local | W4-A AUC-02–04/08/09: transactional minimum/sequence, time/actor guards, invalidation and pseudonymous accepted history. |
| P3-03 | src/lib/read-model.ts; src/app/api/auctions/[id]/snapshot/; src/components/auctions/auction-live-panel.tsx | AUC-03, AUC-13 | DONE-local | W4-A AUC-13 snapshot/version/standing API and manual ≤6.5 s outbid polling; polling is the transport. C5 E2E authored, not run; reconnect/sleep journey remains. |
| P3-04 | src/modules/auctions/commands.ts; src/modules/jobs/; drizzle/0008_auctions_v2.sql | AUC-05, AUC-06, AUC-10 | DONE-local | W4-A AUC-05/06/10: concurrent close_due_auctions and seller close produce one intent/order, 24 h winner hold, NO_BIDS/default release. |
| P3-05 | src/modules/auctions/commands.ts; src/modules/capacity/; drizzle/0008_auctions_v2.sql | AUC-07–09, AUC-11, AUC-12, CAP-09 | DONE-local | W4-A AUC-07–09/11/12: first bid versus Buy Now/cancel, no re-enable after invalidation, 15 min Buy Now hold and no reopening. |
| P3-06 | src/modules/auctions/commands.ts; src/modules/payments/funding.ts; drizzle/0008_auctions_v2.sql | AUC-10, AUC-14, CAP-05 | DONE-local | W4-A AUC-06/10/14: mock funding → SETTLED, unpaid → WINNER_DEFAULTED, late-funding case, no runner-up charge. Sandbox/live unverified. |
| P3-07 | src/lib/read-model.ts; src/modules/notifications/; src/app/auctions/; src/app/dashboard/ | AUC-13, OPS-06 | PARTIAL | W4-A: My bids, seller auctions and in-app outbid notification delivered. Metrics (≥3 bidders/uplift) NOT IMPLEMENTED; no separate outbid email. |
| P3-08 | tests/integration/auctions.db.test.ts; tests/integration/jobs.db.test.ts; tests/e2e/auction.spec.ts | AUC-02–14, CAP-09 | DONE-local | W4-A: 11 auction DB tests, AUC-01..14 table PASS local-mock; full run 195/195, 18 files at 90004fd. Multi-user E2E authored in C5, NOT_RUN; not covered by DB race evidence. |
| P4-01 | Network/asset registry and custody ADR (planned) | CRY-01, CRY-04, CRY-14 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P4-02 | Wallet proof and crypto checkout guard (planned); src/modules/rewards/commands.ts baseline | CRY-02, CRY-10, FND-05 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P4-03 | Conditional settlement provider/contract security specification (planned) | CRY-06–11, CRY-13 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P4-04 | Contracts and verified testnet deployment (planned) | CRY-01, CRY-10, CRY-11, CRY-13 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P4-05 | Chain indexer/finality/checkpoint module (planned) | CRY-02–05 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P4-06 | src/modules/payments/providers.ts (fiat mock only); crypto adapter/UI (planned) | CRY-01–05, CRY-08 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P4-07 | src/modules/rewards/commands.ts; drizzle/0001_marketplace.sql (baseline pool) | CRY-06–09 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P4-08 | Per-asset allowlist/components and entitlements (planned) | CRY-06, CRY-08, CRY-11, CRY-12 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P4-09 | Contract invariant/fuzz and chain reconciliation suites (planned) | CRY-03–11, CRY-13 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P4-10 | docs/PAYMENT_READINESS.md; docs/RELEASE_CHECKLIST.md; custody/audit records (planned) | CRY-13, CRY-14, OPS-08 | TODO | Planned phase work; existing baseline paths are not completion evidence. Testnet/live access separately BLOCKED. |
| P5-01 | src/lib/read-model.ts (basic catalog); search/index migration (planned) | DSC-01, DSC-06, SEC-07 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P5-02 | src/lib/read-model.ts; src/app/ | DSC-01 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P5-03 | src/lib/read-model.ts; src/modules/auctions/commands.ts | DSC-03 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P5-04 | Trending formula/eligibility implementation (planned) | DSC-04, OPS-06 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P5-05 | src/lib/read-model.ts (basic profiles); discovery ranking (planned) | DSC-01, DSC-04, SUP-02, REV-03 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P5-06 | src/app/; public sitemap/canonical rules (planned) | DSC-01, SEC-01, SEC-11 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P5-07 | Query benchmark/index/cache work (planned) | DSC-05, DSC-06 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P5-08 | src/app/; tests/e2e/ (C5 authored; NOT_RUN) | DSC-02, DSC-05, OPS-07 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P6-01 | src/modules/catalog/commands.ts (profile URL baseline); social account model (planned) | XPL-01, SUP-06 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P6-02 | PUBLISH terms/delivery extension (planned); service_versions baseline | XPL-02, MOD-02 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P6-03 | ACCESS appointments/policy extension (planned); src/modules/capacity/weeks.ts baseline | XPL-03, CAP-11 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P6-04 | Taxonomy expansion/common-engine regression (planned) | DSC-01, XPL-01–03, PAY-01 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P6-05 | DIGITAL assets/entitlements/rights extension (planned) | XPL-04, XPL-06, SEC-05, SEC-14 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P6-06 | DIGITAL stock/license transactions (planned) | XPL-04–06 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P6-07 | Platform evidence/report moderation (planned) | MOD-01, MOD-02, XPL-01, XPL-02 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P6-08 | tests/integration/ baseline; cross-platform/E2E suites (planned); docs/ACCEPTANCE.md | ORD-01, REQ-01–11, AUC-01–14, PAY-01, XPL-01–06, OPS-07 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
| P6-09 | Provider-managed bank funding extension (planned) | BNK-01–03, PAY-19, CAP-05 | TODO | Planned phase work; existing baseline paths are not completion evidence.  |
