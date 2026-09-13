# P0 foundation evidence — 2026-09-13

## Verified in the managed workspace

Runtime: Node `v24.19.0` from `/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`.

| Gate | Command | Result |
| --- | --- | --- |
| Type safety | `./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false` | PASS, exit 0 |
| Unit/contract tests | `./node_modules/.bin/vitest run` | PASS, 2 files / 48 tests |
| Production compile | `DATABASE_URL=… NEXT_PUBLIC_SUPABASE_*='build-placeholder' ./node_modules/.bin/next build --webpack` | PASS; dynamic routes `/[[...path]]`, `/api/auth`, `/api/commands` compiled |
| Turbopack build | `./node_modules/.bin/next build` | BLOCKED by managed runner: Turbopack child process cannot bind a port (`Operation not permitted`) |
| Local PostgreSQL | `node --import tsx scripts/postgres.ts start` | BLOCKED: embedded PostgreSQL initdb falls back to SysV and `shmget(... size=56)` returns `Operation not permitted` |

## Database blocker

The embedded PostgreSQL package is present and its native ICU/lib symlinks were hydrated. `scripts/postgres.ts` sets `shared_memory_type=mmap` and `dynamic_shared_memory_type=mmap`, but PostgreSQL's `initdb` probe still chooses SysV for its bootstrap check. The managed execution profile denies the required `shmget` call. No database process was left running and no migration/seed result is claimed.

The next environment action is to run the same scripts on a normal local shell, Docker/Podman PostgreSQL, or a Supabase local project with IPC enabled, then run `db:migrate`, `db:seed`, and the integration suite. This is an environment capability blocker, not an application-level acceptance.

## Mirai provider note

Mirai was tested outside the repository through its OpenAI-compatible endpoint. The Responses route returned a terminal response whose reported model was `gpt-6-astra`; the Chat Completions route was unstable for Astra but succeeded for Terra. No Mirai key is stored in source, `.env.example`, lockfiles, logs, or product runtime. The current Codex task remains on its configured `gpt-6-astra` provider; switching a running task's provider is not supported. Future CLI sessions can use Mirai's documented Base URL and `wire_api = "responses"` configuration with a user-managed secret.

