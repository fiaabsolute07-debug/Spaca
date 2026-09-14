# C5 — Playwright E2E authored, browser execution NOT_RUN

2026-09-14. Codex (Astra), second engineer; Claude runs and integrates. Added `playwright.config.ts`, `tests/e2e/helpers.ts` and seven spec files. **14 tests discovered; no browser launched and no screenshots captured in this task.** Platform fee remains **0%**. W4-A's 195/195 tests and manual browser check at 90004fd are separate historical evidence, not C5 results.

| Spec | Journey authored | Acceptance IDs / gate contribution (NOT_RUN) |
|---|---|---|
| public.spec.ts (2) | Anonymous home → explore → published service → requests → auctions; client page errors/HTTP/render checks; private buyer orders login prompt | DSC-01 (browse only), FND-04 (login boundary only), OPS-07; G3 |
| book-order.spec.ts (1) | Unique creator_c service → buyer_a opens creator's first published explore entry → ≥20-character brief/terms → AWAITING_PAYMENT → local provider form → FUNDED → creator starts/delivers → buyer approves v1 → jobs → COMPLETED and review form | ORD-01, ORD-02 (positive path), REV-01 (eligibility UI only), PAY-06 (confirmed mock funding UI); G3 |
| revision-dispute.spec.ts (2) | Independent revision v1 → request → v2/history/used credit; a separate new order → dispute in IN_PROGRESS → finance RESUME with audit reason → IN_PROGRESS | ORD-05/06 (revision UI), ORD-10 (dispute path, not concurrency), SEC-12, OPS-05; G3 |
| request-hire.spec.ts (1) | Cap-only $200 × 2 request → creator application $100 → buyer offer → creator explicitly chooses this test's pool → accept/schedule → buyer pays → campaign 1 / 2 funded | REQ-01, REQ-06, REQ-10, REQ-11 (manual selection only); G3 |
| auction.spec.ts (1) | Unique service/auction ending ~2 h later → buyer_a minimum $100 bid → separate buyer_b context bids $120 → buyer_a live outbid within 12 s; Buy Now button absent after first bid | AUC-01 (schedule UI only), AUC-02 (sequential bid UI), AUC-08 (first-bid visibility only, not invalidation), AUC-13 (live update only); G3 |
| admin.spec.ts (4) | Buyer admin denial; moderator moderation/audit boundary; finance operations; admin same-value BOOKING_ENABLED save with unique reason/success/persisted reason | SEC-12 (role UI), OPS-05 (flag form only); G3 |
| responsive.spec.ts (3) | 360×780, 768×1024, 1440×900; each owns a new service/order and visits home/explore/service/requests/auctions/order as buyer_a | OPS-07 (viewport portion only); G3 |

Mappings describe authored assertions, not full acceptance coverage or new PASS rows. Auction close/default, reconnect/sleep, simultaneous browser bid races, keyboard-only, second-hire completion, receipt details, review submission, moderation writes and case recovery are not covered by these journeys.

Configuration uses system Chrome (`channel: 'chrome'`), one worker, `fullyParallel: false`, retained failure traces, failure screenshots, `testDir: 'tests/e2e'`, `outputDir: 'test-results/e2e'`, and the requested E2E_BASE_URL fallback to `http://127.0.0.1:3100`. There is no webServer. The 120-second per-test allowance covers cold Next route compilation; the outbid assertion has its own strict 12-second budget starting before buyer_b's submit.

All logins use `page.request.post('/api/dev/session', { data: { persona }, ... })`, sharing its browser context's real session cookie, and request JSON responses. No passwords, cookie fabrication, DB writes, mocked UI routes, direct commerce API setup or direct funding mutation. `runJobs(page)` posts to the dev hook with `Origin` equal to baseURL's origin, checks report structure and ERROR outcomes; final order state independently proves this order's completion. The hook runs all jobs, not only this order.

Every mutating journey creates timestamp-plus-random-suffix titles, briefs/deliveries or audit reasons. Service setup uses the actual draft and publish UI, creates a fresh capacity pool (10 units), and supplies three local sample URL/title pairs. The current public query sorts newest first, so the new creator_c service is the first creator_c entry booked from `/explore`. Requests select that test's pool by its unique service-derived name. No test uses an order/request/auction created in another file; the anonymous smoke test only needs seeded published inventory. Fixture and E2E data remain in the local DB for diagnosis; repeated runs create new rows rather than deleting/resetting data.

Responsive tests request full-page screenshots at `test-results/e2e/screens/<width>-<name>.png`, where names are home, explore, service, requests, auctions and order (18 requested screenshots). Font readiness precedes capture. Overflow assertions are soft within each viewport so later pages can still be captured after an overflow. Browser execution must generate and visually review these files; discovery does not do so.

Exact verification commands run from the repository root:

```sh
PATH=/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH ./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false
./node_modules/.bin/playwright test --list
git diff --check && git diff --stat
```

Results: TypeScript **exit 0, no diagnostics**. Playwright **exit 0, 14 tests in 7 files**; it listed 4 admin, 1 auction, 1 booking, 2 public, 1 request, 3 viewport and 2 revision/dispute tests without executing them. Whitespace check **exit 0**. The [C3c evidence](codex-C3c.md) records the exact additional Python ledger-count check. Read-only `cat`, `sed`, `rg`, `pwd`, and git status/diff were used for source inspection; git diff/stat includes concurrently edited Claude paths, which Codex did not modify.

Selectors/runtime assumptions to verify in Claude's browser run:

- Exact labels and button names were read from current pages/components, including `Pay with local test provider`, `Approve version 1`, `What should change? (1 revision left)`, `Schedule this work in`, `Accept and schedule`, and `Place binding bid`. These are source-checked, not browser-verified; Claude is concurrently changing payment/order surfaces.
- Generic service panels and admin sections have no accessible container name. The only structural CSS locators are `div.panel` for a unique service heading and `section` filtered by the exact flag heading/order link. All controls and links inside use roles/labels; no nth queue row or fixed entity IDs.
- Buy Now remains in immutable Terms text after a bid. The test requires the **purchase button** to disappear, not all occurrences of the words. The live standing panel is checked on buyer_a's existing page without reload or manual snapshot fetch; `bringToFront()` lets visible-tab polling/refetch operate.
- Admin denial requires the actual `404 · Not found` and `That page has moved on.` markup, and absence of the protected heading. Next can return HTTP 200 when notFound renders after streaming starts, so the helper accepts 200 or 404 transport status and never treats HTTP 200 alone as successful denial. Literal transport-404 verification is not claimed.
- `datetime-local` has no timezone suffix; the backend parses it in the Next process timezone. Start Next and Playwright with the same TZ (for example `TZ=UTC` for both), or the auction start may be rejected. The start is about one minute in the past, inside the five-minute allowance. New service turnaround is 24 hours to keep auction capacity scheduling practical.
- Admin saves BOOKING_ENABLED's current value with a new reason, asserting notice and persisted reason; this does not disable booking or depend on restoring a flag. No live/crypto flag is enabled by a test.
- The manually created buyer_b context is closed in finally; Playwright's configured failure trace/screenshot applies to the managed buyer_a context. Add an explicit secondary-context trace if buyer_b diagnosis needs one.

Requests for Claude:

1. Apply this exact package.json script entry (Codex did **not** edit package.json):

   ```json
   "test:e2e": "playwright test"
   ```

2. Review against your integrated P4 changes, then start Next dev on loopback 3100 against an isolated seeded dev DB, with local fixture auth/dev sessions, mock payments and required booking/request/auction/payout flags available. Keep the original Next process alive through pay → jobs because mock provider history is in memory. The broad jobs hook should not share a DB/process with unrelated test suites or manual financial experiments.
3. Use installed system Chrome, no browser download/install. With matching server/test TZ, run `./node_modules/.bin/playwright test` (or `pnpm test:e2e` after adding the script). Record actual test outcomes, inspect failure traces and all 18 screenshots, and amend acceptance only from executed evidence. E2E runtime, viewport layout and screenshot existence are currently **NOT_RUN**.
4. Update the collaboration board and commit only dispatched docs/E2E/config/AGENTS paths. No git mutations, application build, installs, network requests, live money, external email or deployment were performed by Codex.
