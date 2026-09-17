# Notifications bell and the organised overview (2026-09-17)

Request: move the notifications out of the overview into a header icon, and organise the overview more systematically.

## What changed

- `src/modules/notifications/inbox.ts` — `unreadCount` (capped at 100), `listInbox`, `markRead` (one or all); only the recipient's own `in_app` rows. Link paths that are not a site path fall back to `/dashboard` (the table already only accepts `^/[A-Za-z0-9_/-]*$`; `//` is refused as well).
- `POST /api/notifications` → `{ unread, items }`; `POST /api/notifications/read` → `{ unread }` (JSON), or a same-origin form post that marks everything read and returns 303 to `/notifications`. Both go through the same-origin and session checks (`jsonRoute`, `isSameOrigin`).
- `src/components/notifications/notification-menu.tsx` (the bell), `notification-list.tsx`, `notifications.module.css`, `src/app/notifications/page.tsx`; the root layout loads the unread count together with the account summary.
- `src/modules/workspace/overview.ts` — `getOverview`: the action list is worked out from order, hire offer, campaign application, item sale and item listing states; numbers from one aggregate over the account's orders. Orders that can still ask something of either side are read by state (up to 500, however old); the recent table is a separate query of the latest six.
- `src/app/dashboard/page.tsx` + `overview.module.css` — setup nudge, heading, At a glance, Needs your action, Shortcuts, Recent orders.
- `/notifications` added to the private paths (`next.config.ts`, `src/lib/seo.ts`) and to the back-link segments (`site-chrome.tsx`).
- `globals.css` — the header's second row starts at 860 px instead of 640 px (at 768 px the bell, the Beta tag, Fund and Account made the header 783 px wide).

## Tests (local, embedded PostgreSQL + dev server on 3100)

- `RUN_DB_INTEGRATION=1 vitest run tests/integration/overview.db.test.ts` — 2 passed: unread count, newest first, marking only the reader's own read (another account's notification stays unread), signed out 401, cross-site 403, the count stops at 100; each side's actions, soonest first, with the collateral to-do for an item listing.
- Full Vitest before the query change: 394 passed, 3 skipped. `tsc --noEmit` clean after it.
- Playwright `overview.spec.ts`, `funds.spec.ts`, `header-menus.spec.ts`, `responsive.spec.ts` — 11 passed after the query change. `funds.spec.ts` now expects the order bell → Fund → Account.
- Flaky under a loaded machine, passing when rerun: `funds.spec.ts` "Fund … toBeFocused" after Escape (passed 2/2 when run alone), `onboarding` / `auth-dialog` upload steps.
- Checked in the browser: the bell list loads (12 items), Mark all read clears the count, `/notifications` lists them; overview at 1360 px and 390 px without horizontal scroll. Checking this marked the dev account `creator_d`'s notifications as read (read flags only).

## Self-audit

- Found and fixed: the action list first scanned only the latest 200 orders, so an older order still waiting on someone could drop out. Now selected by state.
- Access: every query filters by the signed-in account; marking read cannot touch another recipient's rows; cross-site posts get 403.
- Labels: the notifications are sandbox app data; nothing here moves money or sends email.
- Follow-up (not done, needs a migration): a partial index on unread in-app notifications (`recipient_id where read_at is null`) would keep the header count cheap for accounts with many read notifications; today it uses `notifications_recipient_idx`.
