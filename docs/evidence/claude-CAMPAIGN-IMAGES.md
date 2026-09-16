# Campaign images: card-sized copies and paired quarantine (2026-09-16)

Environment: LOCAL — embedded PostgreSQL (dev and test at migration 0028), local storage provider. Nothing was deployed.

## Problem
Campaign cards loaded the buyer's full upload (up to 10 MB each) to draw a picture a few hundred pixels wide, and an operator who quarantined a campaign image had no way to reach a second copy of it.

## What changed
- When a buyer adds a campaign image, the browser also makes a JPEG copy at most 640 px on its long side (quality 0.82) and uploads it as a second REQUEST_IMAGE asset of the same buyer. The server has no image library, so nothing is re-encoded there; if the browser cannot make a copy, or the copy would not be smaller, the upload goes ahead without one.
- `request_images.thumb_asset_id` (drizzle/0028) pairs the copy with its image: same buyer and purpose by composite foreign key, never the image itself, and protected from deletion like the original.
- Campaign cards load the copy (`thumb_ids`, falling back to the original); the campaign page keeps the full image.
- `/api/request-images/<id>` serves a copy only while its original is READY, and `admin_quarantine_asset` on either picture quarantines both.

## Proof
- `RUN_DB_INTEGRATION=1 vitest run tests/integration/storage.db.test.ts` — 14 passed; the new case pairs a copy by position (a blank entry means none), serves it, refuses another buyer's file as a copy, refuses a copy equal to its image and its deletion, and after a moderator quarantines the original returns 404 for both pictures — to the public and to the buyer — while the campaign's other image still serves.
- `playwright test tests/e2e/campaign-brief.spec.ts` — 2 passed; the test uploads a 1600×1000 PNG, the campaign page draws it at 1600 px, and the campaign card loads a different file whose long side is 640 px.

## Limits
- No automatic moderation or antivirus: images are checked by file signature and can be quarantined by an operator, nothing more.
- Copies are made only for new uploads; campaigns created before this keep loading their originals on cards.
