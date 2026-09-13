# Capacity creator marketplace

This repository contains the zero-platform-fee creator capacity marketplace described by `docs/MASTER_PROMPT.md`. It is a modular Next.js/PostgreSQL application with role-aware catalogue, Book Now orders, requests, auctions, a local sandbox payment adapter, and durable operational tables.

## Local setup

Use Node 24 and pnpm 11. The managed Codex workspace provides Node at `/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`; add that directory to `PATH` if `node` is not already available.

```bash
pnpm install --frozen-lockfile
pnpm db:start
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open `http://127.0.0.1:3000`. Seed accounts are `creator@example.test` / `creator-local-password` and `buyer@example.test` / `buyer-local-password`. They are local fixtures only. Use `pnpm db:stop` to stop the retained embedded cluster.

The current managed runner blocks the embedded PostgreSQL bootstrap `shmget` call. If `db:start` fails with `Operation not permitted`, use a normal local shell, Docker/Podman PostgreSQL, or a Supabase local project with IPC enabled, then set `DATABASE_URL` and `DATABASE_MIGRATION_URL` before running the migration and seed scripts. See `docs/evidence/p0-foundation.md`; do not treat a compile-only run as transaction evidence.

## Verification

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false
./node_modules/.bin/vitest run
DATABASE_URL='postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace' \
NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:54321' \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='build-placeholder' \
./node_modules/.bin/next build --webpack
```

The default Turbopack build can require child-process port binding in this managed runner, so the evidence uses the equivalent webpack production compiler. Database-backed integration cases are listed in `docs/TEST_PLAN.md` and remain pending until PostgreSQL runs.

## Provider and secrets

The product does not contain a Mirai key or any other live credential. Mirai can be configured in a separately managed CLI process using its documented OpenAI-compatible Responses base URL, but this Codex task cannot switch its provider during an active run. Production authentication, payment, email, storage, and deployment require explicit credentials and release evidence.

