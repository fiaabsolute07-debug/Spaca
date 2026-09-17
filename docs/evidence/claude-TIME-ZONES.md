# A time means the time on the clock the person is reading (2026-09-16)

Task 2 from the handover: the auction form's "Starts at" was read on a different clock from the one the creator typed
on. Everything here is LOCAL: embedded PostgreSQL, the dev server on port 3100. No deployment, no real money.

## What was actually wrong

`instant()` read every `datetime-local` value as UTC (`new Date(`${value}Z`)`). A `datetime-local` input carries a wall
clock and no zone at all, so a creator in Bangkok who scheduled an auction for 09:00 got an auction that opened at
09:00 **UTC** — 16:00 their time, seven hours late. The same silent shift applied to a campaign's delivery deadline and
application deadline. Two fields had been patched by naming the zone in their own label — "When it went live (UTC)",
"New deadline (UTC)" — which made them correct but asked the person to do the arithmetic.

**AUC-13 was not this bug.** Run the way the handover prescribes (`TZ=UTC playwright test`) it passes, both before and
after this change: `dateTimeLocal` builds its wall clock in the Node test process, so with `TZ=UTC` it hands the form a
UTC wall clock and the old reading was right by construction. The earlier failure came from a run without `TZ=UTC`.
The fix below is for the product, not for the test.

## The fix

- `TimeField` (`src/components/time-field.tsx`) replaces `Field type="datetime-local"` in all five places. It submits
  the wall clock as before and adds `<name>_offset`: the minutes east of UTC that the browser was on **at the moment
  picked**, so a date across a daylight-saving change still lands right. Under the field it says which zone it used and
  what the chosen time is in UTC — the clock the rest of the site writes every instant in — so the two can never
  disagree silently.
- Without JavaScript nothing is sent, the value is read as UTC exactly as before, and the hint reads "Read as UTC."
- `zoneOffset()` refuses anything that is not a whole number of minutes within ±18 hours, so a forged form cannot move
  an instant somewhere no zone could put it.
- `instantField(form, name)` reads the pair; `create_auction`, `create_request`/`update_request`,
  `request_deadline_extension` and the PUBLISH proof all use it. A `published_at` that already carries its own offset
  or a `Z` is still taken as written.
- The two labels that named UTC are now plain: "When it went live", "New deadline".
- `playwright.config.ts` pins `timezoneId: 'UTC'` so the browser and the test process share one clock; the zone tests
  set their own with `test.use({ timezoneId: 'Asia/Bangkok' })`.

`TimeField` labels itself with `<label htmlFor>` and puts the hint in `aria-describedby`, so the field's accessible
name stays exactly "Starts at" rather than swallowing the hint.

## Checks run

| Check | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| `RUN_DB_INTEGRATION=1 vitest run` | **364 passed, 3 skipped** (46 files) |
| `TZ=UTC playwright test time-zones.spec.ts` | **3 passed** (31.4 s) |
| `TZ=UTC playwright test auction deadline request-hire` | **3 passed** (1.8 min) |
| `TZ=UTC playwright test campaign-brief work-samples` | **2 passed** |

`tests/unit/time-fields.test.ts` (6 tests) covers the parse: no offset reads as UTC; +420, −240, +330 and 0 land on
the right instant; `1441`, `-1441`, `7.5`, `UTC+7` and `+07:00` are all refused; a missing or unparseable date still
fails; and the PUBLISH proof reads 18:00 in Bangkok as 11:00 UTC while the same 18:00 with no offset is refused as a
time in the future.

`tests/e2e/time-zones.spec.ts` runs the browser on `Asia/Bangkok`:

- **AUC-13b** — an auction scheduled for 09:00 Bangkok opens at **02:00 UTC** on the auction page, and never at 09:00
  UTC. The field reads "Asia/Bangkok (UTC+07:00)" while it is being filled in.
- A campaign whose delivery deadline is typed as 18:00 Bangkok closes at **11:00 UTC**.
- With the browser on UTC (the suite default) the hint reads "(UTC+00:00)" and nothing moves.

## Also in this change

`/creator/services` had grown one upload field per service. On the dev database that is 393 services, and the page was
**6.16 MB and 8.5 s**; the work-samples walk was taking 102 s of its 120 s budget and then began to fail. The Work
samples form is now one form at the top of the page with a "Show it on" picker, and the per-service disclosure keeps
only the gallery: **4.74 MB**, and the walk takes 59 s. The page is still heavy because the dev database holds every
service every test run has ever made — cleaning that is waiting on the user's "đồng ý dọn".

## Two sessions, one working tree

Another session was editing this same checkout during the run (commits `835c5d2`, `01b1575`, `74bac24`, and an
uncommitted X-profile integration). Both Playwright runs write `test-results/e2e`, and Playwright clears that directory
when it starts, so runs that overlap destroy each other's traces and fail with `ENOENT`. Runs here used
`--output=test-results/e2e-tz` to stay out of the way. Only the paths listed in this change were staged.
