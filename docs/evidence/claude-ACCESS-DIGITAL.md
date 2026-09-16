# Campaigns for live sessions and for licensed files (2026-09-16)

Master §9.2. Environment: LOCAL — embedded PostgreSQL (dev and test at migration 0027), mock payment provider. Nothing was deployed and no real money moved.

## What it does

A buyer could already post a campaign in any of the four categories, but only CREATE and PUBLISH carried the terms a hire needs. An ACCESS campaign hired nothing but a price, and a DIGITAL one said nothing about what the buyer could do with the files. Both now state their own terms, and the hire freezes them.

- **ACCESS**: the campaign hires a session length (15–480 minutes). The day, hour and meeting link stay something both sides agree in the order messages, exactly as for a booked session, so nobody is held to a slot before the other agrees.
- **DIGITAL**: the campaign states the license (non-exclusive or exclusive) and, in the buyer's own words, what may be done with the files. That text is the substance of the purchase, so it is frozen into the order at hire and shown to both sides afterwards.
- A commissioned file is **not** a product listing. The campaign writes no `digital` terms, so the order keeps a work clock, a hand delivery and a review, and none of the stock, release history or download limits that belong to `app.digital_entitlements`.

## Where it lives
- `drizzle/0027_access_digital_campaigns.sql`: `requests.access_session_minutes`, `requests.license_kind`, `requests.license_rights_text`, and the two CHECKs that pair each term with the category that needs it.
- `src/modules/requests/commands.ts`: `requestAccessMinutes`, `requestLicense`, the create and update paths, and the hire snapshot (`terms.access`, `terms.license`).
- `src/components/campaign/brief-type-picker.tsx`: the session-length chips and the license cards with the rights text.
- `src/app/requests/[id]/page.tsx`: the campaign facts.
- `src/components/order-workspace/brief-panel.tsx`: the same terms in the order, for booked sessions as well as hired ones.

## Proof
- `RUN_DB_INTEGRATION=1 vitest run tests/integration/requests.db.test.ts` — 13 passed, including:
  - An ACCESS campaign stores 90 minutes, the hire freezes `access: { session_minutes: 90, scheduling: 'AGREED_IN_MESSAGES' }` with deliverable SESSION, and editing the campaign down to 45 minutes afterwards leaves the hired order at 90.
  - A DIGITAL campaign freezes `license: { kind: 'EXCLUSIVE', rights_text, policy_version: 'license-v1' }`, writes no `digital` terms and no entitlement row, and the order behaves as an ordinary commission (work starts only once it is funded).
  - Refusals: an ACCESS campaign with no session length, one asking for 600 minutes, and a DIGITAL campaign whose rights text is one word; and the database itself refuses `access_session_minutes` or a license on a CREATE campaign (`requests_access_complete`, `requests_license_complete`).
- `playwright test tests/e2e/campaign-brief.spec.ts` — 2 passed: picking Access shows only the session length (no posting terms, no license) and the published campaign reads "Live session · 90 minutes"; picking Digital shows the license cards and the rights field, and after the application, offer and acceptance the order repeats "Exclusive to the buyer" and the same rights text.
- Browser (dev server, 1069 px): the Access and Digital blocks render inside the brief form with the category colour, and the rights field is prefilled with ordinary marketing rights that the buyer can rewrite.

## Limits
- There is still no campaign edit screen; `update_request` accepts the new terms through the command API only.
- Nothing schedules the session: the time lives in the order messages, as it does for booked sessions. A calendar is the work master §9.2 leaves open.
- The license text is free-form. There is no template library, no per-channel rights matrix and no check that a delivered file matches the licence.
- Quotes for ACCESS and DIGITAL campaigns are ordinary fixed quotes; the view bonus (§9.6) stays PUBLISH-only.
