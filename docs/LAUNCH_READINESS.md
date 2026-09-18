# Launch readiness

Updated 2026-09-18 at commit `8b56d18` (migrations through `0037`). The app is now deployed and public at
`www.spaca.xyz`; no real money, mainnet or outbound email has happened, and payments stay closed (`PAYMENT_MODE=off`). Platform fee is enforced at 0 in code and the fee model is still undecided. This page lists what stands between the current build and a public launch, split into what is verified, what engineering still has to build, and what only the owner can decide or provide.

## 1. Verified today (local)

Re-run on 2026-09-18 in a Linux container, with the full findings in
[the audit](evidence/claude-AUDIT-2026-09-18.md). The container runs Node 22 and PostgreSQL 16 rather than the
repository's Node 24 and embedded PostgreSQL 18, so these are evidence, not the same evidence the owner's machine
gives. `forge test` (19 passed) and the anvil escrow suite (3 passed) ran there too, for the first time since
2026-09-15.

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `release:check` | every check PASS (fee 0, no client funding writes, dev routes guarded — fixed today for the X/Google sandbox routes, no secrets in `.env.example`, mainnet blocked) |
| Production build (`next build`, documented local build env, `NEXT_DIST_DIR=.next-scan`) | compiles; the whole-project file tracing warning from local storage was fixed today |
| Secret scan over tracked files and the production client bundle | 569 tracked files, 42 client files: clean, after two fixtures shaped like `sb_secret_` keys were replaced (`tests/unit/env-rules.test.ts`, `tests/unit/supabase-storage.test.ts`) |
| `RUN_DB_INTEGRATION=1 vitest run` | 444 passed, 3 skipped (anvil) |
| Playwright | 78 tests: **76 passed, 1 failed, 1 skipped** on 2026-09-18. `publish.spec.ts` passes now that the development data is clean; the failure is a real landing defect — see §5 |
| `reconcile:dry-run` and `restore-rehearsal` | run twice on 2026-09-18, the second time over the 17 orders and 34 ledger entries the browser suite leaves behind: 5 checks agree, 8 invariants hold with 0 violations, restore verified in 10.2s |

## 2. Engineering blockers and their state

The owner answered D1–D3 and D5 on 2026-09-17: **Vercel + Supabase, first-party sessions, no money at launch, every section open.** E1–E3 and E6 are built and tested locally against those answers; each still needs its first run on the real services in staging (E7).

| # | Item | State | What is left |
|---|---|---|---|
| E1 | Production sign-in | **Built** (`6d0a2d9`): `AUTH_MODE=app` runs first-party sessions in a production build; fixture sign-in never does; failed password sign-ins throttled per email (drizzle/0037); accounts made with live X in production are real, not test data. | Live X and Google apps (D6, D7); first sign-up on staging. |
| E2 | Production file storage | **Built** (`6d0a2d9`): `SupabaseStorageProvider` (signed upload/download, private buckets), `pnpm storage:setup` creates buckets with type and size limits. Unit-tested with the API stubbed. | A Supabase project; the first real upload on staging. Supabase Free caps any upload at 50 MB — videos (250 MB) and zips (100 MB) need the Pro limit raised. |
| E3 | Scheduled jobs | **Built** (`6d0a2d9`): `/api/cron/jobs` behind `CRON_SECRET`, every job isolated. `vercel.json` now schedules it **once a day** (`0 3 * * *`), because Hobby refuses anything shorter, while the jobs were written for a five-minute tick. | Vercel Pro for the real schedule, before payments open. |
| E4 | Real payment rail | Not needed at launch (D3: no money). `PAYMENT_MODE=off` refuses every money step. | Choose a rail before payments open. |
| E5 | Transactional email | Open (D4). Email stays in the in-app timeline; password recovery says to continue with X or Google. | Sender domain and provider. |
| E6 | Launch-mode copy and flags | **Built**: banner and footer by environment (local sandbox / staging / early access), policy pages without sandbox text in production, test accounts hidden, money flags fail closed; today also a **Payments open later** note in place of booking, collateral, bidding, paying into escrow, hiring offers and reward pools, and sandbox wording on auctions and checkout limited to local and staging. | Real policy text (D8). |
| E7 | Deploy pipeline | **In use**: the app is deployed and public at `www.spaca.xyz` on the owner's Vercel and Supabase projects (each deploy still needs a go-ahead). Runbook: `docs/runbooks/11-deploy-vercel-supabase.md`. | Nothing gates a deploy on `env-check`, so a missing variable ships (audit F5); staging project, smoke, restore and rollback rehearsal. |
| E8 | Hardening added today | Security headers on every response (nosniff, referrer policy, permissions policy; in production also no framing and HSTS) and `/api/health` for uptime checks. | Monitoring service pointed at `/api/health` (D9). |

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
| D8 | Legal entity, terms, privacy, refund policy, support contact; platform fee decision (currently 0). | Policy pages are sandbox text today. The privacy policy must also cover Vercel Analytics, which is now in the deployed build. |
| D9 | Monitoring (Sentry DSN), backups/retention owner, incident contact. | Vercel Analytics is wired in (`@vercel/analytics`), counting page views on the deployments only, never locally. It has to be switched on for the project in Vercel before it records anything. |
| D10 | Dev data: done on 2026-09-18 on the user's "đồng ý dọn". The old development database is kept as `creator_marketplace_bak_20260918` and the old uploads as `.local/storage-bak-20260918`; the fresh one holds the nine fixture personas, one service and no orders. Production was always empty. | |

## 4. Suggested order once D1–D3 are answered

1. E1 production sessions for X/Google (and email), with `DEV_SESSIONS=off` enforced.
2. E2 Supabase Storage adapter with signed URLs, then E3 a protected scheduled jobs endpoint for the host's cron.
3. E6 launch-mode copy/flags for the chosen scope; E5 email if D4 is ready.
4. E7 staging project on the chosen host with its own database, storage and keys; smoke, restore and rollback rehearsal there.
5. E4 payment rail per D3 on staging (sandbox/testnet), then the owner's go/no-go for production.

## 5. Browser suite at this commit

The full suite is 78 tests across 31 spec files. The first full run reported 67 passed and 11 failed, and that
number is not usable: a Playwright run from an earlier attempt was competing for the same dev server and
database, and the dev server died partway through (`ECONNREFUSED`), failing everything after it.

Re-running each failing spec on its own against a restarted dev server resolved all eleven into three groups:

| Outcome | Specs |
|---|---|
| Passed alone — the earlier failure was the environment | `admin`, `auth-dialog`, `explore-create`, `funds`, `honest-states` (8/8), `onboarding`, `performance`, `request-hire` |
| A real regression, found and fixed | `item-auctions` — now 3/3 |
| A real failure, blocked on data | `publish` |

- **The regression was introduced this session.** `item-auctions.spec.ts` inherited the listing form's default
  minimum increment, and `258ecce` lowered that default from $10 to $5 with the other price examples, so the bid
  amounts the test asserts no longer matched. The test now fills the increment explicitly, since those amounts
  are arithmetic on the step and a suggested default is free to change.
- **`publish.spec.ts` passed once the development data was cleaned (2026-09-18).** Its fixture helper used to
  stop with "no removable test account left to free a slot", because `creator_d` held the maximum linked X
  accounts from earlier runs, each held by a published service. With the database reseeded it passes in 24.7s.
  No product code was involved.

Full detail, including the launch-gate secret-scan fix and the review of the cron, no-money and storage code:
`docs/evidence/claude-LAUNCH-PREP.md`.

### The run of 2026-09-18

The suite was re-run at `8b56d18` against a clean development database, in a container driving Chromium rather than
system Chrome (`d85df5a` made the browser configurable). **76 passed, 1 failed, 1 skipped in 18.5 minutes**, with no
spec needing a second run.

- `publish.spec.ts` **passes** (24.0s). The data it was blocked on is gone.
- The skip is the services strip's own guard: no published service in that database carries an approved public image.
- The failure is real and is in the product, not the test: `landing.spec.ts:56` finds `href="#services"` in both the
  landing navigation and the footer while nothing on the page carries `id="services"`. The strip renders only when the
  showcase query returns a service **with** a PUBLIC, APPROVED image sample — an inner `join lateral` — so on an empty
  or freshly seeded database both links lead nowhere. Production's database is empty, so the live landing carries the
  same two dead links. Whether to hide the links or keep an empty section is a product decision, so it was left for the
  owner: [the audit](evidence/claude-AUDIT-2026-09-18.md) §2.
