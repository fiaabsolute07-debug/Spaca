# Sign up with X only; email added later (2026-09-17)

Request: "luồng đăng kí chỉ cho X connect, gmail bind sau trong account" — sign-up only through X; the email is bound later from the account.

## What changed

- `drizzle/0035_x_sign_in.sql` — `app.users.email` may be null; `app.user_identities` (X user id → account, unique per source and subject, one X identity per account), back-filled from existing `x_profiles`; `x_oauth_states` gains `purpose` (CONNECT / SIGN_IN / SIGN_UP) and `account_type`, with `user_id` null for sign-in attempts (checked by constraints).
- `src/modules/x/service.ts` — `startXSignIn`, `xStatePurpose`, `completeXSignIn`, `getSignInMethods`. Saving an X connection now also writes the identity; buyers keep the profile copy without a linked account. `disconnect_x` refuses while the account has no email (X is its only way in) and removes the identity otherwise.
- `POST /api/auth/x` (form: intent, role, return_to) starts the attempt; `/api/x/callback` finishes a sign-in (session cookie, setup for new accounts) or a connection by the state's purpose.
- `/api/auth` — `signup` is refused ("New accounts sign up with X…"); `add_email` sets email and password once for the signed-in account (duplicate email refused); `login` unchanged.
- Dialog (`auth-dialog.tsx`), settings Sign-in panel, setup prefill from X for buyers too, sandbox consent page copy.

## Tests (local embedded PostgreSQL, dev server on 3100, sandbox X)

- `RUN_DB_INTEGRATION=1 vitest run tests/integration/x-sign-in.db.test.ts tests/integration/x-connect.db.test.ts tests/integration/onboarding.db.test.ts tests/integration/accounts.db.test.ts tests/integration/campaign-identity.db.test.ts` — 21 passed. New suite covers: sign-up per type (no email, identity, profile, verified linked account for creators only), existing X signs in from either dialog without a second account, unknown X on sign-in, cancelled / replayed / forged / cross-site attempts, protected X refused for creators, email sign-up refused, add_email validation / once / unique / then login, disconnect guard, connect-from-settings then sign in.
- Full Vitest: 419 passed, 3 skipped, 2 failed — `crypto.db.test.ts` passed when rerun alone; `digital.db.test.ts` XPL-05 fails repeatedly on the discovery search not returning the service (`availability_status` of `undefined`), unrelated to sign-in (no auth code path) and left for its owner.
- Playwright: `auth-dialog`, `onboarding`, `x-connect`, `honest-states` — 16 passed, then the 3 that failed passed on rerun (two load flakes, one locator fixed); `onboarding.spec.ts` 3/3 after the URL fix; new `x-sign-in.spec.ts` 1/1 (sign up with X, settings Sign-in, disconnect refused, add email, sign in with email, sign in with X).
- Browser walk-through with screenshots: join dialog, sandbox consent, setup with the notice and X name, settings before and after adding an email, sign-in dialog, unknown X account sent to sign-up. It left a sandbox account `@sxmu5d1rxt` in the dev database, plus accounts from the browser tests.

## Self-audit and limits

- Only local sessions: with `AUTH_MODE=supabase` (production) Continue with X answers "not available in this environment yet". Production needs X as a Supabase provider or first-party sessions before launch.
- Live X: every sign-in reads `/2/users/me` once (billed per user read). Sign-ins record the read but are never stopped by the monthly ceiling, so the ceiling no longer bounds spend on its own.
- Email is not verified (no email is sent in the sandbox); verification is needed before real use. Google sign-in ("Gmail") is not built: it needs a Google OAuth client from the owner.
- Anonymous starts are capped at 300 per 10 minutes across everyone; a flood can delay other people's sign-ins until states expire.
- One X account is one spaca account, so having both a buyer and a creator account needs two X accounts.
