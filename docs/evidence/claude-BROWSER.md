# Browser evidence and the fixes it forced (Claude, 2026-09-15)

Scope: PARTIAL rows that needed a real browser journey — FND-04, SUP-02, REV-03, DSC-02, ORD-02, PAY-06, SEC-07, SUP-03, AUC-13 and OPS-07. The new spec is `tests/e2e/honest-states.spec.ts` (system Chrome, dev server on 3100, one worker). Writing it found five product problems, all fixed in the same change.

## Problems found and fixed

1. **Forged notices** (PAY-06, SEC-07). Pages showed any `?message=`/`?error=` text from the URL, so a crafted link could display "Payment confirmed by the provider" on an unpaid order.
   - Every server redirect now signs its notice with an HMAC (`src/lib/notices.ts`, param `notice_sig`), used by the command route, card checkout, bank transfer, sandbox bank and auth routes. `Notices` and the sign-in dialog show only notices with a valid signature.
   - `NOTICE_SIGNING_SECRET` (32+ characters) is required when deployed (`env:check`); local development uses a fixture.
2. **Long unbroken text widened phone pages** (OPS-07): a 43-character word in a service title made the service page 636 px wide at 360 px. Headings, paragraphs, list items, cells, labels and pre-wrapped text now break long words (`overflow-wrap: anywhere`).
3. **Failed booking lost its page** (SUP-03): booking errors redirected to the dashboard, so the buyer never saw the changed terms. The book form and the accept-offer form now return to their own page on error.
4. **No way to edit or resume a service**: `update_service` had no UI, and a paused service had no way back. My services now has an "Edit service" panel (title, scope, price, delivery time, with the expected version; saving a live service creates a new version) and "Resume selling" for paused services.
5. **Silent creator view before payment** (ORD-02): a creator opening an unpaid order saw nothing. It now says it is waiting for the buyer's payment to be confirmed by the provider, and for the brief when that is missing.

## Browser runs (`tests/e2e/honest-states.spec.ts`)

| Row | Journey | Result |
|---|---|---|
| FND-04 | buyer_a opens a creator page and creator_c opens a buyer page; the legacy dual test account opens both; each tries `/admin`. | The wrong account type gets "This page is for creator/buyer accounts" and no workspace; dual_e sees "My applications" and "My campaigns"; `/admin` and `/admin/flags` are 404 for all three. PASS |
| SUP-02, REV-03 | A new creator signs up in the dialog, sets a handle and bio, and publishes a service. | Public profile shows "0 completed jobs", no rating and no percentage; the Explore listing says "New creator" with no ★. PASS |
| DSC-02 | Explore with a search that matches nothing, and with an invalid cursor for price sorting. | "No services match these filters" with a working "Clear all filters"; the invalid cursor shows its reason plus "Showing the newest services instead." above real listings. PASS |
| ORD-02, PAY-06 | The buyer opens the unpaid order through a link with a forged success message and `payment=success&redirect_status=succeeded`; then the creator opens it. | Still Awaiting payment, no status notice shown, Pay button present; the creator sees the waiting message and no Start work. PASS |
| SEC-07 | A brief with `<img onerror>` and `<script>`, a message containing a `javascript:` anchor, and a service sample URL `javascript:alert(document.cookie)`. | Brief and message render as literal text; the page script flag stays unset; no `javascript:` link or `onerror` image in the page; the unsafe sample URL is refused with an error. There is no server-side link preview: the only outbound HTTP calls go to configured chain RPC URLs, so there is no preview SSRF surface. PASS |
| SUP-03 | The buyer fills the booking form for version 1; the creator raises the price to $180 from the new Edit panel; the buyer submits. | Refused with "The creator updated this service. Review the new price and scope before booking.", back on the service page showing version 2 and $180.00; booking again with version 2 creates an order at $180.00. PASS |
| AUC-13 | buyer_a watches a live auction and goes offline; buyer_b bids $150; after 6 s offline buyer_a comes back online. | While offline the page still shows the old minimum ($100); within 4 s of coming online it shows $160 with no reload. PASS |
| OPS-07 | A buyer books using only Tab, Space and Enter; then the service, order and Explore pages at 360 px with a long unbroken title. | The order is created (Awaiting payment) and no page overflows horizontally. The 360/768/1440 commerce overflow checks in `responsive.spec.ts` keep passing. PASS |

Full E2E after these fixes: 33/33 passed on the first run from a warm dev server. Full `vitest`: 295 passed + 3 skipped.

Unit: `tests/unit/notices.test.ts` 2/2 — signed text shown; unsigned, altered, wrong-kind or wrong-secret notices hidden; production requires a secret.
