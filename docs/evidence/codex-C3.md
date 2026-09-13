# C3 — acceptance ledger and documentation truth pass

Date: 2026-09-14. Engineer: Codex (Astra), second engineer; Claude coordinates/reviews/integrates/commits. **Docs implemented; ready for review.** Accepted status baseline: `3bddff9`. Platform fee always **0%**.

Updated only 18 allowed documents: ACCEPTANCE, REQUIREMENTS_TRACEABILITY, BUILD_STATUS, HANDOFF, STAGING, RELEASE_CHECKLIST (gate consistency), the runbook index plus ten runbooks, and this evidence file. The two pre-existing uncommitted ledger drafts were refreshed in place. No code, tests, migrations, package metadata, board, UI contract, CLAUDE_REPORT or claude-* evidence was edited. Claude's concurrent P3 files and existing next-env.d.ts/.claude changes were left intact. No git add/commit/reset/stash/checkout, network, installs, Next build, DB startup/suites, browser, live payment, external email or deployment was run.

Status evidence is limited to the thirteen user-listed evidence/report files plus git history. Source inspection establishes real tooling/path names only, not test success. Historical evidence remains immutable; later W1-B/W2/W3/C6 evidence supersedes its status prose. Latest recorded full run is **184/184 tests, 17 files with DB suites enabled, tsc exit 0 at 3bddff9**: the C6 review points to that commit's message for the total. This includes unit/provider tests; “184 DB tests” in the commit is not an exclusively DB-test count. C3 did not rerun it.

Ledger: **142/142 unique §18 IDs**, summaries at most 12 words; **37 PASS / 66 PARTIAL / 36 NOT_RUN / 3 BLOCKED**. Traceability: **80/80 §16 tasks**, with P3 TODO + IN_PROGRESS notes and all P4–P6 TODO. DONE-local task scope and phase delivery do not imply all linked acceptance rows passed. Gates are identical in the ledger/checklist: **G0–G4 PARTIAL; G5–G7 BLOCKED**. No sandbox, testnet or live PASS.

| Family | PASS | PARTIAL | NOT_RUN | BLOCKED |
|---|---:|---:|---:|---:|
| FND | 2 | 5 | 0 | 0 |
| SEC | 6 | 7 | 0 | 1 |
| MOD | 0 | 0 | 2 | 0 |
| SUP | 2 | 2 | 2 | 0 |
| CAP | 7 | 4 | 1 | 0 |
| ORD | 5 | 9 | 2 | 0 |
| REV | 2 | 1 | 0 | 0 |
| PAY | 4 | 13 | 2 | 1 |
| BNK | 0 | 0 | 3 | 0 |
| REQ | 8 | 3 | 0 | 0 |
| AUC | 0 | 11 | 3 | 0 |
| CRY | 0 | 2 | 11 | 1 |
| DSC | 0 | 3 | 3 | 0 |
| XPL | 0 | 0 | 6 | 0 |
| OPS | 1 | 6 | 1 | 0 |
| **Total** | 37 | 66 | 36 | 3 |

Conservative mappings / IDs needing Claude's review:

| IDs | Why proof is narrower or uncertain |
|---|---|
| FND-01/02/04/05/07 | Clean-clone/frozen CI absent; role-switch UI missing; flags table proves auctions but not crypto; seed guard evidence does not name a reset path. |
| SEC-01/02/04/08/10/11 | Recorded ownership/actor/origin/suspension/secret checks do not enumerate every approve/message/payee/expired-session/refund/log/bundle branch. Kept PARTIAL. |
| SEC-03 | BLOCKED target is a Supabase/Data API sandbox environment; local PostgreSQL permission evidence does not execute that boundary. This is not Stripe sandbox evidence. |
| SEC-07, SUP-02/03, REV-03 | Unsafe-link rejection and honest read models exist; browser script/SSRF, empty metric rendering and changed-version consent scenarios are not specifically evidenced. |
| CAP-04/05/09/10 | Captured payment is not every UNKNOWN+competing-checkout race; late funding has no resold-slot consent fixture; CAP-09 proves Buy Now, not close; accepted-hire expiry/funding is sequential. CAP-09 corrected from draft PASS to PARTIAL. |
| ORD-01/02/03/07 | W1-B table says PASS but does not assert receipt/UI error messages; ORD-03 describes an auction fixture rather than unscheduled CREATE. W2-S proves quarantine, not inaccessible remote links. Kept PARTIAL for complete master wording. |
| ORD-10/11/13/15/16 | Order races/view holds/overdue/consented refunds pass locally; shared-principal auto-release race, permanent notification failure, full no-start policy and actual secondary email bounce are not demonstrated. |
| ORD-12/14 | Explicitly not implemented: deadline amendment and chargeback after completion. NOT_RUN, not external blockers. |
| PAY-01–04/06/08/09/11–14/17/20 | Full financial surface/cost disclosure/budget, success-URL UX, environment context, transfer-success DB crash, balance shortage, cumulative partial refunds, serialization and deployed outage schedule are broader than cited proof. Existing narrower tests remain linked. |
| PAY-18 | PASS is limited to executed unit/static nonzero-fee release guards plus existing DB fee constraints; it is not production launch evidence. |
| REQ-04/07/11 | W3-R changed/expired quote test omits stale availability; offer expiry then funding is not simultaneous; evidence explicitly labels REQ-11 PARTIAL for missing sort/filter. |
| AUC-01–14 | Preserve only historical baseline partial results; no concurrent P3 result inferred. Claude must supply accepted v2 evidence. |
| CRY-01/04/14, PAY-19 | Testnet environment and bank payout provider missing (BLOCKED where required); generic integer tests or readiness docs do not prove chain/bank behavior. Local test work can continue. |
| OPS-01–03/05–08 | Retry/inbox tests do not prove remote-success restart or restore; operator browser checks do not prove a new-operator runbook rehearsal; no full viewport/keyboard/weekly-report/readiness enforcement. |

Contradictions found and resolved in the allowed docs:

- BUILD_STATUS/HANDOFF combined a runner IPC limitation with a global “PostgreSQL not running” blocker and obsolete suite counts. Claude's DB evidence proves local startup and migrations; the official baseline now cites 184/184 and preserves only Codex's startup limitation.
- Old Codex-lead ownership and “next add admin/dispute/storage” instructions conflict with the user-directed Claude coordinator model and W2-B/W2-S/C6 completion. Removed those instructions; AGENTS.md and board history remain out of scope.
- Historical CLAUDE_REPORT/DB prose says release from COMPLETED, no dispute resolution, partial refund unhandled, 30-minute holds and no browser access. W1-B proves APPROVED → confirmed release → COMPLETED, consented partial refunds/remainder, ReviewHold; W2-B supplies resolution and C6 admin pages; current default hold is 15 minutes. Historical sources were not edited.
- C2 runbooks described five jobs, pool counters, missing upload/admin/kill-switch/retry tools and future auto-accept. Current docs use trigger-derived bucket counters, W1-B lifecycle, role grants/audits, actual console commands and W2-S upload/quarantine/download cleanup.
- **Concurrent job inventory changed during C3.** Initial runJobsOnce had nine calls, matching 3bddff9. Claude then added closeDueAuctions / close_due_auctions in position 5. Runbooks list all ten current calls in order, marking this tenth job as P3 unverified; baseline remains nine. No P3 execution or NO_BIDS/WINNER_DEFAULTED acceptance was inferred.
- **Lock-order discrepancy:** src/modules/capacity/index.ts documents pool → bucket(s) → order, while expireCheckoutHolds and releaseReadySettlements in src/modules/jobs/index.ts lock order first, then reservation-state updates reach bucket triggers. This is a static consistency finding, not a reproduced deadlock; the runbook states the contract and limitation.
- admin_retry_operation takes a logical operation ID but invokes reconciliation scoped to its order (or an unscoped call if no order_id). It is effectful and may inspect multiple operations. Earlier “scoped single operation” wording was too strong; no dry-run CLI exists.
- W2-S's “rejects a linked sample” means quarantine also marks its sample REJECTED, not that linked samples cannot be quarantined. The security runbook now says this explicitly. CLEAN is signature match only; no antivirus or Supabase adapter.
- W3-R request budget counters do not backfill old requests; partial refunds keep commitments. Staging/capacity/refund plans now preserve these caveats rather than claim all historical budgets reconcile.
- C4's scripts/CI are implemented, so full env validation is not simply TODO; however frozen install/hosted CI execution are NOT_RUN. Inngest, real adapters, external email, restore replay, reconcile:dry-run and missing package scripts remain NOT IMPLEMENTED. test:critical omits newer suites.

Validation performed by C3 (documentation only):

| Check | Result |
|---|---|
| Read AGENTS/board, master §16/§17.1/all §18 tables, all thirteen allowed evidence sources, drafts, git log and 3bddff9 message | Completed; large initial outputs were followed with targeted reads. |
| Read package scripts, env/release validators, jobs, capacity, lifecycle, admin, storage, requests and test titles | Read-only tooling/wording cross-check; no implementation status inferred from unexecuted source. |
| python3 /tmp/codex-C3-check.py | PASS: exact IDs/order/counts, ≤12-word summaries, status/environment enums, no nonlocal PASS, gate agreement, links, ten runbooks, existing table/admin-command names, current ordered job inventory, whitespace. |
| git diff --check on the eighteen C3 paths | PASS; no whitespace errors. |

Temporary Python scripts under /tmp generate/check derived counts and docs. The validator recomputes the ledger family table from rows; it does not run application tests. A first apply_patch replacement attempt was rejected for duplicate file operations and changed no files; subsequent allowed document writes succeeded.

Requests for Claude:

1. Review/integrate only C3's eighteen docs, update your task board and reconcile stale AGENTS.md ownership within your scope. Retain 3bddff9 as this report's evidence cutoff.
2. Finish P3, attach its acceptance/test evidence, and then update AUC rows, phase traceability, job inventory and auction runbook against the final accepted contract. Current source inspection is not a PASS.
3. Audit pool/bucket/order locking (especially expiry/funding/release) and add real CAP-10/REQ-07 and cancellation/auto-release races. Review the conservative mappings above before promoting any row.
4. Dispatch C5 for full 360/768/1440/keyboard/long-text journeys and populated case/dispute forms; add P2 comparison sort/filter, CSV/analytics and legacy-budget backfill decisions. Assign ORD-12/14 and broader finance gaps explicitly.
5. Expand test:critical/security as appropriate; run frozen install/CI in an allowed environment. Implement real adapter transaction boundaries, Supabase storage/auth integration, scheduler, dry-run/restore tooling and operational readiness before staging/live gates. Missing external credentials remain separate from implementable local work.
