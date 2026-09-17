# 11 — First deploy on Vercel + Supabase (no money)

Owner decisions (2026-09-17): Vercel for the app, Supabase for Postgres and Storage, first-party sessions (sign-up with X, then Google or email), **no money at launch**, every section open up to the payment step. This runbook is for the owner or an operator they name. **Nothing here has been run.** Each step that creates, deploys or redeploys something public needs the owner's go-ahead at that time. Never paste keys into chat; set them in the provider dashboards.

## 0. Before anything

- Rotate every key that was ever pasted into a chat (Supabase service key, Resend key) before creating production credentials.
- Decide the domain (e.g. `app.<domain>`), and keep staging and production as separate Supabase projects and separate Vercel environments. A preview deployment must never read production keys.

## 1. Supabase (one project per environment)

1. Create the project in the chosen region. Note the project URL.
2. Database: in *Project Settings → Database*, take the direct connection string for migrations (`DATABASE_MIGRATION_URL`, owner role) and the pooled connection string for the app (`DATABASE_URL`). Migration `0001` creates the `app_server` role the app uses; set its password in Supabase SQL (`alter role app_server with password …`) and use it in `DATABASE_URL`.
3. From a trusted machine with those two values in the shell environment only:
   - `pnpm db:migrate` (with `DATABASE_MIGRATION_URL` set) — applies `drizzle/0001…0037` and records them in `public.schema_migrations`.
   - **Do not** run `pnpm db:seed`: fixtures are local test data.
4. Storage: with `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVER_SECRET_KEY` in the shell environment, run `pnpm storage:setup` to create the nine private buckets with their size and type limits (it prints bucket names and results only; `--dry-run` lists them without calling Supabase). Supabase Free caps every upload at 50 MB; raise the global limit on Pro before videos (250 MB) and zips (100 MB) are uploaded.
5. Keep *Data API* exposure off for the `app` schema; the app talks to Postgres directly.

## 2. External sign-in apps

| App | Settings |
|---|---|
| X developer app (pay-per-use credits) | OAuth 2.0, confidential client; callback `https://<domain>/api/x/callback`; scopes `users.read tweet.read`. Keys → `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_BEARER_TOKEN`; `X_PROVIDER=live`. |
| Google Cloud OAuth client (Web application) | Authorized redirect URI `https://<domain>/api/auth/google/callback`; consent screen with scopes `openid email profile`, published. Keys → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; `GOOGLE_PROVIDER=live`. |

## 3. Vercel project

Environment variables (Production; Preview gets its own staging values):

| Variable | Value |
|---|---|
| `APP_ENV` | `production` (staging: `staging`) |
| `APP_BASE_URL` | `https://<domain>` |
| `DATABASE_URL` | pooled `app_server` connection string |
| `AUTH_MODE` | `app` (first-party sessions) |
| `DEV_SESSIONS` | `off` |
| `STORAGE_PROVIDER` | `supabase` |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVER_SECRET_KEY` | project URL, server secret key (never `NEXT_PUBLIC_`) |
| `PAYMENT_MODE` | `off` (no money at launch) |
| `LIVE_PAYMENTS_ENABLED` | `false` |
| `NOTICE_SIGNING_SECRET` | 32+ random characters |
| `VIEW_HASH_SALT` | 16+ random characters |
| `CRON_SECRET` | 32+ random characters (Vercel sends it to the jobs cron) |
| `X_*`, `GOOGLE_*` | from §2 |
| `EMAIL_MODE` | `sink` until a sender domain is verified |
| `SENTRY_DSN` | optional |

Then `pnpm env:check production` locally with the same values exported (it prints names and OK/MISSING/INVALID only) must pass before the first deploy.

Cron: `vercel.json` schedules `/api/cron/jobs`. Vercel Hobby runs crons at most daily; the jobs need Pro for a 5-minute schedule.

## 4. First deploy and smoke (owner go-ahead required)

1. Deploy to the staging environment first; run §5 there.
2. Promote to production only after staging passes and the owner says so.

## 5. Smoke checks

- `/` and `/explore` load without "Local sandbox" wording; no test-account buttons in the sign-in dialog.
- Sign up with X as a creator → setup → upload a photo (Supabase Storage) → profile shows it.
- Connect Google in settings, sign out, Continue with Google signs back in.
- Create a service, post a campaign, apply, list an auction item: each works until a payment step, which says payments open later.
- `/admin/flags` shows checkout, bidding, collateral and payouts off.
- `GET /api/cron/jobs` without the secret answers 401; the Vercel cron log shows a successful run.
- `GET /api/health` answers `{"ok":true}`; point the uptime monitor at it.
- Response headers include `Strict-Transport-Security`, `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`.
- Booking a service, locking collateral, bidding and accepting an offer show **Payments open later** instead of a button.

## 6. Rollback

- Vercel: promote the previous deployment. Migrations are additive; do not restore an old database over new writes.
- If sign-in misbehaves: set `X_PROVIDER=off` / `GOOGLE_PROVIDER=off` and redeploy (owner go-ahead); existing sessions keep working.
