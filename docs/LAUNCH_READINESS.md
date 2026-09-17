# Launch readiness

Updated 2026-09-17 at commit `e02b533` (migrations through `0036`). Nothing is deployed; no real money, mainnet, public deploy or outbound email has happened. Platform fee is enforced at 0 in code and the fee model is still undecided. This page lists what stands between the current build and a public launch, split into what is verified, what engineering still has to build, and what only the owner can decide or provide.

## 1. Verified today (local)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `release:check` | every check PASS (fee 0, no client funding writes, dev routes guarded — fixed today for the X/Google sandbox routes, no secrets in `.env.example`, mainnet blocked) |
| Production build (`next build`, documented local build env, `NEXT_DIST_DIR=.next-scan`) | compiles; the whole-project file tracing warning from local storage was fixed today |
| Secret scan over tracked files and the production client bundle | 554 tracked files, 42 client files: no secrets or server-only values |
| `RUN_DB_INTEGRATION=1 vitest run` | 431 passed, 3 skipped (anvil); the one repeated failure (XPL-05 search) fixed today |
| Playwright | see §5 (full run at this commit) |

## 2. Launch blockers engineering must build (no owner credentials needed to start)

| # | Blocker | Why it blocks | Depends on decision |
|---|---|---|---|
| E1 | **Production sign-in.** Sign-up is X only and sign-in adds Google, but both run on local sessions; deployed config requires `AUTH_MODE=supabase`, which has no X/Google path. | Nobody could sign up in production. | D2 |
| E2 | **Production file storage.** Only `LocalStorageProvider` exists; deployed config requires `STORAGE_PROVIDER=supabase`, not implemented. | Setup requires a photo/logo; samples, briefs, deliveries and item pictures all upload. | D1 |
| E3 | **Scheduled jobs.** Jobs run only through `POST /api/dev/jobs` locally. | Auto-accept, hold expiry, auction/item closing, X refreshes and payouts would never run. | D1 |
| E4 | **Real payment rail.** Only the mock provider (and Arc on local devnet/anvil). | Any paid order, escrow or payout. | D3 |
| E5 | **Transactional email.** Notifications go to an in-app timeline and a local email sink. | Password email, verification, order and payout notices outside the app. | D4 |
| E6 | **Launch-mode copy and flags.** Sandbox banner, "Local sandbox" policy pages, test-account buttons and feature flags must follow the chosen launch scope. | Public pages must not say "sandbox" or offer features that are off. | D3, D5 |
| E7 | **Deploy pipeline.** CI is authored but has not run on a host; no staging, smoke, restore or rollback rehearsal off this machine. | G5 gate. | D1 |

## 3. Decisions and accounts only the owner can provide

| # | Decision / input | Notes |
|---|---|---|
| D1 | Hosting and data: e.g. Vercel + Supabase (Postgres, Storage), region, domain. | The waitlist already runs on Vercel. A redeploy or new project needs explicit approval each time. |
| D2 | Production sessions: first-party sessions (the X/Google flows already built, Supabase only for data) or Supabase Auth providers. | Recommendation: first-party sessions; they are what is tested today. |
| D3 | Payments at launch: no money (browse, post campaigns, apply; checkout off), Arc USDC **testnet** only, Stripe Connect, or Arc USDC mainnet. | Mainnet needs an independent contract audit and legal review first. Pre-market token / WL resale auctions need legal review before any real money. |
| D4 | Email sender: domain and provider (Resend is wired as a dependency). | The Resend key pasted in chat earlier must be rotated before use. |
| D5 | Launch scope: services and orders, campaigns, item auctions (Beta), crypto pools, digital products. | Everything off stays behind `/admin/flags`. |
| D6 | X developer app with pay-per-use credits (`X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_BEARER_TOKEN`), callback `<APP_BASE_URL>/api/x/callback`. | Each X sign-in is one billed profile read. |
| D7 | Google Cloud OAuth web client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), redirect `<APP_BASE_URL>/api/auth/google/callback`, consent screen published. | |
| D8 | Legal entity, terms, privacy, refund policy, support contact; platform fee decision (currently 0). | Policy pages are sandbox text today. |
| D9 | Monitoring (Sentry DSN), backups/retention owner, incident contact. | |
| D10 | Dev data: the local database holds hundreds of test services and accounts. Production starts empty; local cleanup needs "đồng ý dọn". | |

## 4. Suggested order once D1–D3 are answered

1. E1 production sessions for X/Google (and email), with `DEV_SESSIONS=off` enforced.
2. E2 Supabase Storage adapter with signed URLs, then E3 a protected scheduled jobs endpoint for the host's cron.
3. E6 launch-mode copy/flags for the chosen scope; E5 email if D4 is ready.
4. E7 staging project on the chosen host with its own database, storage and keys; smoke, restore and rollback rehearsal there.
5. E4 payment rail per D3 on staging (sandbox/testnet), then the owner's go/no-go for production.

## 5. Browser suite at this commit

Filled in by the full Playwright run started for this page (see `docs/evidence/claude-LAUNCH-PREP.md`).
