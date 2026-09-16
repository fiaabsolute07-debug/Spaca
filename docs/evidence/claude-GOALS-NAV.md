# Campaign goals and header menus (2026-09-16)

User request: split campaigns into Shiller, Launch, Airdrop and similar goals, and make the navigation open as menus like Zealy's (a featured card on the left, titled items with a line of description on the right). Environment: LOCAL dev server and embedded PostgreSQL (dev and test at migration 0029). Nothing was deployed.

## What changed
- Seven goals: Launch, Airdrop, Shiller, Testnet, AMA & Spaces, Education, Memes & art (`src/modules/requests/goals.ts`, `drizzle/0029_campaign_goals.sql`). The copy keeps the marketplace rules: Shiller posts are "each one labelled as sponsored", airdrop posts "never promise returns".
- Post a brief asks for the goal first and preselects the usual category; the campaigns page filters by goal with counts; cards and the campaign page show the goal.
- The header's Explore and Campaigns open menus; Auctions stays a link.

## Proof
- `RUN_DB_INTEGRATION=1 vitest run tests/integration/requests.db.test.ts` — 14 passed; the goal case stores LAUNCH and SHILL (value accepted in any case), leaves an API campaign without a goal unlabelled, refuses PUMP in the command (400) and in the database (CHECK), filters open campaigns by goal, and keeps the per-goal counts identical whichever goal is viewed.
- `playwright test tests/e2e/header-menus.spec.ts tests/e2e/campaign-brief.spec.ts` — 4 passed:
  - `?goal=airdrop` preselects Airdrop and Publish; the published campaign lists "Campaign goal · Airdrop".
  - Hover opens the Campaigns menu (Explore stays closed) and leaving closes it; Enter opens it and Escape closes it with focus back on the trigger; the Airdrop item leads to `/requests?goal=airdrop`, titled "Airdrop campaigns", with the Campaigns trigger and the Airdrop chip marked current and every card badged Airdrop; the Shiller chip no longer lists that campaign; Explore › Access leads to `/explore?category=ACCESS` with Explore marked current.
  - On a 375 px touch phone, tapping opens and closes the menu, the panel stays inside the screen and the page does not scroll sideways.
- Screenshots at 1280 px (both menus open) and 375 px (Campaigns open) were checked by eye.

## Limits
- Existing campaigns have no goal and show only under All campaigns; nothing guesses one for them.
- Goals are a label for browsing; they change no money, terms or policy by themselves.
