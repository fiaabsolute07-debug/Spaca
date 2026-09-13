# Release checklist

As of 2026-09-13. Scope: master §17.1, §21 and P1C-07. Documentation prepared; no deployment or live launch is approved by this checklist. Platform fee is always **0%**.

| Gate | Required result | Current status | Evidence and remaining work |
|---|---|---|---|
| G0 Reproducible | Clean clone installs, migrates, seeds and runs | PARTIAL | [Local evidence](evidence/claude-db-integration.md): migrations/seed and reruns, typecheck, webpack compile. Clean-clone/CI reproduction and complete environment validation remain. |
| G1 Domain correct | Money, capacity, states and snapshots correct | PARTIAL | Same evidence: 83/83 local PostgreSQL + mock tests, including capacity/idempotency races. Full master coverage, immutable terms and later lifecycle/capacity work remain; this is not provider sandbox evidence. |
| G2 Secure boundaries | Correct user/role/data isolation; no secret exposure | PARTIAL | Same evidence: negative authorization, origin, order/service/pool isolation and mock signature checks. Private storage, production auth, privileged audit/actions and full security coverage remain. |
| G3 Usable | Desktop/mobile/keyboard journeys work | NOT_RUN | Playwright, 360/768/1440 screenshots and keyboard/manual evidence absent from the cited record. Compiled UI is not usability acceptance. |
| G4 Recoverable | Retry, outage, reconciliation and restore succeed | PARTIAL | Local mock fault injection only: unknown outcomes, inbox replay, hold/release jobs, mutation checks and notification sink dedupe. Restore/rollback rehearsals and real-provider outage recovery remain NOT_RUN. |
| G5 Deployable | Staging, migrations, config and health pass | BLOCKED | No staging environment. [Staging plan](STAGING.md), OPS-02/03 and deployment smoke are NOT_RUN; keys, infrastructure and scheduler missing. |
| G6 Live eligible | Accounts, rails, policies, operations and authority complete | BLOCKED | [Payment readiness](PAYMENT_READINESS.md) has open eligibility/policy checks; Stripe sandbox blocked without keys, live blocked. Operator tooling and authorized launch record missing. |
| G7 Market evidence | Real buyer pays and creator completes delivery | BLOCKED | No redacted real transaction/completion evidence. Mock, sandbox, testnet, fixture users and test payments never count as market evidence. |

G0/G1 evidence ran in Claude's normal macOS shell, outside the restricted Codex runner. C2 did not rerun those tests. Skipped tests do not pass. P1C documentation does not establish operational acceptance; independent product work may continue while live gates are blocked.

## Operator decisions before live — all OPEN

- [ ] Legal entity and platform country: supply verified identity and registration; choose creator countries/payout routes and obtain provider/category approval.
- [ ] Fee payer: explicitly choose `FEE_PAYER_POLICY`; disclose actual third-party costs without markup. Buyer surcharge stays off and platform fee stays 0%.
- [ ] Reserve: name funding source, budget and owner for processing, refunds, disputes and deficits; set late-cost caps, adjustment approvals and recovery rules. Never silently create creator debt.
- [ ] Support: provide real support contact, dispute/refund owner, coverage and escalation responsibilities.
- [ ] Policies: approve real-entity privacy, terms, refund/cancellation, acceptance/revision and payout policies with versioned consent and actual provider holding limits.
- [ ] Infrastructure: select hosting/domain/region, backup retention/access and production operator access; supply separate live keys and verified sender/domain through secret stores.
- [ ] Budget: record dated official prices and traffic assumptions for hosting, Postgres/Auth, storage, jobs, email, payments, crypto if enabled, monitoring and manual operations. No pricing research or paid plan purchase was performed for C2.
- [ ] Launch authority: name who can activate live rails, release funds, manage incidents and contact real users. Prepare creator consent/onboarding and buyer journey materials; no external outreach is authorized by this checklist.
- [ ] Crypto, if enabled later: decide custody/signing authority, verify mainnet availability, contract review and emergency operations separately from testnet. Keep buyer bank funding disabled until its separate P6-09 tests/policy gate passes.

Engineering must attach candidate commit/migration manifest, environment and dependency versions, flags, test/security/UI reports, staging smoke, OPS-02/03 evidence and unresolved limitations. Operator then records dated readiness decisions and any authorized launch; real paid/completed milestones require redacted evidence and operator-managed feedback.
