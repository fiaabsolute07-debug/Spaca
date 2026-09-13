# C1 — UI architecture split

Date: 2026-09-13. Engineer: Codex (Astra). Status: IMPLEMENTED, ready for Claude review.

Replaced the optional catch-all with 25 explicit App Router page files. Extracted shared presentation components and a typed private-route actor/login-prompt helper. No new dependencies or features. Platform fee remains 0%; the mock checkout is still labelled **Local test provider** and gated by `mockPaymentsEnabled()`.

## Old route → new file

Every route below previously rendered from `src/app/[[...path]]/page.tsx`.

| Old route | New file |
|---|---|
| `/auctions/[id]` | `src/app/auctions/[id]/page.tsx` |
| `/auctions` | `src/app/auctions/page.tsx` |
| `/buyer/orders` | `src/app/buyer/orders/page.tsx` |
| `/buyer/requests/new` | `src/app/buyer/requests/new/page.tsx` |
| `/buyer/requests` | `src/app/buyer/requests/page.tsx` |
| `/creator/auctions/new` | `src/app/creator/auctions/new/page.tsx` |
| `/creator/requests` | `src/app/creator/requests/page.tsx` |
| `/creator/services/new` | `src/app/creator/services/new/page.tsx` |
| `/creator/services` | `src/app/creator/services/page.tsx` |
| `/creators/[handle]` | `src/app/creators/[handle]/page.tsx` |
| `/dashboard` | `src/app/dashboard/page.tsx` |
| `/explore` | `src/app/explore/page.tsx` |
| `/orders/[orderId]` | `src/app/orders/[orderId]/page.tsx` |
| `/` | `src/app/page.tsx` |
| `/privacy` | `src/app/privacy/page.tsx` |
| `/refund-policy` | `src/app/refund-policy/page.tsx` |
| `/requests/[id]` | `src/app/requests/[id]/page.tsx` |
| `/requests` | `src/app/requests/page.tsx` |
| `/reset-password` | `src/app/reset-password/page.tsx` |
| `/services/[id]` | `src/app/services/[id]/page.tsx` |
| `/settings/profile` | `src/app/settings/profile/page.tsx` |
| `/sign-in` | `src/app/sign-in/page.tsx` |
| `/sign-up` | `src/app/sign-up/page.tsx` |
| `/support` | `src/app/support/page.tsx` |
| `/terms` | `src/app/terms/page.tsx` |

`/creator/requests` was an existing alias and is retained through the same `WorkspaceRequests` component as `/buyer/requests`. No speculative routes from the master roadmap were added.

The catch-all was removed only after all 25 pages existed and the first 180 fixture comparisons passed. All page files export `dynamic = 'force-dynamic'`. Entity routes await their promised `params`; every page awaits promised `searchParams`. Missing service, creator, request, auction, and authorized order lookups still call `notFound()`.

Unknown URLs and extra trailing path segments now resolve through the existing `src/app/not-found.tsx`, as required. The old catch-all incidentally accepted arbitrary suffixes on entity/policy paths and showed generic login/unavailable content on other unknown paths; that accidental routing is deliberately not reproduced. No new catch-all remains in source or the compiled route manifest.

## Shared components and types

| File under `src/components/` | Concern |
|---|---|
| `notices.tsx` | `Notices`: existing error/help and success copy, including array query values |
| `page-heading.tsx` | `PageHeading`: shared eyebrow, heading, optional description |
| `category-field.tsx` | `CategoryField` and the existing four taxonomy choices |
| `request-card.tsx` | `RequestCard`: brief, budget, hires, applications |
| `auction-card.tsx` | `AuctionCard`: bid/starting price, deadline, status |
| `workspace-sidebar.tsx` | `WorkspaceSidebar`: original dashboard navigation and profile |
| `order-workspace/brief-panel.tsx` | `OrderBriefPanel`: brief, deadlines, revisions, settlement |
| `order-workspace/delivery-panel.tsx` | `OrderDeliveryPanel`: versions, links, creator delivery form |
| `order-workspace/timeline-panel.tsx` | `OrderTimelinePanel`: original event timeline |
| `order-workspace/next-step-panel.tsx` | `OrderNextStepPanel`: unchanged role/state action predicates and local test checkout |
| `order-workspace/messages-panel.tsx` | `OrderMessagesPanel`: messages and send form |
| `auth-screen.tsx` | `AuthScreen`: shared sign-in/sign-up form |
| `policy-screen.tsx` | `PolicyScreen`: existing policy/support/recovery copy |
| `workspace-requests.tsx` | `WorkspaceRequests`: shared buyer/creator request listing |
| `require-actor.tsx` | `requireActorOrLoginPrompt`: discriminated union carrying an `Actor` or the original signed-out prompt; private reads occur after the guard |
| `page-props.ts` | `Query` and generic `PageProps` with promised route/search params |

Existing `ui.tsx` helpers were reformatted without changing their behavior. Command forms retain their action, command, hidden fields, `return_to`, and per-render UUID generation. `layout.tsx`, `globals.css`, `error.tsx`, and `not-found.tsx` are unchanged. No C1 edits were made to API routes, backend modules, read models, tests, migrations, scripts, dependencies, or shared configuration. Concurrent backend and C2 documentation changes were left to their owners. No git staging/commit/reset/stash/checkout commands were run.

## Exact verification commands and results

All required checks used this PATH prefix:

```sh
export PATH='/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':"$PATH"
```

### TypeScript

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false
```

Final result: **PASS, exit 0**, no diagnostics. Final output was captured in `/tmp/codex-c1-tsc-final.log`.

### Vitest

```sh
./node_modules/.bin/vitest run
```

Final result: **PASS, exit 0**. 4 test files passed, 5 skipped; **61 tests passed, 51 skipped (112 total)**. Duration 3.09s. DB integration was not enabled; skipped DB tests are not passes. Output: `/tmp/codex-c1-vitest-final.log`.

### Full production build

```sh
DATABASE_URL='postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace' NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:54321' NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='build-placeholder' NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build --webpack
```

Final result: **PASS, exit 0**, webpack compilation, TypeScript, page-data collection, static-page generation, and build tracing completed. Output: `/tmp/codex-c1-build-final.log`. The build printed this exact route table (API entries are existing integration output, outside C1's edit scope):

```text
Route (app)
┌ ƒ /
├ ƒ /_not-found
├ ƒ /api/auth
├ ƒ /api/commands
├ ƒ /api/dev/jobs
├ ƒ /api/dev/mock-checkout
├ ƒ /api/dev/session
├ ƒ /api/webhooks/mock-payment
├ ƒ /auctions
├ ƒ /auctions/[id]
├ ƒ /buyer/orders
├ ƒ /buyer/requests
├ ƒ /buyer/requests/new
├ ƒ /creator/auctions/new
├ ƒ /creator/requests
├ ƒ /creator/services
├ ƒ /creator/services/new
├ ƒ /creators/[handle]
├ ƒ /dashboard
├ ƒ /explore
├ ƒ /orders/[orderId]
├ ƒ /privacy
├ ƒ /refund-policy
├ ƒ /requests
├ ƒ /requests/[id]
├ ƒ /reset-password
├ ƒ /services/[id]
├ ƒ /settings/profile
├ ƒ /sign-in
├ ƒ /sign-up
├ ƒ /support
└ ƒ /terms


ƒ  (Dynamic)  server-rendered on demand
```

### Behavior comparison without a DB or browser

```sh
NODE_ENV=production PATH='/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':"$PATH" node /tmp/codex-c1-parity.cjs
```

Result: **PASS, exit 0**:

```text
PASS: 180 exact static HTML/missing-entity comparisons across 25 routes; deterministic read-model/auth fixtures, UUID normalized. No DB or browser.
```

This temporary verification harness uses the already-installed esbuild and React server renderer. It compares the saved original catch-all and original `ui.tsx` against the migrated routes with deterministic read-model/auth/provider fixtures; it resolves async server components before rendering and normalizes only generated idempotency UUID values. It checks exact markup, visible text, form actions, field/default values, links and return paths for:

- All 25 routes, signed out and signed in as buyer/creator, with empty/populated data and notice/search/auth query values.
- Order lifecycle states, buyer/creator actions, refund retry, review presence, and mock-payment enabled/disabled.
- Sold-out service, CREATE/PUBLISH/ACCESS copy, auction closed/bid-count conditions, request applications/offers.
- Missing entities on all five dynamic entity routes.

`NODE_ENV=production` selects React's production renderer for this temporary harness; it is **not** a production transaction or a live-provider verification. Provider enablement is explicitly stubbed for each case. Temporary harness/snapshots live under `/tmp/codex-c1-*`, are not committed, and are not a replacement for integration/E2E coverage.

Additional checks:

```sh
git diff --check -- src/app src/components
git diff --exit-code -- src/app/layout.tsx src/app/globals.css src/app/not-found.tsx src/app/error.tsx
```

Both passed, exit 0. A filesystem/compiled-manifest assertion also passed: exactly 25 dynamic pages, no optional catch-all, original error/404 shell retained.

### Earlier attempts and concurrent integration

Initial typecheck and full-build attempts stopped on two backend integration-test fixtures missing the newly required `Actor.status` and `Actor.timezone`. The first post-removal typecheck also saw stale `.next` catch-all types; Next regenerated those types during the build. Claude's concurrent fixture edits resolved the remaining errors without a C1 change outside its scope; final required checks above all passed. An earlier Vitest run passed 61 tests with 38 skips before concurrent DB tests were added.

While the fixture errors were outstanding, this supplemental command passed and printed the same route table:

```sh
DATABASE_URL='postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace' NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:54321' NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='build-placeholder' NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build --webpack --experimental-build-mode compile
```

That compile-only result was never treated as a full build pass. The later required default-mode build succeeded and is the final build evidence above.

## Not verified

- No PostgreSQL process, migrations, seed, DB integration suite, or real read-model/command round trip was run by Codex.
- No browser, responsive screenshots, keyboard/accessibility smoke, or E2E flow was run. Static HTML equivalence does not establish visual acceptance.
- No actual checkout/webhook, Supabase session, provider sandbox/testnet/live transaction, external email, or deployment was verified or performed. Network access/install was not used.

## Requests for Claude

- Review the C1 route/component diff and commit only the C1 paths, including this evidence file, under the collaboration rules.
- Run DB-backed integration and browser/E2E review in Claude's permitted environment, including the signed-out private-route return paths and unknown-URL 404 behavior.
- No outstanding backend/read-model/command change is required by C1. The transient `Actor` fixture mismatch was already resolved by Claude's concurrent changes.
