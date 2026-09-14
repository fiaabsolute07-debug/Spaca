# W8-PUB evidence: PUBLISH with proof, self-reported social accounts, content policy and reports (Claude, 2026-09-15)

Scope: master §16.9 P6-01, P6-02, P6-07 and §18 XPL-01, XPL-02, MOD-01, MOD-02, SUP-05, SUP-06, plus the 2026-09-15 decision that one approved sample is enough to publish (SUP-01). The user asked to pull PUBLISH ahead of the rest of P6 because web3 projects hiring KOLs to post is the core use case.

Environment: **local only**. Embedded PostgreSQL 18, mock payment provider, Next dev server on 3100, system Chrome. No social network API, no network access used by the product code.

## What changed

- **Migration `drizzle/0013_publish_social_moderation.sql`**
  - `app.social_accounts`:
    - platform X/INSTAGRAM/TIKTOK/YOUTUBE/NEWSLETTER/WEBSITE, handle and canonical https URL;
    - `verification_status` SELF_REPORTED by default; VERIFIED requires `verified_at` + `verified_by` (CHECK), so no creator input can claim it;
    - one live claim per canonical account across the marketplace (partial unique index);
    - legacy `profiles.social_url` values are backfilled as self-reported accounts.
  - PUBLISH terms on `services` (posting account owned by the creator via composite FK, format, `min_live_hours`, disclosure text) and a snapshot on `service_versions` (account, platform, handle, URL, format, live hours, disclosure).
    - A published PUBLISH listing must have complete terms (CHECK).
    - Legacy PUBLISH listings without a channel were moved back to DRAFT.
    - The version CHECK is `NOT VALID` so immutable history stays readable.
  - PUBLISH requests carry platform/format/live hours/disclosure (existing ones backfilled with X, POST, 72 h, "#ad"); applications and application versions record the applicant's posting account.
  - `app.publish_proofs` (immutable):
    - post URL and id, publication time, disclosure text and attestation;
    - link check MATCHES_CHANNEL or SAME_PLATFORM, and a late flag;
    - one proof per delivery, FK to the delivery and order.
  - `app.reports`:
    - USER or POLICY_CHECK source, target type/id and reason;
    - status OPEN/ASSIGNED/ACTIONED/DISMISSED, with resolution, action, resolver and time required together;
    - one open report per reporter + target + reason.
- **`src/modules/publish`**
  - Canonicalization: X from @handle, twitter.com, mobile links; TikTok @handle; Instagram; YouTube @channel or /channel/UC…; newsletter/website host+path. Refuses cross-platform links, X system pages, credentials in URLs and invalid handles.
  - `checkPostLink`:
    - X and TikTok post URLs must be on the sold handle (MATCHES_CHANNEL);
    - Instagram and YouTube post URLs do not carry the account, so they are SAME_PLATFORM and the UI says so;
    - newsletters and websites must be on the channel host.
  - `checkPublicationProof`: the publication time can be neither in the future nor before the order's work start (5 min tolerance); disclosure attestation is required; a post after the due date is accepted but flagged late.
  - Commands `add_social_account` (max 10) and `remove_social_account`. Removal is refused while a published or paused listing posts on the account; drafts lose the link.
- **Catalog**
  - `create_service`/`update_service` take `publish_account_id`, `publish_format`, `min_live_hours`, `disclosure_text`.
  - Publish validation requires the channel and terms; new versions snapshot the channel.
  - `book` on PUBLISH requires `accept_publish_terms` (MOD-02). Order terms record `deliverable` (CONTENT_HANDOFF / PUBLISHED_POST / SESSION / DIGITAL_FILE) and, for PUBLISH, `publish { account_id, platform, handle, channel_url, format, min_live_hours, disclosure_text, editorial_policy_version: 'publish-v1' }`.
- **Requests**
  - `create_request`/`update_request` take the posting terms. The platform cannot change after publishing.
  - `apply` on PUBLISH requires the applicant's own account on that platform.
  - `select_application` snapshots the account into the offer terms, and `accept_offer` carries it to the order.
- **Delivery**: `deliver` on an order with `terms.publish` requires `post_url`, `published_at` (UTC) and `disclosure_attested`. It stores the canonical post URL on the delivery, writes the proof row and records the link check on the DELIVERED event. CREATE deliveries are unchanged.
- **Content policy (`src/modules/moderation/policy.ts`)**
  - An explicit-phrase screen on request title/brief and booking briefs covers undisclosed promotion, fake engagement, guaranteed returns and verbatim deceptive scripts.
  - A match returns 422 naming the rule, and nothing is stored.
  - It is deliberately narrow; subtler cases go to reports.
- **Reports**
  - `report_content`: signed-in users, only on targets they can see; own content refused; orders and proofs only by participants.
  - `admin_resolve_report`: moderator/admin, reason ≥ 10 characters, decision ACTIONED/DISMISSED, one action valid for the target type (CLOSE_REQUEST withdraws pending offers, PAUSE_SERVICE, REJECT_SAMPLE, SUSPEND_USER never on an admin). The resolution is audited.
- **SUP-01**: `MIN_PUBLIC_SAMPLES` is now 1 (a linked, approved, public sample). The new-service form makes samples 2 and 3 optional.
- **UI**
  - Profile: "Linked accounts" (list, platform, self-reported label, remove, add).
  - Creator page: links with platform and "Self-reported".
  - New service form: "If you chose PUBLISH" section.
  - Service page: channel, format, disclosure, live time, the editorial note, and a required consent checkbox on booking.
  - Order page: "Published post" panel, with channel terms, the proof form (post link, UTC time, disclosure checkbox) and, for the buyer, the proof ("Link matches @handle on X" or "Same platform …", disclosure confirmation, "spaca checks the link, not the post").
  - Request form and page: posting terms, applicant account picker, the applicant's channel on the application card.
  - Report links on service, request, order and post pages; report queue on `/admin/moderation`.

## Verification

| Check | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| `vitest run tests/unit/publish.test.ts` | 8/8 (canonicalization, post links per platform, proof time/attestation rules, policy screen incl. a clean disclosed brief) |
| `RUN_DB_INTEGRATION=1 vitest run tests/integration/publish.db.test.ts` | 7/7 |
| Full `RUN_DB_INTEGRATION=1 vitest run` | 244 tests, 26 files: first run 242/244 (two discovery fixtures published PUBLISH listings without a channel; the fixture now links one); discovery file rerun 7/7 |
| Migration 0013 | applied to the populated test DB and the dev DB |
| Playwright `tests/e2e/publish.spec.ts` | 1/1: creator_d links an X account, publishes a PUBLISH listing, buyer_a books with consent and pays, creator_d starts and submits the post link, buyer_a sees the proof and approves. Full E2E before adding this spec: 14/14 |

DB tests:

- **XPL-01**:
  - canonical self-reported account; duplicate for the same creator 409; another creator claiming it 409; cross-platform link 400;
  - direct update to VERIFIED refused by CHECK;
  - public creator data lists the account as SELF_REPORTED.
- **SUP-06**: with `fetch` stubbed to throw, the full PUBLISH flow (link account, create, publish, book, pay, start, deliver) succeeds and `fetch` is never called.
- **XPL-02 / MOD-02**:
  - listing without a channel 400; the version snapshot is exact;
  - booking without consent 422; the order terms snapshot the channel and editorial policy;
  - removing a channel used by a live listing 409.
  - Delivery refusals: a file-only delivery 400, another handle 422, future time 400, before work start 422, no attestation 422, with no delivery rows written.
  - A valid proof stores canonical URL/post id/MATCHES_CHANNEL/not late; the proof row is immutable; the buyer's order view exposes terms and proof; approval succeeds.
- **SUP-05**: a CREATE order has `deliverable: CONTENT_HANDOFF`, no publish block, a text delivery works and no proof is required.
- **PUBLISH request**: applying without an account 400; a TikTok account on an X request 400; with an X account the offer and order carry the channel; the buyer sees the applicant's self-reported channel.
- **MOD-01**:
  - an undisclosed-promotion request brief 422 and nothing stored; a "guaranteed 50x returns" booking brief 422;
  - reporting your own request 403; a duplicate report is deduplicated; a non-participant reporting an order 404;
  - non-moderator resolve 403; a short reason 400; a wrong action for the target 400;
  - a moderator CLOSE_REQUEST closes the request with an audit entry; a second resolution 409.

## Limits

- Post content, the disclosure and "stays live for N hours" are **not verified automatically** (no platform API by design, SUP-06). The buyer checks the post and can report POST_REMOVED_EARLY; there is no scheduled re-check.
- Instagram and YouTube proofs only confirm the platform, not the account.
- Verification of social accounts (OAuth or operator review) does not exist; everything is self-reported.
- The policy screen is English-only explicit phrases; it is not a classifier.
- The report queue has no assignment flow in the UI and no reporter notification.
- Auctions of PUBLISH listings are not specifically handled (auctions are deferred by the user).
