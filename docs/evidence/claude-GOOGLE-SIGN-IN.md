# Connect Google and Continue with Google (2026-09-17)

Request: "thêm cả luồng connect bằng gg với cả gmail nữa đi". Built as: connect a Google (Gmail) account from settings, then sign in with it; sign-up stays X only as decided earlier the same day.

## What changed

- `drizzle/0036_google_sign_in.sql` — `user_identities` accepts provider GOOGLE (source MOCK / GOOGLE_API, Google `sub`, the verified email); `app.google_oauth_states` (single-use, hashed state, PKCE verifier, CONNECT bound to the signed-in account, SIGN_IN anonymous).
- `src/modules/google/provider.ts` — `LiveGoogleProvider` (authorization code + PKCE, scopes `openid email profile`, token exchange, one userinfo read, token revoked), `MockGoogleProvider` + `/dev/google-authorize` + `/api/dev/google/approve` (404 unless the sandbox is on), `googleMode()`.
- `src/modules/google/service.ts` — `startGoogle`, `completeGoogle`, `disconnect_google`, and `keepsAnotherSignIn`, now also used by `disconnect_x`.
- Routes `POST /api/auth/google` (intent connect | signin) and `GET /api/auth/google/callback`; sign-in dialog button; settings Google row; `env-rules` for `GOOGLE_*`.

## Tests

- `vitest run tests/unit/google-provider.test.ts tests/unit/x-provider.test.ts tests/unit/env-rules.test.ts` — 24 passed (request shapes with fetch stubbed, unverified email refused, errors carry no token, revoke on failure, sandbox stability, env selection and env:check).
- `RUN_DB_INTEGRATION=1 vitest run tests/integration/google-sign-in.db.test.ts tests/integration/x-sign-in.db.test.ts tests/integration/x-connect.db.test.ts` — 16 passed: connect then sign in, unknown Google to sign-up, one Google per account and replacement, connection bound to the starting account, cancel / replay / cross-site / anonymous connect, last way in kept across X, Google and email.
- Full Vitest: 431 passed, 3 skipped, 1 failed — `digital.db.test.ts` XPL-05 (discovery search does not return the service), the same unrelated failure as before this change.
- Playwright `auth-dialog`, `onboarding`, `x-sign-in`, `google-sign-in` (new), `x-connect` — 13 passed.
- Screenshots checked: sign-in dialog, sandbox chooser, settings before/after connecting, settings at 390 px (no horizontal scroll). A hydration warning appeared only when a script clicked before the page finished loading; loading each page without clicking logs none.

## Limits

- Live Google needs the owner's Google Cloud OAuth client (web application, consent screen, redirect URI above). Not created here; no key was typed or read.
- Like X, Continue with Google works with local sessions only until production auth is decided.
- The Google address is shown and offered for email sign-in but is not the account email; an email and password are still added separately.
