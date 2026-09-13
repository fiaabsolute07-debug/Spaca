# Release checklist

As of 2026-09-14; baseline **3bddff9**. Platform fee always **0%**. No deployment/live launch is approved by this checklist.

| Gate | Status | Evidence / remaining work |
|---|---|---|
| G0 Reproducible | PARTIAL | Local blank/upgrade migrations, seed and checks pass; clean clone/frozen install/CI run absent. |
| G1 Domain correct | PARTIAL | 184/184 with DB suites enabled at 3bddff9; full §18 races, finance edges and later phases remain. |
| G2 Secure boundaries | PARTIAL | Local ownership, roles/audit and storage negatives pass; Supabase, full secret/SSRF/session matrix remain. |
| G3 Usable | PARTIAL | W1-B/W3-R browser journeys, W2-S/C6 360px checks; 768/1440 and keyboard/full E2E remain. |
| G4 Recoverable | PARTIAL | Mock journal/inbox/retry recovery passes; remote-success DB crash, restore and rollback rehearsal remain. |
| G5 Deployable | BLOCKED | Staging environment/access absent; real adapters, deployed scheduler, smoke/restore/rollback not verified. |
| G6 Live eligible | BLOCKED | Provider credentials/approval, entity/policies, fee payer/reserve, infrastructure and launch authority absent. |
| G7 Market evidence | BLOCKED | No authorized real paid/completed transaction evidence; fixtures and mock payments do not count. |

Evidence and per-ID limits: [acceptance ledger](ACCEPTANCE.md), [C6 review](evidence/claude-review-C6.md) and commit `3bddff9` (184/184, 17 files with DB suites enabled; tsc 0). Claude ran DB/browser checks; C3 performed documentation validation only. G0–G4 remain PARTIAL; G5–G7 are BLOCKED. Documentation completion does not close staging/live gates.

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
