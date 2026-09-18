# Sign up with Google, not only with X (2026-09-18)

Until now an account could only be created by signing up with X: `POST /api/auth action=signup` refused email sign-up,
and a Google account nobody had connected was told to "Sign up with X, then connect Google from your account settings".
That made the X developer app a hard launch dependency — with `X_PROVIDER` unset, `xMode()` returns `off` in a
production build, so **nobody could create an account at all**. The owner asked for Google to open sign-up as well.

## What changed

| Piece | Change |
|---|---|
| `drizzle/0038_google_sign_up.sql` | `google_oauth_states.purpose` accepts `SIGN_UP`, and the table carries `account_type` with the same `(purpose = 'SIGN_UP') = (account_type IS NOT NULL)` rule `x_oauth_states` has |
| `src/modules/google/service.ts` | `GoogleIntent` gains `SIGN_UP`; `startGoogle` refuses a sign-up with no account type and stores the chosen one; `completeGoogle` creates the account when the Google account is unknown and the state was a sign-up |
| `src/app/api/auth/google/route.ts` | accepts `intent=signup` with `role`, mirroring `/api/auth/x` — anything but `creator` is a buyer account |
| `src/components/auth/auth-dialog.tsx` | **Continue with Google** now renders in the join dialog too, disabled until a type is chosen and pointing at the same hint as Continue with X |
| `src/app/api/auth/route.ts` | the email sign-up refusal now says "New accounts sign up with X or Google" |

The new account is created exactly as an X sign-up creates one: `roles` is the single chosen type, `is_test` follows
the same rule (a local build or the sandbox provider), `onboarded_at` is null so setup comes first, and the return
path is carried through `/welcome`.

**`users.email` is deliberately left null.** That column is the address that signs in with a password, and a Google
sign-up has not set one. Filling it from Google would claim an address the account cannot yet use, block
`add_email` ("This account already has an email"), and turn a Google address that already belongs to another account
into a unique-constraint failure in the middle of sign-up. Google's verified address is kept on `user_identities`,
shown in Settings → Sign-in, and offered as the default when an email and password are added.

Behaviour kept from before: one Google account belongs to one spaca account, so signing up again with an account that
already exists signs in to it instead and does not change its type; an unknown Google account on the **sign-in** dialog
is now offered sign-up ("Choose Buyer or Creator to create one.") rather than sent to X; Google accounts with no
verified email are still refused by the provider.

## Checks

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `RUN_DB_INTEGRATION=1 vitest run` | **446 passed, 3 skipped** (was 444 + the two tests added here) |
| `tests/integration/google-sign-in.db.test.ts` | 6 passed |
| Playwright: `google-sign-in`, `auth-dialog`, `x-sign-in`, `onboarding`, `workspace-nav` | **15 passed** |
| `release:check` | every check PASS |
| `secret-scan` | no findings |

New coverage:

- **Integration** — a Google sign-up creates a creator account with `roles=['creator']`, `users.email` null, the
  verified address and `last_sign_in_at` on the identity, the display name Google reported, `onboarded_at` null, and
  `/welcome?return_to=/explore`; signing up again with the same Google account produces one identity, not two, keeps
  the original type and answers "already has a spaca account"; a sign-up with no account type is refused before Google
  is opened, so no state row is left to claim.
- **Browser** — from `/sign-up`, both Continue buttons are disabled until a type is picked; choosing Creator enables
  them; Google's sandbox chooser returns to setup with "Signed up with Google as …", the Account menu shows a creator
  account with "Finish setup" and My services, and signing out and back in with the same Google account returns to the
  same account.

One existing assertion moved with the copy: `x-sign-in.db.test.ts` expected the old "New accounts sign up with X."
refusal.

## What this does not change

- **X is still needed for a creator to publish a PUBLISH service**, and a creator account made with Google has no X
  connected until they connect one from settings.
- Email and password remain sign-in only, still unverified (audit F3), and password recovery still does not exist
  (E5).
- Nothing about live configuration changed. `GOOGLE_PROVIDER=live`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
  still what turns Google on, with the redirect URI `<APP_BASE_URL>/api/auth/google/callback`. The difference is that
  those three now open sign-up on their own, without an X app.
