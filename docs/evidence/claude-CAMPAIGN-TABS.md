# Seven campaign tabs (2026-09-16)

User request: split campaigns into seven tabs, each expressing its own idea, without the tabs looking empty. Environment: LOCAL dev server and embedded PostgreSQL. Nothing deployed.

## How a tab avoids looking empty
Nothing on a tab is invented. Each tab always has:
1. its own idea — a headline, a pitch and the call to action, written in `src/modules/requests/goal-pages.ts` (editable in one place);
2. how that kind of campaign works (three steps) and what creators deliver, with the rule that applies;
3. real creators who already sell the category the goal needs (up to three published services);
4. its open campaigns — or, when there are none, an invitation to post the first brief (the form opens with the goal chosen and example text for it) and links to the tabs that do have open campaigns;
5. campaigns of the goal that recently filled or closed, when there are any.

## Proof
- `RUN_DB_INTEGRATION=1 vitest run tests/integration/requests.db.test.ts` — 15 passed; the tab read model lists an open EDUCATION campaign, not a closed one or one of another goal, lists the closed one under recent, and returns at most three creators, all of the matching category.
- `playwright test tests/e2e/campaign-tabs.spec.ts tests/e2e/header-menus.spec.ts tests/e2e/campaign-brief.spec.ts` — 7 passed (campaign-brief rerun after giving its deliberately large upload 60 s): `/campaigns` opens the first tab; all seven tabs load with their own headline, pitch, three steps and deliverables and mark their tab current; an empty tab shows the invitation linking to the brief form for that goal, a tab with campaigns shows only cards of that goal; the brief form opened from Launch has Launch chosen and Launch's example placeholders; an unknown tab is 404; a creator sees "See open Shiller campaigns" and no post button; the header menu's Airdrop leads to its tab and `/requests?goal=airdrop` redirects there; on a 375 px phone the tabs scroll inside themselves and the page does not.
- Screenshots at 1280 px (Shiller with campaigns, Testnet without) and 375 px (AMA & Spaces) checked by eye.

## Limits
- The seven tabs share one layout; what differs is the idea and content per goal. Goal-specific campaign fields, cards and filters (launch date, price per post, AMA time) are the next step and are not built.
- Tab counts and "Creators who sell this kind of work" reflect the local test data.
