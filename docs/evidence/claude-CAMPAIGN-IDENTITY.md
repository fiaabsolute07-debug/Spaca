# A campaign shows the project running it (2026-09-17)

The buyer's project name and logo were collected at setup (`complete_onboarding`, drizzle/0031) but only ever
appeared in the Account menu and the setup preview. A campaign said "by Sam Tran" in plain text on the board and
"Posted by Sam Tran · OPEN" in the page subtitle. Both now carry the logo beside the name.

## Change

- **`src/lib/read-model.ts`** — the four reads of `app.requests` that already joined the buyer now also
  `left join app.profiles bp on bp.user_id=r.buyer_id` and select `bp.avatar_asset_id as buyer_avatar_asset_id`:
  `getPublicData()` (the open board), `getGoalPageData()` (a goal tab), `getDashboardData()` (the buyer's own
  campaigns) and `getRequestData()` (the campaign page). The join is `left`, so a project without a logo still
  reads normally and returns `null`.
- **`src/components/campaign/campaign-by.tsx`** — new. The logo through the existing `Avatar` (which falls back to
  the project's initial, never to a blank), then "by *Name*" or "Campaign by *Name*".
- **`src/components/campaign/campaign-board.tsx`** — the board row's `by {name}` becomes `<CampaignBy>` at 18 px,
  inside the same muted line as the goal badge.
- **`src/app/requests/[id]/page.tsx`** — the heading's `description` string is replaced by a line under the title:
  the logo at 32 px, "Campaign by **Name**", then the status. `PageHeading` takes a plain string, so the block sits
  beside it rather than forcing a change on a component every page shares.
- **`src/app/globals.css`** — `.campaign-by` and `.campaign-by-line`.

The orders reads were *not* changed. A first pass caught them by accident (`bu.display_name as buyer_name` contains
the same substring as `u.display_name as buyer_name`), which would have referenced a `bp` alias those queries never
join and broken them at runtime. That was reverted before any test ran; a check now asserts every query selecting
`buyer_avatar_asset_id` also joins `bp`.

## Tests

`tests/integration/campaign-identity.db.test.ts` — 2 tests. A buyer uploads an `AVATAR`, finishes setup as
"Restake Labs" and posts a campaign; the asset id then comes back from all four reads (board, campaign page, goal
tab, the buyer's own campaigns). A project with no logo keeps its name and returns `null`.

## Results

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `RUN_DB_INTEGRATION=1 vitest run` | **389 passed, 3 skipped** (49 files, 1 skipped) |
| `TZ=UTC playwright test campaign-brief + campaign-tabs + request-hire` | 5 passed, 1 failed, then **6/6 on a clean re-run** |
| `tsx scripts/brand-contrast.ts` | **3295 text runs on 9 pages, all meet WCAG AA** |
| `tsx scripts/brand-shots.ts` | 22 screenshots, **no horizontal overflow** |

The one failure was `request-hire.spec.ts`: after "Accept offer" the browser stayed on `/requests/<id>` instead of
the new order. The run started seconds after `globals.css` and the campaign page were edited, which is the
hot-reload hazard the handoff already documents; re-running the spec with no edits in flight passed in 2.0 min.

## Not verified in the browser

No campaign in the development database has a buyer with a logo — the six buyer profiles that have one never
posted a campaign — so every campaign on the dev server renders the initial fallback, which is correct behaviour
for that data. The photo path is proven by the integration test, not by a screenshot.
