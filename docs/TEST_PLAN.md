# Test plan

## Automated gates

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false
./node_modules/.bin/vitest run
# DB-backed suites (tests/integration/*.db.test.ts) need PostgreSQL started and migrated:
RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run
DATABASE_URL='postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace' \
NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:54321' \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='build-placeholder' \
./node_modules/.bin/next build --webpack
```

The repository intentionally uses the bundled Node runtime path from `docs/evidence/p0-foundation.md`; `pnpm` may try to mutate the existing modules directory in this managed runner, so the direct binaries are the reproducible equivalent here.

## Required integration cases once PostgreSQL is available

1. Two isolated users: anonymous can read only published catalogue rows; a buyer cannot read another buyer's brief/order/messages; a creator cannot mutate another creator's service.
2. Book race: two buyers contend for one capacity unit; exactly one reservation commits and the other receives a deterministic conflict.
3. Idempotency: replay the same command key/body returns the original result; reusing the key with a different body fails.
4. Order lifecycle: `AWAITING_PAYMENT → FUNDED → IN_PROGRESS → DELIVERED → COMPLETED`; invalid skips are rejected; a single revision is accepted and a second is rejected.
5. Payment adapter: duplicate, out-of-order, timeout and terminal failure operations leave one durable provider operation and a reconciliation path.
6. Requests: buyer selection is scoped to the request, creator acceptance is scoped to their application, and unselected applications remain historical.
7. Auctions: server time controls closing, bids are monotonic under a row lock, Buy Now is disabled after the first valid bid, and a bid cannot be retracted through the public endpoint.

## Manual evidence

Capture 360/768/1440px screenshots for anonymous explore, buyer booking, creator delivery, dispute, request applications, and auction close. Redact all credentials, tokens, email addresses, and provider identifiers. Do not mark a case PASS when it is only mocked or skipped.

