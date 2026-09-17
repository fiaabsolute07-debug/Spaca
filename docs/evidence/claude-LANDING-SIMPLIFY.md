# Landing simplified: the hero, the goals, three strips of real stock (2026-09-17)

User's instruction: *"sửa lại trang landing, tối giản lại các nội dung, chỉ giữ các phần quan trọng không thừa,
như là service, tham khảo fiverr"* and *"giới thiệu thêm cả tính năng auctions nữa"*.

## What the page is now

| # | Section | State |
|---|---|---|
| 1 | Hero video + marketplace search (tablist, popular-campaign chips) | unchanged |
| 2 | Seven campaign goal tiles, moving line drawings, real open counts | unchanged |
| 3 | **Services** — a grid of published services that have a picture | new |
| 4 | **Creators available** — photo, @handle, field, lowest price, whether they take orders | new |
| 5 | **Auctions** — up to three real open item auctions, or the mechanism in three lines | new |
| 6 | Questions (FAQ) | kept, two entries rewritten |
| 7 | Closing call to action | unchanged |
| 8 | Footer | kept; three dead anchors repointed |

Removed, as the user asked: the four-fact bar (Paid on approval · Sponsored posts disclosed · No wallet needed to
hire · Reward pools on testnet), the 3D "How a campaign moves" block, and the moving reward-pool diagram. Removed
with them, because nothing else used any of it: `Why spaca`, `Three ways to hire`, the `Reward pools` tile, `For
creators`, `Clear rules for sponsored content` and the `AI and SaaS` strip. The user chose this scope directly
("6 mục + giữ FAQ và CTA cuối") when asked, because the handoff's own structure list and its shorter "Bỏ hẳn"
list disagreed about how much to cut.

## Two decisions the user made during the work

**1. The auctions strip describes item auctions, not slot auctions.** The handoff told me to write "a creator
opens an auction for ONE slot of a published service" and to read `getPublicData().auctions`. While I was reading
the repo, the other session committed `e36fb80`, which retires exactly that feature — `src/app/creator/auctions/
layout.tsx` now says *"Creator slot auctions were replaced by web3 item auctions (2026-09-17)"* and redirects to
`/auctions/new`. Writing the handoff's copy would have described a feature that no longer runs and linked to a
page showing something else, against the rule that auction copy may only describe what actually runs. The user
chose the item-auction model. The strip now reads from `app.item_listings` (drizzle/0033).

**2. Writes were held while the other session's Playwright run was in flight.** Their run (including
`landing.spec.ts`) was live when this session started; every edit waited until it finished, per the rule against
touching the repo during a test run. This session's own runs all used `--output=test-results/e2e-landing-claude*`.

## How each strip stays honest

- **Nothing is invented.** `PopularServices`, `CreatorsAvailable` and the auction grid each render `null` (or the
  explanation, for auctions) when they have no rows. There is no placeholder card anywhere in
  `src/components/landing/showcase.tsx`.
- **"Popular" is a claim, so it is earned.** The heading says **Popular services** only when at least three of the
  listed services clear the same bar `trending-v1` uses (≥3 completed orders in 30 days *and* ≥20 eligible views in
  7 days). Otherwise it says **New services** and states why: "Not enough completed orders yet to rank them by
  demand." This follows DSC-04, which already forbids calling anything trending without the evidence. On the
  development database today the label is **New services**, correctly.
- **A service needs a picture to be on the strip.** It joins through an approved, `PUBLIC` image sample
  (`service_samples` → `samples` → a `READY` `storage_assets` row with an `image/*` mime), served by the existing
  `/api/samples/<id>` route that enforces moderation. A link-only or still-pending sample never appears.
- **Creator status is the buyer-facing one.** `availabilityLabel` from `@/components/ui`, the same words Explore
  uses, and green only when orders can actually be placed (§6.1 rule 10 — a status, never counts).
- **The auction words describe the running mechanism.** With listings: item type, title, project and seller,
  current bid or starting price, the minimum increment, the collateral and the time left on the server's clock.
  With none: the seller locks collateral before the listing opens; the winner pays into escrow within
  `ITEM_PAYMENT_HOURS` (24); delivery is confirmed within `ITEM_CONFIRM_HOURS` (72) or the money comes back with
  the collateral. Both states carry "Sandbox: collateral and escrow are recorded by spaca and no funds move."
- **The landing still opens when the database does not.** `getLandingShowcase()` wraps its reads in try/catch and
  returns empty strips, the same way `getOpenGoalCounts()` already did.

## Copy corrected while rewriting the page

Two FAQ answers had gone stale and were fixed rather than carried forward:

- *"Do creators connect their X account?"* said **"No. Creators share links to their work; we never ask for access
  to their account."** Connect X shipped in `0039070`, so this was false. It now says connecting is optional, reads
  the public profile once, and that the token is revoked immediately and spaca never posts for them.
- A new entry, *"What is an auction for?"*, describes the item-auction mechanism, since the "Three ways to hire"
  card that used to explain auctions is gone.

No fee number was written anywhere; the fee answer still carries `[FEE POLICY — published before launch]`.

## Code

| File | Change |
|---|---|
| `src/lib/read-model.ts` | `getLandingShowcase()`: three lean queries plus the server clock, the POPULAR/NEW decision, per-creator availability, ISO 8601 auction instants, and a try/catch so the page survives a dead database |
| `src/components/landing/showcase.tsx` | new — `PopularServices`, `CreatorsAvailable`, `AuctionsStrip` and their tiles |
| `src/app/page.tsx` | rewritten to the eight-section structure; nav and footer anchors repointed; two FAQ answers fixed |
| `src/components/landing/landing.module.css` | new strip styles; 121 dead rules, 10 dead tokens and one dead keyframe removed after grepping every file that imports the module |
| `src/components/landing/launch-stack.tsx`, `pool-flow.tsx` | deleted — nothing imported them once the 3D block and the pool diagram went |
| `vitest.config.ts` | `include` also matches `tests/**/*.test.tsx`, so components can be rendered in a test |

`getPublicData().auctions` is left alone: it still reads `app.auctions`, which other pages use, and the landing no
longer touches it.

## Tests

- `tests/unit/landing-strips.test.tsx` — **10 tests**, `react-dom/server`. Renders every strip in both states:
  with rows and empty; POPULAR vs NEW wording; "Starting at" before a bid and "Current bid" after; a countdown to
  an auction that has not opened; a paused creator never shown as available; and, for the empty auction strip,
  that the three explanation lines appear with no price, no countdown and no card. This is where **both states of
  the auctions strip** are proven, because the browser can only see whichever state the development database is in.
- `tests/integration/landing.db.test.ts` — **6 tests** against the test database. A service appears only after a
  moderator approves its public image and never on a link-only sample; the label is NEW without demand evidence; a
  creator carries the lowest price they publish and flips to PAUSED through `set_accepting_orders`; an open item
  listing appears with a browser-parsable ISO instant and disappears once cancelled or ended.
- `tests/e2e/landing.spec.ts` — rewritten, **9 tests**. Section order and the absence of all three removed blocks;
  every in-page `#anchor` in the header and footer resolves to a section that exists; each service tile links to a
  real service and shows a real `/api/samples/` picture and a price; each creator tile shows a price and a status;
  the auctions strip shows real tiles *or* the explanation but never both, and following a tile reaches the
  listing; footer has no `[PLACEHOLDER]`; reduced motion; and no horizontal scroll at 375 px past every strip.

## Results (this tree)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `RUN_DB_INTEGRATION=1 vitest run` | **387 passed, 3 skipped** (48 files, 1 skipped) |
| `TZ=UTC playwright test tests/e2e/landing.spec.ts` | **9 passed** (26.1 s) |
| `TZ=UTC playwright test public + responsive + header-menus` | **8 passed** (2.6 min) |
| `tsx scripts/brand-contrast.ts` | **3115 text runs on 9 pages, all meet WCAG AA** |
| `tsx scripts/brand-shots.ts` | 22 screenshots, **no horizontal overflow** at 1280 px or 375 px |

One contrast failure was found and fixed on the way: `.auctionFoot` ("Bid in steps of … · collateral …") was set
in `--text-3` (48 %) and measured 4.22:1 on a card. Those are terms a bidder acts on, not decoration, so it now
uses `--text-2`.

## What the development database makes the page look like

The strips are real, and today the reality is thin and ugly:

- **4** of 457 published services have an approved public image sample, so the services grid holds four tiles.
- Every one of those samples is the **1×1 transparent PNG** the e2e suites upload, so the tiles paint as flat dark
  rectangles. `/api/samples/<id>` returns them correctly (`200`, `image/png`, 70 bytes) — there is nothing to fix
  in the page; the fixtures are simply not pictures.
- The service and creator names are e2e leftovers (`E2E sample-media 1789624895533-…`, six creators all called
  "Fresh Creator" with `@new888378924`-style handles).
- **6** item listings are open; the strip shows the three closing soonest, and those look right.

This is the accumulated e2e data the user has already been asked about. It is one more reason to run the cleanup
that is still waiting on **"đồng ý dọn"**; the page itself needs no change for it.

## Noted, not changed

The landing's light/dark switch reports the wrong state before a choice is stored: with no stored preference the
CSS keeps the page dark (only `html[data-landing-theme="light"]` makes it light, and the module has no
`prefers-color-scheme` rule), but `ThemeToggle` marks **Light** as checked when the system prefers light. Default
dark is intact, as required; the radio's checked state is cosmetic and predates this work, so it was left alone.
