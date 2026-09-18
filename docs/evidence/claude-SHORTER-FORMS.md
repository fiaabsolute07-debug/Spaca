# Posting asks for less (2026-09-18)

"Tối giản các thông tin cần điền, bỏ giới hạn text, chỉ các thông tin cần thiết" — for a creator publishing a service,
a project posting a campaign brief, and either of them listing an item for auction.

## What each form required, and what it requires now

| Form | Before | Now |
|---|---|---|
| Auction listing | **14** fields: item type, title, project, network, quantity, description, delivery method, what the buyer provides, deliver-by, starting price, increment, collateral, opens, closes | **3**: title, starting price, when bidding closes |
| Campaign brief | title, brief, creators needed, delivery deadline, and a budget or a cap | title, brief, and a budget or a cap |
| Service | title, price, delivery time, scope | title, price, scope |

Everything dropped is still on the form and still saved — it is optional, and an empty box now means something
sensible instead of an error:

- **Collateral** takes the floor it was always checked against: a fifth of the starting price.
- **Bids step** by $5.00.
- **Bidding opens** now, and **delivery is due** a week after the auction closes.
- **A brief's deadline** is two weeks out.
- **Delivery time** for a service is 72 hours.

## No shortest text anywhere in posting

A title needed 3 or 4 characters, a description 20, a delivery method 10, an application note 20. "1 WL spot" and
"Launch thread" are complete answers, and a minimum only taught people to pad the box. Every minimum is gone from the
forms, from the command handlers and from the database (`drizzle/0039_shorter_forms.sql`); empty is still refused where
the field is required. Maximums stay and several went up, so a long answer is no longer cut short: an auction
description 2,000 → 20,000, delivery method 500 → 5,000, listing title 120 → 200.

Nothing that protects money or identity was touched: amounts, dates, the 14-day auction window, the collateral floor,
idempotency keys, OAuth verifiers and audit reasons keep their rules.

## Checks

`tsc --noEmit` clean · `pnpm test:unit` **189 passed** · `RUN_DB_INTEGRATION=1 vitest run tests/integration`
**258 passed, 3 skipped** · `release:check` every check PASS · production build compiles.

Two existing assertions covered rules this change removes ("a description needs at least 20 characters", "what went
wrong needs at least 10 characters"); both now assert that the empty field is still refused. A new test opens a listing
with nothing but a title, a price and a closing time, and checks the five defaults above.

`discovery.db.test.ts` failed once in a full run and passed alone and in the next full run: the shared test database
and view-hash rows from a neighbouring file, not this change.
