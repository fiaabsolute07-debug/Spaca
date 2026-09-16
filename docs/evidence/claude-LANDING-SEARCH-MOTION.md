# Landing: marketplace search, moving goal tiles, 3D walk-through (2026-09-16)

User request: a Fiverr-style search in the landing hero over the existing video, the sections below reworked to suit the landing, with interactive 3D elements like arc.io or moving 2D drawings like monad.xyz. Environment: LOCAL dev server on 3100, on the identity already rolled out (soft dark, lime, Archivo/Geist/Geist Mono). Nothing deployed.

## What changed
- `src/components/landing/hero-search.tsx`: tabbed search panel (Find creators → `/explore?q=`, Plan a campaign → the fill-in brief), five suggestion chips linking to campaign tabs.
- `src/components/landing/brief-composer.tsx`: `variant="panel"` renders the sentence as a paragraph under the page headline.
- `src/components/landing/goal-strip.tsx`: seven goal tiles with animated SVG drawings; `src/lib/read-model.ts` `getOpenGoalCounts()`.
- `src/components/landing/launch-stack.tsx`: CSS 3D stack of the logo's three bars, pointer tilt, lift on selection, auto-advance with progress; tablist as the control.
- `src/components/landing/pool-flow.tsx`: SVG reward-pool flow with SMIL motion.
- `src/components/landing/in-view.ts`: on-screen and reduced-motion hooks.
- `src/app/page.tsx`, `landing.module.css`: hero rebuilt, ticker replaced by a facts bar, sections inserted; no new dependency (no three.js).

## Proof
- `playwright test tests/e2e/landing.spec.ts` — 4 passed: headline; tabs switch by click and arrow keys with focus following; plan tab shows the brief and a sign-up link carrying `role=buyer&launch=mainnet&creators=5`; the five chips point to campaign tabs; typing "launch thread" and Enter lands on `/explore?q=launch+thread`; no page errors; each goal tile links to its tab; choosing "Creators deliver" selects it, shows its text and facts, and stays selected past the 4.2 s auto-advance; the pool flow image is present; with reduced motion the first step is still selected after 4.6 s; at 375 px the page does not scroll sideways.
- `playwright test tests/e2e/public.spec.ts tests/e2e/auth-dialog.spec.ts` — 7 passed (public spec now expects the new headline; Early access still opens the join dialog over the landing).
- `tsx scripts/brand-contrast.ts` — 2666 text runs on 9 pages meet WCAG AA, in the dark default and with `LANDING_THEME=light` (a first run caught the goal count text at 4.22:1; raised to the secondary text colour).
- `tsc` clean. Screenshots at 1440 px (hero, goals, 3D stack in two states, pools), 375 px, and the light setting reviewed.

## Limits
- The 3D stack is CSS 3D, not a WebGL scene: it tilts and lifts but cannot be orbited freely.
- Open counts on the tiles come from the local database, which currently holds test campaigns.
