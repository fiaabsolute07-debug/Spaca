# Self-audit (2026-09-15, end of session)

Environment: LOCAL only. Next.js 16 dev server on 127.0.0.1:3100, embedded PostgreSQL 18 (dev and test databases at migration 0025), Playwright with system Chrome, mock payment provider, local storage provider, Foundry/anvil. Nothing was deployed, sent, or run on testnet or mainnet.

## Security review of code added today

Each item names the risk looked for and what the code does about it.

- `src/app/api/request-images/[id]/route.ts`
  - Risk: serving images for campaigns a viewer should not see, or leaking that an asset exists.
  - The query requires a READY `REQUEST_IMAGE` asset attached through `app.request_images` to a campaign that is OPEN, FILLED or CLOSED, or whose buyer is the viewer. Every other case, including a malformed id, returns the same 404.
  - The redirect is to a 5-minute signed URL with `cache-control: private`.
- `set_request_images` / `create_request image_ids` (`src/modules/requests/commands.ts`)
  - Risk: attaching someone else's file, a file uploaded for another purpose, a quarantined file, or unlimited files.
  - Asset ids must be UUIDs, at most 6. Each must belong to the actor, have purpose `REQUEST_IMAGE` and be READY, locked `for share`.
  - The request row is locked `for update`, so concurrent replacements serialize. Only OPEN or FILLED campaigns can change.
  - The database repeats the ownership rule: composite foreign keys tie `(request_id, buyer_id)` to the campaign and `(asset_id, buyer_id, asset_purpose)` to the asset. The asset guard refuses deleting an image still on a campaign.
  - Tested in `storage.db.test.ts`.
- Upload policy for `REQUEST_IMAGE` (`src/modules/storage/`)
  - Risk: non-images or markup reaching a public bucket.
  - Image kinds only, with signature checks as for avatars. Only ACTIVE buyer accounts may upload. Object keys are server-generated, letters-only prefix.
  - Not covered: images are not moderated or re-encoded (noted as a limit).
- `GET /api/requests/[id]/applications` (`src/app/api/requests/[id]/applications/route.ts`)
  - Risk: exposing private quotes to creators or anonymous callers, and CSV formula injection.
  - Buyer ownership is required; anyone else gets 404. `cache-control: no-store`.
  - Every cell is quoted, and values starting with `=`, `+`, `-`, `@`, a tab or a carriage return get an apostrophe prefix. Covered by unit and integration tests.
- `src/lib/log.ts` and the replaced `console.error` calls
  - Risk: row data, parameters or payload text in logs.
  - Only name, first message line (long quoted values redacted), code, constraint, table, routine and 4 frames are kept. A unit test uses a PostgreSQL-shaped error carrying a brief and an email.
- `scripts/secret-scan.ts`
  - Prints file:line and a label only, never the match. Its one exclusion is the detector's own unit test, by exact path.
- Workspace frame (`site-chrome.tsx`, `workspace-sidebar.tsx`, `header-nav.tsx`, `getWorkspaceIdentity`)
  - Risk: showing another account's data or navigation to the wrong account type.
  - The sidebar shows only the signed-in actor's own name, email, photo id and account type, taken from the server session.
  - Links do not grant access: every page still checks the account type (FND-04 E2E).
- `OrderReceiptPanel`
  - Risk: inventing money facts.
  - It renders stored order columns only, computes no totals (fee model undecided), and is labelled as a simulated sandbox payment.

No new secrets, environment variables or external calls were added. `tsx scripts/secret-scan.ts` reports no findings.

## Housekeeping
- Dropped the local backup databases `creator_marketplace_bak_0011` (14 MB) and `creator_marketplace_test_bak_0011` (179 MB), after listing them first. They were copies made before migration 0011 in an earlier session.
- `tests/integration/escrow.anvil.test.ts` now upserts its network and token, so the suite can run twice against the same test database.
- E2E global setup aborts each warmup request after 90 seconds instead of waiting forever.

## Final runs
- `tsc --noEmit`: exit 0.
- `RUN_DB_INTEGRATION=1 vitest run` (tree of `d898592`): 316 passed, 3 skipped, 38 files (37 passed, 1 skipped). The skipped file is the anvil suite, which needs `RUN_ANVIL=1`.
- `RUN_DB_INTEGRATION=1 RUN_ANVIL=1 vitest run tests/integration/escrow.anvil.test.ts`: 3/3.
- `forge test`: 17/17 (16 unit, 1 invariant).
- `tsx scripts/release-check.ts`: every check PASS. `tsx scripts/discovery-benchmark.ts`: every latency and plan check passed. `tsx scripts/secret-scan.ts`: no findings.
- `TZ=UTC playwright test` (full suite, system Chrome, dev server on 3100, tree of `d898592`): 37 passed in 7.1 minutes.
- `tsx scripts/restore-rehearsal.ts`, run after the E2E suite so the dev database was quiet. Row counts for all 32 obligation tables matched the source, including `app.request_images`. The 8 hard invariants show 0 violations: duplicated chain payouts, principal paid beyond funding, double release, orphan rows, pool conservation, oversold request budget, unbalanced ledger, workload drift. The jobs dry-run at the backup instant lists 25 notification outbox rows and 7 ready settlements as due; none were executed. Webhook replay was a no-op. RESULT: restore verified.
