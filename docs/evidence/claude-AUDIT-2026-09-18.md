# Self-audit (2026-09-18, at `8b56d18`)

The first audit since `d898592` (2026-09-15), which covered the tree at migration 0025. The tree is now at migration
**0037**, and since that audit the app has been deployed and is public at `www.spaca.xyz`. So this pass covers what the
earlier one could not: the production surface — sessions, OAuth, cron, storage, headers, environment — and everything
built between the two.

Environment: a Linux container, not the usual macOS machine. Node **22.22.2** (the repo asks for 24), **PostgreSQL 16**
in place of the embedded PostgreSQL 18, whose binaries need `libicuuc.so.60` and cannot start in this image; Foundry
1.5.1 with solc 0.8.30; Playwright driving the container's own Chromium 1194 instead of system Chrome (`d85df5a` made
that configurable). Nothing was deployed, sent, or run against testnet, mainnet or the live site. The live site could
not be reached at all: this environment's network policy answers 403 to `www.spaca.xyz`.

## 1. What was run

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `RUN_DB_INTEGRATION=1 vitest run` | **444 passed, 3 skipped** (60 files; the 3 skipped are the anvil suite) |
| `RUN_ANVIL=1` escrow suite | **3 passed** — first run since the last audit |
| `forge test` | **19 passed** (16 unit and fuzz, 3 invariant; 16,384 calls per invariant, 0 reverts) |
| `release:check` | every check PASS |
| Secret scan, tracked files | 570 files, no findings |
| Secret scan, production client bundle | 42 files in `.next-scan/static`, no findings |
| Production build (`next build`) | compiles in 11.5s, no warnings |
| Playwright (`TZ=UTC`, 31 spec files) | **76 passed, 1 failed, 1 skipped** in 18.5 minutes — §2 |
| `reconcile:dry-run` | 5 checks agree over 17 transactions, 2 UNCHECKED |
| `restore-rehearsal` | restore verified: 81 tables, 776 rows, 11 files, **8 invariants, 0 violations**, replay a no-op, 10.2s |

All 37 migrations applied unchanged on PostgreSQL 16, and every suite passed there: the schema uses nothing specific to
18. Two checks the last audit ran are missing here and belong on the owner's machine: `discovery-benchmark` and
`brand-contrast` / `brand-shots`.

The money checks were run **twice**. The first run, on the freshly reseeded database, reported "0 transactions" and
"0 orders": those PASSes were true and empty. The numbers above are the second run, after the browser suite left 17
orders, 34 ledger entries and 11 stored files behind — those are the ones that mean something.

## 2. The browser suite, and the one real failure

76 of 78 tests pass. One is skipped by its own guard (the services strip has nothing to assert about when no published
service carries an approved public image). One fails, and it is a real defect, not the container:

**`landing.spec.ts:56` — the landing links to `#services`, which does not exist when no service can be shown.**
`src/app/page.tsx` renders `href="#services"` twice, unconditionally: once in the page's own navigation (line 55) and
once in the footer's Product column (line 39). The section carrying `id="services"` comes from `PopularServices`
(`src/components/landing/showcase.tsx:34`), which returns `null` on an empty list. The list comes from
`landingShowcase` (`src/lib/read-model.ts`), where the sample image is an **inner** `join lateral`: a published service
with no PUBLIC, APPROVED image sample is dropped from the query entirely. With nothing left, both links point at an
anchor that is not on the page and clicking them does nothing.

This did not fail before because the old development database was full of services with approved samples. It surfaced
the day after that data was cleaned — and an empty database is exactly the state production is in. **The live landing
almost certainly carries the same two dead links today.**

**Fixed the same day, on the owner's "sửa link chết trên service luôn".** The links now go where the section goes:
`LandingPage` computes which strips will render and drops the matching links from both the navigation and the footer.
Hiding them matches the rest of the landing, which already refuses to show a strip it has no real content for.

`#creators` had the same defect and no test had caught it: `CreatorsAvailable` also returns `null` on an empty list,
and the only reason the suite stayed green there is that the database happened to hold creators. It is fixed with the
same change. `#auctions`, `#faq` and `#top` always render, so they were never at risk.

Verified in both directions against a real dev server, because one state alone proves nothing here:

| Database | `href="#services"` | `id="services"` | `href="#creators"` | `id="creators"` | `landing.spec.ts` |
|---|---|---|---|---|---|
| empty (migrated, not seeded) | 0 | 0 | 0 | 0 | 7 passed, 2 skipped by their own guards |
| the dev database after the suite | 2 (nav + footer) | 1 | 1 | 1 | 9 passed, nothing skipped |

`public.spec.ts` passes alongside it (11 passed in total on the populated run). Every remaining `href="#…"` on the page
resolves to exactly one element in both states, which is what `landing.spec.ts:56` asserts.

## 3. Findings

Ordered by what they would cost. None is an open door for an anonymous attacker today; they are where the next problem
comes from.

### F1 — There is no real Content-Security-Policy (medium)

`next.config.ts` sets `Content-Security-Policy: frame-ancestors 'none'` in production, and nothing else: no
`default-src`, no `script-src`. Any script that reaches a page — through a dependency, a future
`dangerouslySetInnerHTML`, or an injection the escaping misses — runs with full rights. The app is clean today: no
`dangerouslySetInnerHTML`, no `eval`, no `new Function` anywhere in `src/`, and every `target="_blank"` carries
`rel="noreferrer"`. That is exactly when a policy is cheap to add.

Fix: a nonce-based policy (`script-src 'self' 'nonce-…' 'strict-dynamic'`), report-only for a week first.

### F2 — Sign-in throttling counts the address, not the caller (medium)

`src/app/api/auth/route.ts` allows 10 failed password attempts per address per 15 minutes (`app.sign_in_attempts`,
keyed on `sha256('sign-in:' + email)`). Two consequences:

- **Spraying is unthrottled.** One attempt against each of a thousand addresses never trips a counter.
- **Anyone can lock anyone out.** Ten deliberate failures against a known address deny that address for 15 minutes.
  The message offers X and Google as a way around, which softens it, but a password user is locked out by a stranger.

Fix: count per IP as well as per address, and prefer a growing delay over a refusal so the real owner still gets in.

### F3 — `add_email` never proves the address (medium)

`action=add_email` writes `email` and `password_hash` onto the signed-in account with no verification mail, because
E5 is not built. An account can therefore claim an address it does not own; the unique index then stops the real owner
from ever using it, and from that point "email" is an identity nothing has checked. It is safe while nothing trusts
email — but password recovery is the obvious next feature, and it would inherit an unverified address.

Fix: hold the address unverified until a signed link is followed, and do not let an unverified address sign in.

### F4 — Payments default to open when `PAYMENT_MODE` is missing (medium)

`paymentsOpen()` is `process.env.PAYMENT_MODE !== 'off'`. A deployment that loses the variable — a new environment, a
typo, a forgotten preview — advertises booking, hiring, bidding and pools again. No money can actually move
(`mockPaymentsEnabled()` is false in a production build and no real rail is wired, so the attempt ends in
`UNAVAILABLE`), so this is a promise the product cannot keep rather than a way to move money. The launch decision was
"no money at launch", and the code should fail that way on its own.

Fix: in production treat a missing `PAYMENT_MODE` as `off`; require the variable explicitly to open payments.

**Fixed 2026-09-19.** `paymentsOpen()` now answers false in a production build unless `PAYMENT_MODE` is set to
something other than `off`; outside a production build an unset value still means the local sandbox, so mock payments
keep working without anyone setting it. Covered in `tests/unit/environment.test.ts`.

### F5 — Nothing enforces `env-check` at deploy time (medium)

`scripts/env-check.ts` already knows the right answers: a deployed target requires `APP_BASE_URL`, `AUTH_MODE`,
`DEV_SESSIONS=off`, `PAYMENT_MODE` and a `CRON_SECRET` of at least 32 characters. But `package.json` builds with a bare
`next build` and `vercel.json` sets no `buildCommand`, so a deployment missing any of them builds and ships. That is
what makes F4 reachable in the first place.

Fix: `"buildCommand": "tsx scripts/env-check.ts production && next build"` in `vercel.json`.

**Fixed 2026-09-19.** `vercel.json` now builds with `pnpm env:check ${APP_ENV:-production} && pnpm build`, so a
deployment missing a variable fails at build rather than in front of a visitor. Checked against the real production
values: complete environment exits 0; dropping `CRON_SECRET` or `PAYMENT_MODE`, or setting `DEV_SESSIONS=on`, exits 1;
an unset `APP_ENV` falls back to the production rules and `APP_ENV=staging` checks the staging ones.

### F6 — The database connection is encrypted but not authenticated (medium)

`src/lib/db.ts` passes `ssl: 'require'` for every non-local host. In postgres.js, `'require'`, `'allow'` and `'prefer'`
all set `rejectUnauthorized = false` (`postgres/src/connection.js:283`), so the driver accepts any certificate. Traffic
to Supabase is protected against a passive listener and not against one that can answer as the host.

Fix: `ssl: { rejectUnauthorized: true, ca: <Supabase CA> }`, or `'verify-full'` with the CA present.

### F7 — `/api/auth` reports unexpected errors as a wrong password (low)

The route ends in `catch { … failure() }` with no `logError`. A database outage, a bad migration or a bug is shown to
the person as bad credentials and leaves nothing in the log.

**Fixed 2026-09-19.** The catch now calls `logError('sign-in route failed', error)` before answering, which keeps the
redaction `src/lib/log.ts` already applies — name, first message line, code, constraint, table, routine, four frames.

### F8 — Password sign-in answers faster for an address that does not exist (low)

With no matching user row, `verifyPassword` is never called, so the scrypt work is skipped and the answer comes back
measurably sooner. The body is identical; the timing is not, and that is enough to enumerate addresses.

Fix: verify against a dummy hash when the row is missing.

**Fixed 2026-09-19.** `DECOY_PASSWORD_HASH` (`src/lib/auth.ts`) is shaped like a stored hash, so an address with no
account — or an account with no password, as every X and Google sign-up has — pays the same scrypt cost and still
answers false. `tests/auth.test.ts` asserts both the shape (or `verifyPassword` would bail on the format and skip the
work the fix depends on) and that it never verifies.

### F9 — The deployed cron runs daily; the jobs were written for every five minutes (informational)

`vercel.json` schedules `/api/cron/jobs` at `0 3 * * *`, because Hobby refuses anything shorter (E3). With payments off
nothing is late in a way that costs money, but `auto_accept_deliveries`, `expire_checkout_holds` and
`release_ready_settlements` all assume a short tick. The route also declares `maxDuration = 300`, which the plan may cap
lower. Both need settling before payments open.

## 4. What the code review found sound

The production surface added since the last audit holds up where it counts:

- **OAuth.** X and Google both use PKCE; state is stored hashed, single-use (`used_at`), expiring, rate-limited per
  account per 10 minutes, and claimed under `for update`. Google matches an account by **provider subject only, never
  by email**, so a matching address cannot take over an account. Both callbacks send `referrer-policy: no-referrer` and
  `cache-control: no-store`, so the authorization code does not travel on to the next page.
- **Sessions.** 32 random bytes, stored as sha256, 7-day expiry, cookie `httpOnly` + `sameSite=lax` + `secure` on
  https; signing in deletes the previous session row (rotation). Roles come from the user row and active grants, never
  from the request.
- **Dev surfaces.** `/api/dev/*` return 404 unless the build is non-production **and** the sandbox mode is on, and the
  fixture session route additionally refuses any non-loopback host. `release:check` asserts this independently.
- **Cron.** `timingSafeEqual` against `Bearer <CRON_SECRET>`, and a 404 — not a 401 — when no secret of at least 32
  characters is configured, so the route does not announce itself.
- **Storage.** Every Supabase bucket is private; bucket names and key shapes are validated before any call; downloads
  are short-lived signed URLs; public pictures still pass through app routes that check visibility and moderation.
- **X tokens are not stored at all** (`drizzle/0032`), so there is no long-lived third-party credential at rest.
- **Money maths.** The performance bonus is `bigint` throughout, capped twice (views cap from the creator's median,
  and the bonus cap), with the unused hold returned as `bonus_cap − bonus`.
- **Funds queries** are scoped to `buyer_id = actor` or `creator_id = actor` in every branch.

## 5. What this audit could not cover

- **The live site — the surface that now matters most.** This environment's proxy refuses `www.spaca.xyz` (403 on
  CONNECT), so the deployed headers, the closed dev routes, `/api/cron/jobs` without its secret, and the real
  time-to-first-byte are all unverified. They need one pass from the owner's machine.
- **Independent review.** Nothing here is one. `SpacaEscrow` still has no independent audit, and mainnet and real money
  still wait on one (D3).
- **Supabase in practice.** Buckets, their size limits and the service-key boundary are reviewed as code, not exercised
  against a project.
- **The runtime.** Node 22 is not the Node 24 the deployment runs, and PostgreSQL 16 is not 18. Everything passing here
  is evidence, not the same evidence a run on the owner's machine would give.
- `discovery-benchmark`, `brand-contrast`, `brand-shots`.

## 6. Follow-up (2026-09-19)

F4, F5, F7 and F8 are fixed, each noted under its finding above. Checks at that commit: `tsc` clean, vitest
**447 passed / 3 skipped**, `release:check` every check PASS, secret scan clean, production build compiles, and the
three browser sign-in specs (`auth-dialog`, `x-sign-in`, `google-sign-in`) **8 passed**.

Still open, in the order they are worth doing:

- **F2** (sign-in throttling per address, not per caller) — needs a migration for the IP counter, so it is the next
  real piece of work rather than a small fix.
- **F1** (no real Content-Security-Policy) — a nonce-based policy through middleware, report-only first.
- **F3** (`add_email` never proves the address) — blocked on E5: there is no way to send the verification mail yet.
- **F6** (the database connection accepts any certificate) — needs the Supabase CA and a connection to test against,
  which this environment cannot reach.
- **F9** (the cron runs daily, the jobs assume five minutes) — waits on the hosting plan, before payments open.
