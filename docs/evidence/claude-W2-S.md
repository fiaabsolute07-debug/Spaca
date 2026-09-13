# W2-S evidence — private asset storage (Claude, 2026-09-13)

Scope: master §4.4 (assets), §5 StorageAsset / UploadIntent / DeliverableAsset, §13 `/assets/*` endpoints, §7.5 delivery validity, §18 SEC-01 (download side), SEC-05, SEC-06, SEC-14, ORD-07.
Environment: **local only** — embedded PostgreSQL 18.4 (`creator_marketplace_test`) as `app_server`; `LocalStorageProvider` (filesystem + HMAC-signed URLs served by `/api/dev/storage/*`). **No Supabase Storage, no antivirus engine, no staging.**

## What changed

| Area | Change |
|---|---|
| Migration `drizzle/0006_storage_assets.sql` | `app.upload_intents` (server key pattern, order scope CHECK, outcome), `app.storage_assets` (id = intent id; sha256, scan status/engine, lifecycle READY/QUARANTINED/DELETED; quarantine ⇒ quarantine bucket; guard trigger: identity immutable, lifecycle forward-only, referenced assets cannot be DELETED; no hard delete), `app.delivery_assets` (composite FKs force same order + DELIVERY purpose; append-only; ≤10 positions), `samples.storage_asset_id` (composite FK forces same creator + SAMPLE purpose; one sample per file; url optional when a file is attached). |
| `src/modules/storage/policy.ts` | MIME allowlist tied to extensions and file signatures (PNG/JPEG/GIF/WebP, PDF, DOCX, MP4/MOV, WebM); per-purpose kinds; limits image 10 MB / document 25 MB / video 250 MB (env can lower, not raise); markup detection; filename sanitization; server object keys `purpose/owner/intent.ext`. |
| `src/modules/storage/provider.ts` | `StorageProvider` interface; `LocalStorageProvider`: HMAC tokens (op, bucket, key, exp, byte limit, type), path confinement, write-once objects, quarantine has no download URL; `localStorageEnabled()` false in production. |
| `src/modules/storage/service.ts` | `createUploadIntent` (participant + order state, suspended users cannot add samples, 30 intents/hour per user → 429), `finalizeUpload` (size must equal declared, signature must match → else quarantine; SHA-256; order permission re-checked; idempotent; provider IO outside DB transactions), `createDownloadUrl` (participants; support/finance/admin only for dispute evidence or disputed orders, audited; public samples only when PUBLIC + APPROVED; 5-minute TTL; unauthorized → 404), delivery/sample attachment checks, `quarantineAsset`. |
| Routes | `POST /api/assets/upload-intents`, `POST /api/assets/[id]/finalize`, `POST /api/assets/[id]/download-url` (same-origin, session); `PUT /api/dev/storage/upload/[token]`, `GET /api/dev/storage/download/[token]` (404 in production; downloads are `attachment`, `nosniff`, `CSP: sandbox`, `no-store`). |
| Commands | `deliver` accepts `asset_ids` (files alone make a valid delivery); `add_sample` accepts `asset_id`; `admin_quarantine_asset` (moderator/admin, reason, audited; rejects a linked sample); `admin_moderate_sample` refuses to approve a sample whose file is not READY. |
| Jobs | `autoAcceptDeliveries` holds (`DELIVERY_NOT_VALID`) when any attached file is not READY; new `cleanupStorage` (abandoned intents after the finalize grace; unattached DELIVERY/SAMPLE files after 24 h; never referenced files) added to `runJobsOnce`. |
| UI | `FileUploadField` (intent → PUT → finalize, per-file status, blocks submit while uploading), `DownloadFileButton` (fresh URL per click, never rendered into HTML), `FileList`; order page shows delivery files per version, brief files and dispute evidence. |
| Env | `STORAGE_PROVIDER` required `supabase` when deployed; `STORAGE_SIGNING_SECRET` / `LOCAL_STORAGE_DIR` invalid when deployed. `.env.example` sets `STORAGE_PROVIDER=local`. |

## Test evidence

`RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run` → **16 files, 174/174 passed**, run twice consecutively (includes `tests/integration/storage.db.test.ts` 10 tests and `tests/unit/storage-policy.test.ts` 3 tests). `tsc --noEmit` exit 0. `scripts/release-check.ts`: static checks PASS including the new dev storage routes' production guard.

Also fixed a timing flake in `orders.db.test.ts` ORD-15: when the cancellation wins with a full refund, the post-commit mock refund webhook can already move CANCELLED → REFUNDED; both are correct.

| ID | Test | Result (local-mock) |
|---|---|---|
| SEC-06 | SVG, HTML, extension mismatch, >10 MB image → 422 at intent; `../../../etc/passwd.png` → stored filename `passwd.png`, key `sample/<owner>/<intent>.png`; key escape refused | PASS (local-mock) |
| SEC-06 | HTML bytes declared PNG → finalize 422 QUARANTINED, object moved to quarantine, no download URL for anyone (409 for participants), cannot be delivered; finalize idempotent | PASS (local-mock) |
| SEC-06 | Upload larger than declared → 413; wrong Content-Type → 400; second PUT → 409 (write-once); smaller than declared → REJECTED and object removed; tampered token → 403; expired upload URL → 403; upload token used for download → 403 | PASS (local-mock) |
| SEC-06 / authz | buyer DELIVERY upload 403, creator BRIEF upload 403, outsider 404, anonymous 401, cross-origin 403, finalize by non-owner 404, suspended SAMPLE upload 403, 31st intent in an hour 429 | PASS (local-mock) |
| SEC-01 / SEC-05 | Buyer does not see unattached uploads; after delivery gets a ≤5-minute URL; bytes identical; attachment/nosniff/sandbox/no-store headers; outsider and anonymous 404; unknown id 404; URL after expiry 403; URL under a different signing secret 403 | PASS (local-mock) |
| Dispute files | Creator can open buyer's evidence; moderator 404; support 200 with `asset.operator_download` audit row | PASS (local-mock) |
| SEC-14 | Delivery file as sample → 422; delivery file on the same creator's other order → 422; direct SQL insert into `delivery_assets` across orders → FK error; direct SQL sample link to a delivery file → FK error; changing `order_id` → immutable error | PASS (local-mock) |
| Samples | Uploaded PUBLIC sample: anonymous 404 until moderator approval, then 200; owner always 200; same file in two samples → 422 | PASS (local-mock) |
| ORD-07 | Delivered file quarantined by a moderator (buyer attempt 403) → buyer download 409 → auto-accept `HOLD_DELIVERY_NOT_VALID`, order stays DELIVERED, audited | PASS (local-mock) |
| Cleanup | Abandoned intent (finalize after grace → 409) and unattached file removed; attached file kept; marking a referenced file DELETED → trigger error; hard delete refused | PASS (local-mock) |

Browser (Next dev on 127.0.0.1:3100, dev DB, dev personas, no passwords): creator selected three files on a real IN_PROGRESS order — `Hero frame.png` Ready, `sneaky.png` (HTML bytes) "held for review", `notes.svg` "not accepted"; submitted the delivery with the file only → DELIVERED with "(see attached files)". Buyer page lists the file; download-url 200, bytes start `89 50 4E 47`, headers as above; `buyer_b` → 404. Checked at 360 px: no horizontal overflow. No server errors in the dev log. As designed (§4.4), a signed URL still works as a bearer link inside its 5-minute TTL.

## Not done / limits (honest)

- **Supabase Storage adapter not implemented**; deployed environments have no storage provider and fail closed. Storage RLS/policies for `storage.objects` are NOT_RUN.
- **No malware scanning.** `scan_engine = local-signature-v1` is a signature/type check only; `CLEAN` means "signature matched", not "virus-free".
- Public portfolio files are served through authorization-checked signed URLs; there is no public-bucket path or move-on-approval yet.
- Brief files attach at finalize by order; there is no per-file consent/removal flow. Sample upload UI and a moderation UI for files are not built (C6).
- Rate limiting is a DB count of intents per user per hour, not a general rate limiter; no per-user storage quota in bytes.
- Partial uploads (dropped connection) leave the intent unusable; the client starts a new upload and cleanup removes the leftover.
