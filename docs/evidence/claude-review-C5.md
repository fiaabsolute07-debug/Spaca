# Claude review: C5 Playwright E2E (Codex) and C3c P3 docs

Reviewed 2026-09-14.

## C5: execution results

- **Environment.** Next dev (webpack) on 127.0.0.1:3100 against the seeded dev DB `creator_marketplace`.
  - System Google Chrome (`channel: 'chrome'`); no browser download.
  - `TZ=UTC` for Playwright.
  - Mock payments, dev sessions, local storage and the local devnet were all in-process in that Next server.
- **Command.** `TZ=UTC ./node_modules/.bin/playwright test --reporter=line`
- **First run: 1/14 passed.**
  - Codex's `visit` helper required zero `role=alert` elements.
  - Next.js always renders an empty route-announcer `alert` outside `<main>`.
  - Fixed by scoping the check to `main`.
- **Second run: 10/14 passed.** Four selector issues remained, all in the specs, not the app:
  - `getByLabel(..., { exact: true })` on a `<select>` wrapped in its `<label>`. The accessible name includes the selected option, so the exact match failed. Now uses non-exact label matching.
  - `create_request` and `create_auction` redirect straight to the new entity page. The specs looked for a list card instead; now they read the current URL.
- **Final full run: 14/14 passed in 1.5 min.** 18 screenshots are in `test-results/e2e/screens/` (360/768/1440 × home, explore, service, requests, auctions, order).
  - public (2)
  - booking → local provider payment → start → deliver → approve → jobs → COMPLETED and review form (1)
  - revision v2 (1)
  - dispute → finance RESUME via /admin/disputes (1)
  - request cap-only 2 hires → apply → offer → accept with pool → pay → campaign 1/2 (1)
  - auction two contexts → live "outbid" within 12 s, Buy Now button gone (1)
  - admin role matrix and audited flag save (4)
  - responsive overflow at 3 viewports (3)
- **App bug found in screenshot review and fixed.** The service page (and explore cards) listed every sample the creator ever made. Repeated E2E runs had created many samples, so the 768 px service page was about 7,000 px tall.
  - Fix: `getServiceData` and `serviceRows` now read samples linked through `service_samples`, newest first, capped at 12 per service page and 6 per card; creator pages are capped at 24.
  - After the fix: public + responsive specs 5/5; DB suite 206/206; the 768 px service page shows the 3 linked samples.
- **Data note.** E2E runs add timestamped services, orders, requests, auctions and flag-reason audits to the dev DB. Codex designed this intentionally; there is no cleanup or reset.

Requested `package.json` script applied: `"test:e2e": "playwright test"`.

## C3c: P3 ledger update

- **Accepted with corrections.** AUC-01 and AUC-13 were marked PASS, but W4-A's own gaps apply: no payout readiness check, and reconnect/sleep never exercised. Both are now PARTIAL, and the W4-A evidence table is corrected too.
- **CRY rows updated from W5-C1.**
  - PASS (local-db+mock, simulated devnet): CRY-02, CRY-03, CRY-04, CRY-05.
  - PARTIAL: CRY-01 (local label only; testnet BLOCKED), CRY-11 (allowlist only; contract NOT_RUN), CRY-14 (DB gate only).
- **Ledger now:** 53 PASS, 58 PARTIAL, 29 NOT_RUN, 2 BLOCKED (142 IDs). BUILD_STATUS and HANDOFF baselines now point at 94792af, 206/206 and E2E 14/14.
