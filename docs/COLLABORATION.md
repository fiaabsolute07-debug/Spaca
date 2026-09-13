# Shared build contracts
Root project: this directory. Master: docs/MASTER_PROMPT.md.
TypeScript strict, ESM, Node24, Vitest. Package setup and migrations owned by Codex lead.

## Assignment update — 2026-09-13 (user decision)

The user instructed Claude to implement the product end to end ("tự làm từ a-z cho tới khi sản phẩm hoàn tất … cứ dựa theo plan mà làm") and granted the authority to do so. Until the user says otherwise:

| task_id | owner | scope | status |
|---|---|---|---|
| W1-0 | Claude | baseline commit; split `src/app/api/commands/route.ts` and `src/app/[[...path]]/page.tsx` into domain modules/segments | IN_PROGRESS |
| W1-A | Claude | supply engine v2 (service versions/snapshots, weekly capacity buckets, shared pools) | TODO |
| W1-B | Claude | order lifecycle engine (§7.2 state machine, versions, work clock, auto-accept, cancellation requests) | TODO |
| W2+ | Claude | remaining master roadmap P1B → P6 in order (see `docs/evidence/claude-W1-proposal.md` §5 and master §16) | TODO |

Astra/Codex: please do not edit files concurrently while this assignment is active. Review the commits and the `docs/evidence/claude-*.md` reports, and record change requests in `docs/evidence/astra-review-*.md`. Standing limits still apply: no live money, no public deployment, no external messages, no secrets. Mock, sandbox, testnet and live stay labelled separately.

## Claude assignment
Build provider interfaces and a rigorous local-only mock payment adapter in src/modules/payments/providers.ts. Self-contained types in this file to avoid import races. Funding, cancellation, release, refund, lookup; bigint atomic amounts; 0 platform fee; stable operation id + request hash, duplicate replay, same-key-different-payload conflict, deterministic simulated accepted-but-timeout, webhook event signing/verification using Node crypto timing-safe comparison; no client markPaid endpoint. Use async methods. Adapter instance is not authoritative financial ledger; DB engine owned by lead persists operations.
Also implement notification templates + local sink (never real email) in src/modules/notifications/index.ts. Write tests/providers.test.ts using Vitest for idempotency, conflict, timeout lookup, signature tampering, fees, refunds not exceeding amount and notification dedupe. Include README/report docs/CLAUDE_REPORT.md with exact exports and commands/results, no fake pass.
Do not edit package.json/lockfile/shared schema/routes. No installations, live network actions, git commits or changes outside assigned files. If blocked, write clear status report; local drafting/testing may continue once lead installs deps.
