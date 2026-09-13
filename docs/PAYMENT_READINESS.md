# Payment readiness

As of 2026-09-13. Scope: master §8.1–8.2 and P1C-03. No provider eligibility is inferred from the operator's language, IP address or timezone. These are open checks, not provider approvals.

| Check | Status | Evidence needed | Owner |
|---|---|---|---|
| Platform country/legal entity | BLOCKED | Operator-supplied entity name, registration and country; dated eligibility confirmation for that entity. | operator |
| Creator countries + payout routes | BLOCKED | Intended creator countries; supported platform→creator routes, currencies and account model for each route. | operator |
| Merchant/category approval | BLOCKED | Provider account approval, marketplace/category permission and connected-account onboarding/capability records. | operator |
| Charge/transfer/refund/dispute | NOT_RUN | Sandbox receipts and API/event mapping for each action; responsibility, holding limits, transfer recovery and dispute evidence. | engineering |
| Fee payer and reserve | BLOCKED | Explicit policy consent, actual-cost evidence, reserve owner/source/budget, late-cost cap and failed-payment/refund/dispute recovery rules. | operator |
| API/webhook version | NOT_RUN | Pinned API/event versions, separate signing secrets, signature/duplicate/order tests and endpoint health in each target environment. | engineering |
| Required documents/contact | BLOCKED | Real entity details, privacy/terms/refund/acceptance policies and staffed support/dispute contact. | operator |
| Readiness result | BLOCKED | Dated report linking every check to evidence, named sign-off owner and authorized launch record. | operator |

## Current local mock provider

- Normal checkout funding happens only through signed webhooks: provider confirmation → verified inbox → locked order transition, ledger and outbox. There is no client mark-paid action. Recovery also supports provider API lookup: fetched facts enter the same idempotent processing path with `source=provider_api_fetch`; they are not signed webhook deliveries.
- The in-memory `MockPaymentProvider` belongs to the running Next.js process. A restart loses provider memory; durable database journals remain. Missing provider objects require investigation, not a fresh charge.
- Sandbox fee policy defaults to `CREATOR_AT_COST`; production requires explicit `FEE_PAYER_POLICY=CREATOR_AT_COST` or `PLATFORM_SUBSIDIZED`. The latter requires a funded reserve. The mock's internal sandbox label does not establish Stripe sandbox verification.
- Platform fee is always **0%**: no flat fee, buyer surcharge, withdrawal fee, hidden FX spread or platform revenue. Third-party costs remain separate, in integer minor units per currency. Fixture costs are not provider quotes; never deduct an unsupported estimate or create retroactive creator debt.
- Stripe Connect sandbox: **BLOCKED (no keys)**. Live payments: **BLOCKED**. Crypto testnet: **NOT_RUN**; no testnet or mock activity is live revenue.

[Claude's local evidence](evidence/claude-db-integration.md) records 83/83 tests against local PostgreSQL and the mock, including duplicate/out-of-order events, unknown outcomes, refunds and settlement release. It does not prove bank payout, Stripe Connect, staging or live operation. Provider calls still need separation from database transactions before a real adapter is integrated.

The candidate charge/transfer flow remains subject to provider approval. Document transfer versus bank payout, refund versus transfer recovery, actual fee evidence and holding limits before live. Do not describe delayed settlement as guaranteed escrow. See [release gates](RELEASE_CHECKLIST.md) and [runbooks](runbooks/README.md).
