# SEC-11 and DSC-05 evidence (2026-09-15)

Environment: LOCAL. Next.js 16 webpack dev server on 127.0.0.1:3100, embedded PostgreSQL 18, Playwright with system Chrome, mock payment provider. No deployed environment was involved.

## SEC-11: secrets and private payloads stay out of logs and bundles

What changed
- `src/lib/log.ts`: `safeError` keeps the error name, the first message line (quoted values over 40 characters redacted, 240 characters at most), SQLSTATE code, constraint, table, routine and four stack frames. It never copies `detail`, `parameters`, `where` or the error object itself. `logError(context, error, ids)` writes one JSON line.
- Every server `console.error` that logged a raw error object now goes through `logError`: the command envelope, the mock payment webhook, mock checkout, bank transfer start, JSON routes, discovery, and every job loop (checkout holds, webhook reprocessing, provider reconciliation, settlement release, chain payouts, notification outbox, auto-accept, storage cleanup, hire offers, auctions, chain indexer). Logs carry ids (order, operation, outbox row); the outbox line uses the row id instead of the semantic key.
- `scripts/secret-scan.ts` scans tracked files for credential shapes (private key blocks, Stripe, Supabase and Resend keys, JWTs, remote database URLs with passwords, AWS and GitHub tokens). It scans client bundles for those plus server-only environment variable names, local fixture secrets, database URLs and named private keys. It prints file:line and a label, never the matched text. `--log <file> --private <text>` checks a captured log for payload markers.

Runs
- `vitest run tests/unit/log.test.ts`: 2 passed. A PostgreSQL-shaped error whose `detail` and `parameters` hold a brief and an email logs code 23514 and the constraint name, but not the brief, the email or "Failing row". Long quoted values in messages are redacted, and only the first message line is kept.
- `tsx scripts/secret-scan.ts`: 376 tracked files and 51 client bundle files in `.next/static` (dev build), no findings. The first run flagged 2 lines in `tests/unit/release-rules.test.ts`, the detector's own unit test, which holds secret-shaped fixtures by design. That file is now excluded by name.
- Observed in use: while campaign images were being added, the storage suite hit a CHECK violation. The log line showed `upload_intents_object_key_check`, SQLSTATE 23514 and the table, with no row values.

Still open
- The production `next build` bundle has not been scanned; only the dev bundle has.
- No logs were captured from a deployed environment.

## DSC-05: a stale checkout after the creator pauses

- `tests/e2e/honest-states.spec.ts` "DSC-05": the buyer opens a published service, fills in the brief and ticks the terms. Meanwhile the creator pauses new orders in another browser context. The buyer then submits.
- Result: the buyer lands back on the service page with the signed error "This creator paused new orders". The availability block reads "Paused" and the "Reserve this service" button is gone. The `finally` block resumes the creator.
- Runs: passed (51.1s), and passed again after the workspace frame change (23.5s).
