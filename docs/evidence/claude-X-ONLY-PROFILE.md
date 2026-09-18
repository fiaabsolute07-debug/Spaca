# An account made with X looks like its X account (2026-09-18)

Two things the owner asked for while testing the live site: fill a new account from X instead of from spaca's own
placeholders, and take Google and email off the dialog so only "Continue with X" is left.

## Filled from X

A sign-up with X already set `app.users.display_name` from the X name, and account setup pre-filled the name, handle,
bio and link from the saved X profile. What it never did was give the account a **photo**: `Avatar` drew a letter on a
circle until someone uploaded a file, even though `app.x_profiles.profile_image_url` was sitting there from the sign-in
read, and `XProfileCard` was already showing that same photo a few pixels away.

- `src/components/avatar.tsx` — takes an `imageUrl`, used when the account has uploaded no avatar of its own. It is
  X's own CDN with `referrerPolicy="no-referrer"`, the rule `XProfileCard` already followed.
- `src/lib/read-model.ts` — `getAccountSummary` joins `app.x_profiles` and returns `avatarUrl`, so the header and the
  account menu show the person's X photo from their first second on the site.
- Explore cards and details, the public creator page and account settings pass the photo they already load.
- `src/modules/x/service.ts` — `seedProfileFromX` writes `app.profiles` as a **creator** account is created: handle
  from the X username, bio from the X description, location, and the X link. A handle that is taken or shorter than
  three characters leaves the row unwritten, exactly as before, and setup asks for one. Nothing here costs an extra
  API call: every field comes from the profile the sign-in already read.
- Buyers are skipped on purpose. A buyer account is a project, not the person whose X account opened it, so its handle
  is still derived from the project name typed in setup and its introduction still describes the project. Seeding them
  too was the first attempt, and `onboarding.db.test.ts` caught it: the buyer kept the personal X username as its
  public handle.

## X as the only way in

- `EMAIL_SIGN_IN=off` hides "Continue with email" (`src/lib/environment.ts`, `auth-entry.tsx`, `auth-dialog.tsx`).
- `GOOGLE_PROVIDER=off` hides "Continue with Google", which the provider already supported.
- The line under the buttons changes with them, so the dialog never describes a button that is not there.

Both are environment switches, set on Vercel Production. Turning either back on is one value and a redeploy; no account
data is touched, and an account that connected Google keeps the connection.

## Checks

`tsc --noEmit` clean · `pnpm test:unit` **189 passed** · `RUN_DB_INTEGRATION=1 vitest run tests/integration`
**257 passed, 3 skipped, 0 failed** · production build compiles.

The five Google failures seen first were a stale `creator_marketplace_test`: it predated migration 0038.
`pnpm db:test:prepare` applied it and they passed. Worth remembering after any migration.
