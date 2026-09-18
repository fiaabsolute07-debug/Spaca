# The site wedging on dead database connections (2026-09-18)

The user reported the live site as "very slow, taps do not respond, and on a phone it does not load at all".
Measured from Vietnam against `https://www.spaca.xyz` before any change.

## What the measurements showed

| Probe | Before | After |
|---|---|---|
| `/` time to first byte | 2.2–3.0s when it answered at all | **0.22–0.35s** |
| `/`, `/explore`, `/requests` | **no response** on most requests; TLS completed in 80ms and nothing followed | 200 on every request |
| Longest observed outage | **2 minutes** — six paced requests 20s apart all timed out (08:46:24 → 08:50:12) | none seen |
| Burst of 10 requests to `/` | 1–2 answered, the rest hung | **10/10 answered** |
| `/api/health` | flapped between `{"ok":true}` and **503** | 200 |
| `/sign-in` (reads no database) | 0.36s — healthy throughout | 0.21s |
| Compute region (`x-vercel-id`) | `hkg1::iad1` — Washington | `hkg1::hnd1` — Tokyo |
| Hero video | `max-age=0, must-revalidate`, `x-vercel-cache: MISS` on every visit | `s-maxage=2592000`, **`x-vercel-cache: HIT`** |

The database was not the problem: a direct connection from the same machine answered `select 1` in **93ms**,
`app.services` in 93ms, and the server showed 16 of 60 backends with nothing long-running. The pages that hung
were exactly the pages that read the database, and the page that does not read it never hung.

## Cause

A serverless instance is frozen between requests. The Supabase pooler drops a connection it has not heard from,
but the socket still looks open to the frozen instance, so the next request writes a query into a socket that
answers nothing. Nothing times it out: `connect_timeout` covers opening a connection, not a query on one already
open. That request holds its instance until the host gives up, and every visitor routed to that instance waits
with it — which is what the two-minute outage was.

Three other things made it slow even when nothing was wedged: the functions ran in Washington while the database
sits in `ap-northeast-1`, so every query crossed the Pacific; every page is `force-dynamic` and `no-store`, so
each tap is a fresh render behind that latency; and files under `public/` carry `max-age=0, must-revalidate` by
default, so every visit re-downloaded the hero video (up to 1.8MB — the reason a phone suffered most).

## What changed (`0c827ca`)

- `src/lib/db.ts`: pooler connections close after **5 idle seconds** and live at most **120 seconds**, so a thawed
  instance has nothing stale to reuse; the pool is **8** rather than 3, so one render's parallel queries no longer
  queue behind each other.
- `src/app/layout.tsx`: `maxDuration = 20` — a render still running after twenty seconds is ended rather than left
  holding its instance.
- `vercel.json`: `"regions": ["hnd1"]` — the functions now run beside the database.
- `next.config.ts`: `/landing/*` is cached at the CDN for a month, a day in the browser.

## Checks before deploying

`tsc --noEmit` clean · `pnpm test:unit` **189 passed** · `scripts/release-check.ts` **every check PASS** ·
production build compiles. Deployed on the user's explicit "deploy đi".

## Still open

`PAYMENT_MODE=off` and the four missing keys are unchanged by this work. The landing and explore pages remain
`force-dynamic`: with the functions now in Tokyo they render in about a fifth of a second, so caching them was
not needed, but it is the next lever if traffic grows.
