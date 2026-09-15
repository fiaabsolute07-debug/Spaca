# P6-DIGITAL evidence: ready-made files sold as versioned licenses (Claude, 2026-09-15)

Scope: master §16.9 P6-05/P6-06 and §18 XPL-04, XPL-05, XPL-06. Code and migration landed in `b34935d` together with the order-limit removal; the browser journey, the checkout and order-page copy for purchases, and this evidence landed afterwards.

Environment: **local only**. Embedded PostgreSQL 18, mock payment provider, local filesystem storage with signed URLs, Next dev server on 3100, system Chrome. No antivirus, no real storage bucket, no real payment.

## What changed

- **Migration `drizzle/0016_digital_products.sql`**
  - Storage purpose `DIGITAL` in the private bucket `private-products` (archives up to 100 MB). A file that is a release cannot be deleted (`storage_asset_guard`).
  - License terms on `services` and snapshotted on `service_versions`: `digital_license` NON_EXCLUSIVE/EXCLUSIVE, `digital_rights_text` (20–4000 chars), `digital_stock` (null = unlimited), `digital_updates` LATEST/PURCHASED_VERSION, `digital_download_limit` (1–1000).
    - An exclusive license always has stock 1 (CHECK).
    - A published DIGITAL listing needs complete terms (CHECK); the version CHECK is `NOT VALID` so history stays readable.
  - `app.digital_releases`: append-only versions of the product file (the creator's own DIGITAL upload).
  - `app.digital_entitlements`: one per purchase (HELD → ACTIVE → REVOKED/RELEASED).
    - Trigger `digital_entitlement_guard` takes an advisory lock per product and refuses a hold past stock or a second exclusive holder (HINT `SOLD_OUT`); a unique partial index backs the exclusive rule.
    - Trigger `order_entitlement_sync` keeps the entitlement in step with the order (funded → ACTIVE; cancelled/refunded → REVOKED).
  - `app.digital_downloads`: append-only download log.
  - Flag `DIGITAL_PRODUCTS_ENABLED`, off by default.
- **`src/modules/digital`**
  - `holdEntitlement` replaces the workload claim for a purchase, so a file sale never counts as creator work in progress and is sold even while the creator pauses orders (XPL-04).
  - `fulfillDigitalOrder` runs after mock or chain funding: FUNDED → IN_PROGRESS → DELIVERED with a system delivery v1, review window and `order.delivered` notification. Pool funding does not call it (no DIGITAL pool hires).
  - `createEntitlementDownload`: only the buyer of an ACTIVE entitlement gets a 5-minute signed URL for a version the license covers (LATEST: every version; PURCHASED_VERSION: up to the version bought). Each download counts against the limit and is logged.
  - Commands `add_digital_release {service_id, asset_ids, notes}` (creator) and `refund_digital_purchase {order_id, reason?}` (buyer, policy `digital-v1`: before the first download and inside the review window).
- **Catalog and orders**
  - `book` on DIGITAL needs no brief but `accept_license=on`; terms snapshot `terms.digital` and `terms.capacity = { model: 'DIGITAL_STOCK', units: 0 }`. Error 409 `SOLD_OUT`.
  - `start`, `deliver` and `revision` are refused on purchases; approve, dispute, messages and mutual cancellation work as for other orders.
  - Auctions refuse ACCESS and DIGITAL services.
  - Hold expiry (`expire_checkout_holds`) covers entitlements; `cleanup_storage` removes DIGITAL uploads that never became a release after 24 h.
  - Discovery shows `availability_status` SOLD_OUT for a product with no stock left.
- **Routes and UI**
  - `POST /api/digital/entitlements/[id]/download-url {version?}` (others get 404, anonymous 401, over limit 429, version not covered 403, revoked 409). The generic asset route serves DIGITAL files to their creator only.
  - Creator: DIGITAL fields on the new-service form; "Add product file"/"Add new version" with version list on My services.
  - Buyer: license terms, "I accept the license above for version N", "Buy license", "Sold out"/"Purchases paused" on the service page; "Files for this purchase" panel with download buttons, downloads used and "Cancel before downloading" on the order.
  - After this evidence: the local checkout says "Your files are ready to download" for purchases, the order shows a "Purchase" panel instead of brief/work clock/revisions, and the mutual cancellation copy says the files were delivered.

## Tests run (2026-09-15)

| Check | Result |
|---|---|
| `tests/integration/digital.db.test.ts` | 5/5 PASS |
| XPL-04 | two buyers get separate ACTIVE entitlements while the creator is paused; no workload claim, counters 0; bytes served only through the buyer's entitlement (other buyer/stranger 404, anonymous 401, raw asset route 404 except for the creator); `object_key` never in the read model; start/deliver 409, revision 422, approve 200 |
| XPL-05 | 5 concurrent purchases of an exclusive license: exactly 1 succeeds, 4 get 409; discovery shows SOLD_OUT; hold expiry releases it and a later buyer can buy; while that license is live a raw second entitlement insert is refused by the database, and switching the listing to non-exclusive still refuses a new purchase (409) |
| XPL-06 | PURCHASED_VERSION serves v1 only (v2 403), limit 2 then 429 with 2 log rows; LATEST serves v2 and v1; refund before download revokes (creator 403, download 409 afterwards); refund after a download 422; mutual cancellation after a download revokes |
| `tests/e2e/digital.spec.ts` (system Chrome) | PASS: admin enables the flag with an audit reason → creator_d drafts the listing → uploads `launch-kit.zip` → adds version 1 → publishes → buyer_a accepts the license and pays → order DELIVERED → download event with the right file name → "1 of 3 used" and no pre-download cancel → buyer_b gets 404 → no horizontal overflow at 390 px |
| Full `RUN_DB_INTEGRATION=1 vitest run` | 255 passed + 3 skipped before the operator-queue fix; `admin.db` 12/12 after it (see note) |
| Full E2E (`playwright test`, 23 tests) | 21 passed on the first full run. `publish.spec` failed because creator_d had been paused on the dev database before this session; the spec now resumes new orders first and passes. `auth-dialog` "Log in opens a dialog" failed once when Next dev hard-navigated to `/sign-in` right after a server restart (intercepting route not compiled yet); it passed on rerun with the other auth specs (6/6 for publish + auth-dialog). |
| `scripts/discovery-benchmark.ts` | PASS after adding PUBLISH channel and DIGITAL license terms to the synthetic listings (the benchmark had been failing since W8-PUB's CHECK) |
| `scripts/release-check.ts` | PASS |

Note: the one full-suite failure was OPS-05, whose UNKNOWN operation fell outside the operator queue's 200 oldest rows because the test database had accumulated 209 FAILED operations. The queue now lists PENDING/UNKNOWN before FAILED.

## Limits

- No antivirus: uploads are checked by type, signature and size only.
- A Request/hire with taxonomy DIGITAL creates a normal delivery order with a workload claim, not a license entitlement.
- Licence text is written by the creator; there is no legal review of license terms.
- The download count is committed before the URL is signed; if signing fails, one download is used up.
- Dispute resolution on purchases is covered by the generic dispute tests only, not a DIGITAL-specific test.
- The local dev database has `DIGITAL_PRODUCTS_ENABLED` switched on by the E2E journey; the migration default is off.
