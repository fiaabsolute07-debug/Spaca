# Work samples are the work, not a link to it (2026-09-16)

User request: *"bạn sửa cho mình phần worksample này thành hình ảnh, video... nhé, chứ không chỉ là link chỉ tới sản phẩm"* —
a work sample should be the picture or the video itself, not only a link pointing at the product.

Everything below is LOCAL: embedded PostgreSQL, the local storage provider, the dev server on port 3100. No file leaves
the machine and nothing is deployed.

## What a sample was, and what it is now

`app.samples` has carried an optional `storage_asset_id` (purpose `SAMPLE`, bucket `public-portfolio`) since
`drizzle/0006`, and the upload policy has allowed images, documents and video for that purpose the whole time. Nothing
in the interface ever used it: the only way to add a sample was three `Sample URL` / `Sample title` pairs on
`/creator/services/new`, `add_sample` had no screen at all, and every place that showed a sample showed a text link.
No migration was needed for this change — the schema was already right.

- **Adding**: `/creator/services/new` now opens with **Upload work samples** (up to three images, videos or PDFs), and
  keeps one optional link for work that only lives on someone else's channel. `/creator/services` gained a **Work
  samples** panel per service that lists what the service shows and adds another through `add_sample` — the first
  screen that command has ever had.
- **Showing**: `SampleGallery` (`src/components/samples/sample-gallery.tsx`) replaces the link lists on the public
  service page, the creator's public page, the Explore detail panel, the creator's own services page and the moderation
  queue. An image fills its frame, a video gets controls and plays in place, a PDF or a link keeps a link.
- **Serving**: `GET /api/samples/<asset id>` redirects to a short-lived signed URL, with the rule `readAsset` already
  used for SAMPLE files: the creator who owns it, a moderator, or anyone once the sample is `PUBLIC` and `APPROVED`.
- **Seeking**: the local signed-download route answers `Range` requests (206 with `content-range`, 416 when the window
  is past the end), because a video element asks for byte windows before it will play or seek.
- **Naming**: an uploaded sample takes its title from the file name; a sample added later still starts `PENDING`, as
  `add_sample` has always done, so moderation sees it before buyers do.
- **Deciding**: the moderation queue shows the file instead of only its id, so a picture is judged by looking at it.

Accessibility fix that came with it: `FileUploadField` labelled itself with a `<span>`, so every file input in the app
had no accessible name. It now uses `<label htmlFor>` with a `useId`, and tests name the field they mean.

## Checks run

| Check | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| `RUN_DB_INTEGRATION=1 vitest run` | **343 passed, 3 skipped** (43 files; the 3 skipped are the anvil suite, which needs `RUN_ANVIL=1`) |
| `TZ=UTC playwright test work-samples.spec.ts` | **1 passed** (1.7 min) |
| `TZ=UTC playwright test honest-states explore-profile` | **11 passed** |
| `TZ=UTC playwright test digital campaign-brief book-order` | **3 passed** |

`work-samples.spec.ts` walks the whole life of a sample: the creator uploads a picture to a live service; it shows in
their own panel as an `<img>` whose `src` is `/api/samples/<id>`; a request without the creator's session gets **404**
while the sample is pending and the buyer's page does not list it; the moderator sees the picture in the queue and
approves it; the buyer's page then shows the same `src`, and a signed-out request for it returns `image/png`. The link
sample keeps its link throughout.

`storage-range.test.ts` covers the byte windows a player sends (`bytes=0-`, `bytes=200-499`, a window past the end,
suffix ranges), what counts as no range, and the two unsatisfiable shapes.

## Limits, stated plainly

- Uploads cost an upload intent, and the limit is **30 per account per hour** (`MAX_OPEN_INTENTS_PER_HOUR`). The e2e
  helper that creates a service therefore still uses a link sample; only `work-samples.spec.ts` uploads files.
- There is still no antivirus or automatic content check on an uploaded sample: the signature allowlist and human
  moderation are the whole of it.
- Video is stored as uploaded — no transcode, no poster frame, no size reduction in the browser (the campaign-image
  thumbnail path is images only). A 250 MB video is served at 250 MB.
- The local provider streams from disk. Range support here is an emulation of what a real provider does; it has not
  been exercised against a hosted provider.
