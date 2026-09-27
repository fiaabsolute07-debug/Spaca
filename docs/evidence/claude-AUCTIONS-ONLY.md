# Only auctions are shown (2026-09-27)

User request: "RÚT GỌN CHỈ CÒN PHẦN AUCTION". Asked which scope was meant, the user chose **the whole app, hiding
the rest** (keep the backend code and the database so it can be turned back on, no data lost) over deleting the code,
trimming only the landing, or trimming only the header.

Environment: a Linux container. Node 22.22.2 (the repo asks for 24), PostgreSQL 16 in place of the embedded 18,
Playwright on the container's Chromium 1194. Two dev servers against the same seeded dev database: `MARKETPLACE_SCOPE`
unset on 3101 (with `NEXT_DIST_DIR=.next-scan`) and `MARKETPLACE_SCOPE=full` on 3100. LOCAL only: mock payments,
sandbox X and Google, nothing deployed, nothing sent.

## What changed

- `src/lib/scope.ts`: `auctionsOnly()` (true unless `MARKETPLACE_SCOPE=full`) and `HIDDEN_SECTIONS`. It imports
  nothing, so `next.config.ts` can read it.
- `next.config.ts` `redirects()`: while only auctions are shown, `/dashboard`, `/explore`, `/services`, `/creators`,
  `/campaigns`, `/requests`, `/buyer`, `/creator`, `/orders`, `/funds` and everything under them answer 307 to
  `/auctions`. In full scope there are no redirects.
- Layout: Auctions is the whole header navigation; no creator search, no Fund menu; auction footer and metadata.
  Account menu: My auctions, Wallet, Profile, Log out. `homePath(true)` and the fallback back link are `/auctions`.
- Landing: auction hero with two actions, the auctions strip (six listings), six auction questions whose numbers come
  from `src/lib/items.ts`, a call to list, and an auction footer.
- Sign-up: no account-type choice; new accounts are buyer accounts. Buyer setup copy speaks of listing items.
- 404, Support, the wrong-account-type prompt, the sitemap and the settings "View public profile" link follow the scope.
- Not changed: commands, jobs, read models, migrations, `/api/**`, `/admin/**`, and the terms / privacy / refund
  text (legal copy, waiting on the legal review).

## Proof

- `tsc --noEmit`: clean.
- `RUN_DB_INTEGRATION=1 vitest run`: **447 passed, 3 skipped** (60 files) before the sitemap test was changed; its one
  failure was P5-06 expecting service and creator pages in the sitemap, which auctions only removes on purpose. The
  test now checks both scopes — full: services and creators listed, no redirects; auctions only: `/auctions` listed,
  no `/explore|services|creators|requests` URL, and `/services/:path*` redirects to `/auctions` — and passes (7/7).
- `release:check`: every check PASS.
- Redirects probed with curl on the auctions-only server: `/explore`, `/services/abc`, `/creators/x`,
  `/campaigns/launch`, `/requests`, `/buyer/requests/new`, `/creator/services`, `/orders/123`, `/funds`, `/dashboard`
  answer 307 to `/auctions`; `/`, `/auctions`, `/settings/profile`, `/welcome`, `/sign-up`, `/support`,
  `/notifications` and `/admin` answer 200.
- `playwright test --project auctions-only` (`tests/e2e/auctions-only.spec.ts`): **5 passed**. The landing has the
  auction hero, the strip, exactly the six auction questions and no link into a hidden section; the header holds only
  "Auctions Beta" with no search and the footer only Auctions, Support, Terms, Privacy, Refund policy; every hidden
  section and three deeper paths land on the board; the sitemap has `/auctions` and no hidden path; `/sign-up?role=creator`
  shows no type choice and sends `role=buyer`; a new account made with sandbox X gets the auction setup copy, finishes
  setup onto `/auctions`, is labelled Buyer, has My auctions / Wallet / Profile and no Fund button, and may list as the
  project; a signed-in buyer's logo, back links ("Back to Auctions") and menus lead only to auction pages. The first run
  had 2 failures, both in the spec (a decorative `aria-hidden` heading read by role, and a locator matching the header
  and footer logos); fixed in the spec, then 5/5.
- Screenshots checked by eye at 1280 px and 375 px: landing, board signed out and in (Account menu open), sign-up,
  settings, support, 404. No horizontal scroll on the phone landing.
- Full-scope regression (`playwright test --project marketplace` against `MARKETPLACE_SCOPE=full`): FULL_SUITE_PENDING

## Not done / known limits

- The policy pages (terms, privacy, refund policy) still describe services and orders.
- Existing creator accounts still sign in. They can list resale items but cannot bid, and the refusal still says
  "Creator accounts offer services…".
- In-app notifications about orders or campaigns created before the switch link to hidden pages, which now open the
  board.
- The workspace overview's "Needs your action" list, which also held the auction steps (lock collateral, pay within
  24 hours, mark delivered, confirm) with their due times, is hidden with `/dashboard`. What is left is the board's
  "Your auctions" table, which shows each listing's and win's state but no deadline, and item auctions send no
  notifications. A next step would be an action strip for auction steps at the top of `/auctions`.
