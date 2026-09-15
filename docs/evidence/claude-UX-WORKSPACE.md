# Workspace frame, marketplace tabs, color, campaign brief and images, order receipt (2026-09-15)

Environment: LOCAL. Next.js 16 dev server on 127.0.0.1:3100, embedded PostgreSQL 18 (dev and test databases migrated to `0025_request_images`), Playwright with system Chrome, `LocalStorageProvider`, mock payment provider.

## What the user asked for (2026-09-15)
- Workspace: clicking anything loses the way back. Keep it in one frame, with no new tabs.
- Campaigns: redesign Post a brief with visual option buttons instead of the single "What are you offering?" dropdown, and add project images so creators can take in a campaign at a glance.
- Color on the important parts only. Explore, Campaigns and Auctions should show as small tabs instead of plain page jumps. A pill tab strip was built, then removed the same day at the user's request; the header links mark the current section.

## What changed
- `src/components/site-chrome.tsx`, `src/components/workspace-sidebar.tsx`, `src/app/layout.tsx`: for signed-in accounts, one persistent sidebar beside workspace and marketplace pages, with the current entry marked, and a "Back to <parent>" link. The dashboard no longer draws its own sidebar; the order page breadcrumbs went away.
- `src/components/header-nav.tsx`: the header section links mark the current section.
- `src/app/globals.css`: `--accent` blue on primary actions and the current location, one hue per category, choice cards and chips, campaign cards and gallery, receipt facts. Table cells no longer break short words in the narrower frame. The narrow-screen sidebar strip hides its scrollbar.
- `src/app/buyer/requests/new/page.tsx`, `src/components/category.tsx`: four category cards; Platform and Post format chips shown only for Publish; image upload in the brief.
- `drizzle/0025_request_images.sql`, storage policy, provider, service, cleanup job, `set_request_images` / `create_request image_ids`, `src/app/api/request-images/[id]/route.ts`, `src/components/request-card.tsx`, `src/app/requests/[id]/page.tsx`: campaign images end to end.
- `src/components/order-workspace/receipt-panel.tsx`: the ORD-01 receipt on the order page.

## Runs
- `tsc --noEmit`: exit 0.
- `RUN_DB_INTEGRATION=1 vitest run`: 311 passed, 3 skipped (37 files), before the REQ-11 additions. `storage.db.test.ts`: 13/13, including 3 campaign-image tests. They cover order kept; public only while the campaign is visible; unattached uploads private; creators refused (403); PDFs refused; other buyers' files and other purposes refused (404); at most 6; refused commands roll back; database foreign keys refuse a foreign or non-campaign asset; attached images cannot be deleted; replace, clear, and hidden after cancel except to the buyer. `tests/unit/storage-policy.test.ts` checks the `public-campaigns` bucket, image-only kinds and the object key format.
- Playwright:
  - `workspace-nav.spec.ts` 2/2. Sidebar stays and marks Overview → Orders → order (Orders stays current) → Back to Orders → Post a brief; one page in the context. Signed-out /requests has no sidebar or back link.
  - `campaign-brief.spec.ts` 1/1 (49.3s). Publish card reveals the posting chips, Thread chip, image upload reaches Ready, the published campaign shows "X · thread" and the image loads (naturalWidth > 0). creator_c sees the Campaigns header link current and no tab strip, the card with its image, the same image on the campaign, and no Replace images button.
  - `book-order.spec.ts` 1/1 with the receipt: after paying, Amount charged $100.00, Platform fee $0.00, Paid with Card, Paid on … UTC, Payment Paid, Creator payout "Held until the buyer approves". The creator sees the same receipt. After release, the payout reads "Released to the creator".
  - `honest-states.spec.ts` FND-04 (now checks the buyer sidebar has no creator links) and DSC-05: 2/2.
- Phone width (375×812, browser pane): brief form and campaign cards render, `scrollWidth` = `clientWidth` = 375.
- `tsx scripts/secret-scan.ts`: no findings.

## Found and fixed while verifying
- Uploads for the new purpose returned 500. `upload_intents_object_key_check` allows only letters before the first slash, and the key began `request_image/`. `objectKeyFor` now keeps letters only (`requestimage/`); nothing parses key prefixes.
- The E2E set the file before the page hydrated, so no upload started. The test now waits for hydration on the file input.
- The back link's arrow is `aria-hidden`, so its accessible name is "Back to …". The count-0 checks had been passing for the wrong reason and now use the real name.
- E2E global setup could hang forever on a warmup request. Each warmup fetch now aborts after 90 seconds.
- `escrow.anvil.test.ts` failed on a second run: its network fixture was inserted, never removed. The fixture now upserts; anvil suite 3/3.

## Follow-up the same day (user feedback)
- The user rejected the pill tab strip, so it was removed. The header links still mark the current section, and `campaign-brief.spec.ts` now also asserts the strip is absent.
- Sidebar profile display: the profile block began 10px left of the nav labels and showed only an initial. It is now a photo (or initial) beside name, email and account type, inset to line up with the nav labels. At 1000px wide the avatar and link text both start at x=30 and the email is not clipped.
- In the narrower frame the Profile page had cramped the photo card, and the file input read "No fil...chosen". Side panels now stack below 1240px and the file input spans its column: at 1000px the photo card is 650px wide and the input 542px.
- Explore at 1000px briefly kept an empty filter column from the new 220px rule. That rule now applies only from 1024px up, where filters are shown.
- Second pass on the profile: the user wants it as its own area, not inside the sidebar. The sidebar lost the identity block and the Account › Profile entry. The header shows the account photo as "Your profile". `/settings/profile` renders outside the workspace frame with "‹ Back to workspace" and the account type. `workspace-nav.spec.ts` covers the round trip.
- Reruns after the profile change: `auth-dialog.spec.ts` 5/5, `workspace-nav.spec.ts` 2/2, `explore-profile.spec.ts` 2/2, `campaign-brief.spec.ts` 1/1, FND-04 1/1. One combined run started right after the layout edit and had 3 failures: `ERR_CONNECTION_REFUSED` and an aborted page load while the dev server recompiled, plus a sidebar check that timed out on the cold dashboard. The same specs pass on the warm server. A manual browser round trip (Post a brief → Your profile → Back to workspace) keeps the sidebar.
- Third pass on the profile (user: remove the part on top, keep the rest as before): the header avatar is gone. The sidebar still has no identity block and gets its Account › Profile entry back. `/settings/profile` is inside the frame again, and the page keeps the account type in its eyebrow. Reruns: `workspace-nav.spec.ts` 2/2 (now opens Profile from the sidebar, checks it is current and that the header has no profile link) and `auth-dialog.spec.ts` 5/5 in 48.6s; FND-04 1/1. At 375px the page does not overflow and Profile is current in the sidebar strip.

## Limits
- Campaign images are not moderated; only the brief text goes through the content policy. Images are not resized, so cards download the full image (10 MB cap per file).
- Images are served through a 302 to a short-lived signed URL from the local storage provider. No Supabase Storage adapter exists.
- The receipt shows only stored values. Buyer totals and creator payout are not computed, because the platform fee model is undecided. Payments are the mock provider.

## REQ-11: application comparison
- `src/modules/requests/compare.ts` (pure sort, filter, summary and CSV); `src/app/requests/[id]/page.tsx` (buyer-only chips and summary line); `src/app/api/requests/[id]/applications/route.ts` (CSV download).
- `tests/unit/request-compare.test.ts` 4/4. It covers ordering by received time, lowest and highest quote (ties broken by received time), fastest delivery and recent update. The status filter leaves its input unchanged, and unknown or prototype-named parameters fall back to the defaults. The summary excludes withdrawn applications. CSV cells survive quotes, commas and newlines, and formulas get the apostrophe prefix.
- `tests/integration/requests.db.test.ts` 10/10, including the CSV route. Two applications come back in received order with `'=HYPERLINK` neutralized; the creator, an anonymous caller, a malformed id and an unknown id all get 404.
- `tests/e2e/request-hire.spec.ts` 1/1 (1.8 min). The buyer sorts by Lowest quote (URL and `aria-current` both checked). Filtering to Offer sent shows "No applications match this filter", then Waiting for you. The CSV returns 200 `text/csv` with the header row and `"SUBMITTED","100.00","24"`. The offer then proceeds as before.
- Limits: the browser journey has a single application, so multi-quote ordering relies on the unit and integration tests. Analytics are the summary line only.
- `tsx scripts/discovery-benchmark.ts` (test database) after these changes: all latency and plan checks passed. `escrow.anvil.test.ts` 3/3 after its fixture became rerunnable. `forge test` 17/17.
