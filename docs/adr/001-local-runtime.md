# ADR 001 — Explicit local development runtime

Status: implementation decision for local verification; production integration remains gated.

The audited machine has Node 24 but no Docker/Supabase CLI. Use embedded-postgres (native PostgreSQL 18.4, package beta wrapper) on loopback 127.0.0.1:55432, persistent data under .local/postgres. This is real SQL/transactions/constraints, not an in-memory database. The runner neither creates an OS user nor listens on external interfaces. Run `pnpm db:start` in a persistent terminal; `pnpm db:stop` sends a fast shutdown to the validated local postmaster PID. These scripts refuse NODE_ENV=production. Data is retained. The package native build script must be explicitly allowed by package manager setup.

Migration credentials use postgres/local_dev_only. App runtime uses the separate app_server role created by migrations. The local password is a public development fixture, never a production secret. DATABASE_URL is mandatory in production.

## Authentication deviation and boundary

The master selects Supabase Auth and prohibits a separate password store in production. Without a configured Supabase stack, the app supports a clearly local-only development authentication fixture to exercise actual authorization and order flows. Passwords are salted scrypt digests; random bearer session tokens are SHA-256 hashed in the database. Actor reads join active users with unexpired sessions on every request. Signup never reads roles or user IDs from the browser. Role set is buyer+creator only; seeded admin is separate. Cookies are HttpOnly/SameSite=Lax and Secure on HTTPS. POST requires exact matching Origin. Local mode cannot be activated in NODE_ENV=production, even by an AUTH_MODE setting.

Production uses @supabase/ssr, server getUser verification, and auth_user_id mapping. Unconfigured Supabase fails closed. Browser metadata never supplies roles. Email verification is delegated to Supabase; a sessionless signup redirects to an email verification notice. Reset-password and provider-specific refresh/middleware verification are pending, not claimed complete. The local password column is a development fixture and must remain unused in production. Production readiness requires Supabase credentials, verified callback/reset flows, rate-limiting, and end-to-end evidence against a configured Supabase project. Supabase SDK code existing is not evidence that hosted authentication has been verified.

## Evidence boundaries

Pure tests exercise password verification, digest handling, Origin checks, and the production local-auth guard. Database/session/role behavior requires integration evidence produced by lead. Native database startup success and migration success are tracked separately. No live payment, external email, deployment or production account is involved.
