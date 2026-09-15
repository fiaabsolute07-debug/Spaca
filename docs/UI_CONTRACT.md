# UI command/read contract
All forms POST /api/commands; hidden command, return_to (relative path), idempotency_key optional (root creates fallback; UI should provide crypto.randomUUID per form render). Form input strings. Success redirect to return_to or relevant entity; errors ?error= safe message. Root will export all read functions discussed. Fields below exact:

Public services rows: id,title,description,taxonomy,price_minor (string cents),currency,turnaround_hours,revision_limit,status,creator_id,creator_name,handle,niche,avatar_color,units_per_order,availability_status (see W7-CAP),samples (array optional).
creators: id (user id),handle,display_name,bio,niche,avatar_color,completed_jobs,rating (null initially),services_count.
requests: id,buyer_id,title,brief,taxonomy,budget_minor,per_creator_cap_minor,target_hires,deadline,status,buyer_name,application_count.
auctions: id,service_id,seller_id,title,creator_name,starting_price_minor,current_price_minor,minimum_increment_minor,buy_now_price_minor,ends_at,starts_at,status,bid_count,winner_id.
Orders: id,buyer_id,creator_id,service_id,source,title,status,amount_minor,platform_fee_minor,provider_fee_minor,currency,brief,delivery_due_at,review_due_at,revision_count,version,buyer_name,creator_name,settlement_status,payment_status.
Deliveries: id,order_id,body,url,version,created_at. Events: id,kind,payload,created_at. Messages: id,body,display_name,created_at. Reviews: rating,body.
ServiceData: {service,creator,samples}; samples title,url,description. null if notfound. getCreatorData(handle): {creator,services,samples}. getRequestData(actor|null,id): {request,applications}; applications only buyer/applicant visible; rows creator_name,quote_minor,note,status,id,creator_id. getAuctionData(actor|null,id): {auction,bids}; bids display_name (pseudonym),amount_minor,created_at.
Dashboard: {orders,services,applications,requests,auctions,stats}; stats {completed_orders,active_orders,gross_minor,platform_fee_minor:'0'}; workload (see W7-CAP); applications id,request_title,quote_minor,status,creator_id,request_id,creator_name; services same public fields. getPublicData accepts optional {q?,category?}.

Commands:
create_service: title,description,taxonomy CREATE/PUBLISH/ACCESS/DIGITAL,price (decimal USD),turnaround_hours,niche,units_per_order optional; three sample URLs sample_url_1/2/3 and sample_title_1/2/3 optional (or profile existing samples). creates draft then publish separately.
publish_service/pause_service: service_id
set_workload_limit / set_accepting_orders: see W7-CAP
update_profile: display_name,bio,niche,handle,social_url
add_sample: title,url,description
book: service_id,brief (min20 chars); successful redirect /orders/[id]
sandbox_pay: REMOVED (returns 403). Funding: plain form POST /api/dev/mock-checkout with order_id (local mock mode only; 404 otherwise). The order becomes FUNDED only after the signed provider webhook is processed.
start/deliver/approve/revision/dispute/cancel/refund/review/message: order_id, version optional, body text; deliver url optional, review rating integer; refund finance only except cancelled-buyer retry ("Check refund with provider"); cancelling a FUNDED order automatically requests the full provider refund; no arbitrary markPaid.
Jobs (local only): POST /api/dev/jobs runs hold expiry, reconciliation, inbox reprocess, settlement release, notification dispatch.
Notifications read: listInAppNotifications(recipientId, limit) from src/modules/notifications/store.ts → id,subject,body,link_path,read_at,created_at.
Errors: JSON {error} with HTTP status per master §13.1 (400 invalid, 401, 403, 404, 409 conflict/idempotency/capacity, 422 domain rule, 503 provider unavailable).
create_request: title,brief,taxonomy,budget (USD),per_creator_cap (USD optional),target_hires,deadline datetime-local
apply: request_id,quote (USD),note,turnaround_hours
select_application: application_id
accept_offer/decline_offer: application_id (target creator)
create_auction: service_id,starting_price,minimum_increment,buy_now_price optional (USD),starts_at,ends_at datetime-local (local timezone applied browser), holds a place in the seller's order limit until the auction ends unsold or its order finishes
bid: auction_id,amount (USD)
buy_now/close_auction: auction_id (close only at deadline; service owner or system)
create_pool: request_id,asset_symbol,amount (integer atomic string) LOCAL SIMULATION ONLY no testnet claim
Only display sandbox actions under environment banner; no fake payment UI presented as live.

## W1-A additions (2026-09-13)
Public service rows (getPublicData/getServiceData/getCreatorData) now come from the published immutable version and add: service_version_id, service_version, version. (Weekly capacity fields were removed in W7-CAP.) Owner rows (getDashboardData.services) show current fields + status + version + service_version_id (published) and never leak to public pages.
book: service_id, brief (20+ chars), service_version_id (send the displayed version; 409 QUOTE_CHANGED if the creator updated terms), accept_terms ('on' records auto-accept consent in the order snapshot). 409 CAPACITY_UNAVAILABLE / NOT_ACCEPTING_ORDERS when the creator is at their limit or paused. Hold lasts CHECKOUT_HOLD_MINUTES (default 15).
create_service: sample_url_n/sample_title_n optional pairs.
update_service: service_id, expected_version (required), title, description, price, turnaround_hours. Live services get a new version; existing orders keep theirs.
publish_service / pause_service / archive_service: service_id, expected_version optional. Archived services cannot be republished (422).
update_profile: + timezone (IANA). Handles are unique.
add_sample: title, url, description, visibility, optional service_id link; starts PENDING moderation.
Suspended accounts: 403 ACCOUNT_SUSPENDED for new activity; existing order commands still work.

## W1-B additions (2026-09-13)
getOrderData(actor, id) → { order (adds service_version_id, terms, brief_ready_at, funded_at, work_start_at, delivery_due_at, review_due_at, revision_due_at, approved_at, completed_at, cancelled_at, cancellation_refund_minor, status_before_dispute, revision_limit, review_window_hours, auto_accept_consent), latest_delivery_version, deliveries (validation_status, buyer_viewed_at), events, messages, reviews (reviewer_id), cancellation_requests, active_cancellation_request, active_review_hold }.
Order page must call recordOrderPageView(actor, orderId) (src/modules/orders/views.ts) before reading, to record buyer view evidence.
Commands (all take order_id; optional expected_version → 409 VERSION_CONFLICT):
- submit_brief: brief (20+) — buyer, AWAITING_PAYMENT/FUNDED, only while brief_ready_at is null.
- start — creator, FUNDED + brief ready (409 payment pending, 422 BRIEF_INCOMPLETE).
- deliver: body (20+ chars) and/or url (http/https) — creator, IN_PROGRESS/REVISION_REQUESTED.
- revision: delivery_version (required), body — buyer, DELIVERED, within review window, 422 REVISION_LIMIT_REACHED.
- approve: delivery_version (required) — buyer, DELIVERED → APPROVED; COMPLETED follows provider release.
- dispute: body (10+) — participant, IN_PROGRESS/DELIVERED/REVISION_REQUESTED.
- cancel — participant, AWAITING_PAYMENT/FUNDED only (409 after work starts).
- request_cancellation: refund_amount (USD, 0..amount), reason (10+) — participant, active work; one pending request.
- respond_cancellation: request_id, decision accept|reject|withdraw (no order_id needed) — counterparty accepts/rejects, requester withdraws; 409 if the order changed since the request.
- review: rating 1-5, body — buyer, COMPLETED only; repeat submits keep one review.
- mark_delivery_viewed — buyer.

## W2-B additions (2026-09-13) — operator console
Actor roles = marketplace roles (`buyer`, `creator`) + active `app.user_roles` grants (`moderator`, `finance`, `support`, `admin`). Hide nothing for security; every check is server-side.
Read models (`src/modules/admin/queries.ts`, throw OperatorAccessError for non-operators → render 404/403 page):
- getOperatorQueues(actor) → { roles, cases[id,kind,severity,status,order_id,next_action,assigned_to,age_seconds], disputes[id,order_id,status,assigned_to,status_before_dispute,age_seconds,(amount_minor,currency for finance)], review_holds, provider_operations[operation_id,kind,status,order_id,provider_reference(redacted),last_error], failed_outbox, reconciling_holds, pending_samples[id,creator_id,title,url,storage_asset_id,visibility], overdue_orders, feature_flags[key,enabled,description,changed_by,changed_reason,updated_at] }. Sections a role cannot see come back as [].
- getAuditLog(actor, { entityType?, entityId?, limit? }) — finance/admin.
- getOperatorOrder(actor, orderId) — finance/support/admin → { order (state/money/party names, no brief), events[kind,actor_id,created_at], provider_operations (redacted), cases, disputes[id,status,outcome,refund_amount_minor], files[id,purpose,filename,mime,size_bytes,lifecycle_state,scan_detail], review_holds } or null.
- searchOperatorUsers(actor, q) — moderator/admin → [id,email,display_name,status,marketplace_roles,grants,is_test,created_at] (q ≥ 2 chars).
Commands (all require `reason` ≥10 chars; missing role → 403; closed item → 409):
- admin_resolve_dispute: dispute_id, outcome RESUME|APPROVE|REFUND_FULL|REFUND_PARTIAL, refund_amount (USD, REFUND_PARTIAL only). RESUME: finance/support/admin; others finance/admin. → /admin/disputes
- admin_refund_order: order_id — finance/admin; CANCELLED + REFUND_PENDING/SUCCEEDED only. → /admin/orders/{id}
- admin_retry_operation: operation_id — finance/admin; reconciles with the same operation id. → /admin/operations
- admin_resolve_case: case_id, status RESOLVED|IGNORED — finance/support/admin. → /admin/cases
- admin_assign_case: case_id, assignee_id (must hold finance/support/admin). → /admin/cases
- admin_moderate_sample: sample_id, decision APPROVED|REJECTED — moderator/admin. → /admin/moderation
- admin_suspend_user / admin_reactivate_user: user_id — moderator/admin; not self; admins only by admin. → /admin/users
- admin_grant_role / admin_revoke_role: user_id, role — admin; not self. → /admin/users
- admin_set_flag: key, enabled true|false — admin; LIVE_PAYMENTS_ENABLED refuses to enable (422). → /admin/flags
Kill switches: disabled flags return 422 FEATURE_DISABLED on book/create_request/apply/accept_offer/create_auction/bid/buy_now/create_pool, checkout creation, and creator release. Show the disabled state; do not hide existing orders.

## W2-S additions (2026-09-13) — files
Upload (client component `src/components/files/file-upload-field.tsx` already implements it):
1. `POST /api/assets/upload-intents` JSON/form { purpose DELIVERY|BRIEF|DISPUTE|SAMPLE, filename, mime, size, order_id (not for SAMPLE) } → { id, filename, max_bytes, upload: { url, method: PUT, headers, expires_at } }. 422 UNSUPPORTED_ASSET (type/extension/size), 403 wrong participant/suspended sample, 404 order not visible, 409 order state, 429 quota.
2. `PUT upload.url` with exactly `size` bytes and the same Content-Type (413 larger, 409 reused URL, 403 invalid/expired).
3. `POST /api/assets/{id}/finalize` → 200 { id, state: READY } or 422 { id, state: QUARANTINED|REJECTED, error }; repeat calls return the recorded outcome.
Download: `POST /api/assets/{id}/download-url` → { url, expires_at } (5 min); request a fresh URL per click, never render URLs into HTML or logs. 404 when not visible, 409 when quarantined.
Who may upload: DELIVERY creator (IN_PROGRESS/REVISION_REQUESTED); BRIEF buyer (AWAITING_PAYMENT/FUNDED); DISPUTE participants (IN_PROGRESS/DELIVERED/REVISION_REQUESTED/DISPUTED); SAMPLE active creators.
Types: PNG/JPEG/GIF/WebP ≤10 MB; PDF/DOCX ≤25 MB (BRIEF: images+documents only); MP4/MOV/WebM ≤250 MB. SVG/HTML never.
Commands: `deliver` + `asset_ids` (comma-separated READY DELIVERY files of this order, ≤10; files alone are a valid delivery). `add_sample` + `asset_id` (READY SAMPLE file; `url` then optional). `admin_quarantine_asset`: asset_id, reason — moderator/admin.
getOrderData → files[{ id, purpose, owner_id, filename, mime, size_bytes, lifecycle_state, created_at, attachments[{ delivery_id, position }] }]; unattached DELIVERY uploads are only listed for their uploader.

## W3-R additions (2026-09-14): requests v2
Request statuses: OPEN, FILLED, CLOSED, CANCELLED.

getRequestData(actor|null, id) returns { request, applications, campaign }.
- request: + application_deadline, version, currency, reserved_minor, committed_minor, reserved_hires, committed_hires, application_count.
- applications:
  - buyer sees all; a creator sees only their own; anonymous sees [].
  - fields: + version, valid_until, samples_snapshot[{id,title,url,asset_id}], creator_handle, offer_id, offer_status, offer_expires_at, offer_amount_minor, offer_order_id.
- campaign: buyer only, otherwise null.
  - totals: { budget_minor, offered_minor, awaiting_payment_minor, funded_minor, completed_minor, refunded_minor, reserved_*, committed_*, target_hires }.
  - hires[{offer_id, offer_status, amount_minor, expires_at, order_id, creator_name, order_status, payment_status, settlement_status, delivery_due_at, budget_state}].

getDashboardData.applications adds: version, valid_until, offer_id, offer_status, offer_expires_at, offer_amount_minor, offer_order_id.

Commands:
- create_request: title, brief, taxonomy, budget (optional), per_creator_cap (optional; at least one of the two), target_hires, deadline, application_deadline (optional, ≤ deadline).
- update_request: request_id, expected_version (required); optional budget, per_creator_cap, target_hires, deadline, application_deadline, title, brief. Returns 422 BUDGET_EXCEEDED below held + committed.
- close_request: request_id. Withdraws pending offers; orders continue.
- cancel_request: request_id. Returns 409 once a hire was accepted.
- apply: request_id, quote, turnaround_hours, note (20+), valid_days (1-30, default 7). Re-applying creates a new version. 422 REQUEST_CLOSED / BUDGET_EXCEEDED / DOMAIN_RULE.
- withdraw_application: application_id. SUBMITTED only.
- select_application: application_id, application_version (the version shown). Errors: 409 QUOTE_CHANGED, 422 QUOTE_EXPIRED, 422 BUDGET_EXCEEDED, 409 if an offer is already active.
- withdraw_offer: offer_id (buyer). decline_offer: offer_id, reason optional (creator).
- accept_offer: offer_id. Holds one place in the creator's order limit. Redirects to /orders/{id} in AWAITING_PAYMENT. Errors: 422 QUOTE_EXPIRED, 409 CAPACITY_UNAVAILABLE / NOT_ACCEPTING_ORDERS or state.

Operator command redirects: `admin_*` form posts return to their `return_to` (not the entity path); `message`/`error` are appended with `?` or `&` so query-bearing return paths work.

## W4-A additions (2026-09-14): auctions v2
Auction statuses:
- Open: SCHEDULED, LIVE.
- Sale in progress: AWAITING_WINNER_PAYMENT.
- Terminal: SETTLED, NO_BIDS, WINNER_DEFAULTED, CANCELLED.

Read models:
- getAuctionData(actor|null, id) → { auction, bids, viewer }.
  - auction: + first_valid_bid_at, payment_due_at, version, server_now, live/accepting_bids, next_minimum_minor, highest_bid_minor, buy_now_available, cancel_reason.
  - bids: [display_name (per-auction pseudonym), amount_minor, created_at, sequence]. Only accepted bids.
  - viewer: { standing NONE|WINNING|OUTBID|WON_PAY|BOUGHT_PAY|WON|LOST|DEFAULTED|SELLER|CANCELLED, my_highest_minor, order_id, payment_due_at } | null.
- GET /api/auctions/{id}/snapshot: the same JSON. Poll every 5 s while visible; never mark a bid accepted from client state.
- getMyBids(actor) → [id, title, status, ends_at, payment_due_at, my_highest_minor, current_price_minor, standing, order_id].

Commands (error codes follow §13.3):
- create_auction: service_id, starting_price, minimum_increment, buy_now_price (optional, > start), starts_at (≤5 min in the past), ends_at (≤7 days after start).
- bid: auction_id, amount. First bid ≥ start; later bids ≥ highest + increment.
  - 422 BID_TOO_LOW; the message carries the new minimum.
  - 422 AUCTION_NOT_LIVE / AUCTION_ENDED.
  - 403 seller.
- buy_now: auction_id. Only before the first valid bid, otherwise 409 BUY_NOW_UNAVAILABLE. Redirects to /orders/{id}; the checkout hold is 15 min.
- cancel_auction: auction_id, reason (optional). Seller only, before any bid; otherwise 409.
- close_auction: auction_id (seller). 422 before the deadline, 409 if already closed. The close_due_auctions job does the same automatically.
- admin_invalidate_bid: bid_id, reason. Moderator/admin; only while the auction is open.

## W5-C1 additions (2026-09-14): crypto checkout (local devnet)

getOrderData additions:
- order.payment_rail: MOCK_PROVIDER | CRYPTO.
- payment_receipt: the latest PAYMENT_CONFIRMED payload (rail, network_mode, chain_id, tx_hash, log_index, asset, amount_atomic).
- crypto_payment (buyer only): { id, status AWAITING_DEPOSIT|PENDING_FINALITY|CONFIRMED|EXCEPTION|CANCELLED, status_reason, chain_id, network_name, network_mode LOCAL|TESTNET, symbol, decimals, amount_atomic, amount_display, recipient, reference, expires_at, last_deposit{tx_hash, status, reason} } | null.
- crypto_options (buyer only; AWAITING_PAYMENT; flag on): [asset_id, symbol, decimals, kind, chain_id, network_name, mode, amount_display].
- Always label LOCAL as simulated and TESTNET as test tokens. Never show a USD value for tokens.

Command:
- create_crypto_payment: order_id, chain_id, asset_id (optional), wallet_id (optional).
- Errors: 422 FEATURE_DISABLED, UNSUPPORTED_ASSET, SLOT_EXPIRED; 409 when a card payment or deposit is in progress.

API routes:
- POST /api/wallets/challenge {chain_id, address} → {challenge_id, message, expires_at}. Sign `message` with personal_sign.
- POST /api/wallets/verify {challenge_id, signature} → {wallet_id, address, chain_id}. Single use.
- POST /api/crypto/deposits {intent_id, tx_hash} → {results:[{status CREDITED|PENDING_FINALITY|NOT_FOUND|REJECTED|DUPLICATE|REORGED, reason, funding}]}.
  - The hash is a hint only. Refresh the order after CREDITED, PENDING_FINALITY or REJECTED.

Dev only:
- POST /api/dev/local-chain/pay {intent_id} → {tx_hash}. Simulates the wallet on LOCAL networks; 404 in production.

## W5-C2 additions (2026-09-14): campaign pools (local devnet)

A request can be backed by a funded campaign pool:
- Applicants quote exactly the pool CASH value.
- `accept_offer` allocates the rewards and returns the order already FUNDED, with `payment_rail` POOL and no checkout.
- The creator needs a verified wallet on the pool network.

Read model: `getPoolData(actor|null, requestId)` in `src/modules/pools/service.ts`
- `pool`: `{ id, status FUNDING|ACTIVE|CLOSED, chain_id, network_name, network_mode, template_version, rewards_per_hire[items], fully_funded, missing_required[{asset_id, symbol, missing}] }`.
- Owner only:
  - `assets`: `[asset_id, symbol, decimals, kind, required, target, confirmed_deposit, unallocated, allocated_active, pending_outflow, released, refunded]` as decimal strings.
  - `funding_intents`: `[id, amount_atomic, reference, recipient, status, status_reason]`.
  - `allocations`: `[order_id, item_key, kind, required, amount_atomic, state ACTIVE|RELEASE_PENDING|RELEASED|CANCELLED, attempts, last_error, release_tx, template_version]`.
  - `refunds`.
  - `entitlements`: `[id, order_id, item_key, kind PERK|NFT, perk_type, description, fulfillment_method, required, deadline_at, status PENDING|FULFILLED|CLAIMED|CANCELLED]`.
- Rewards never show a USD value for TOKEN or PERK items.

Template items (JSON array, 1–10):
- `{key, kind:'CASH', required:true, asset_id, amount}`: exactly one, on a USD-pegged asset; it sets the per-hire price.
- `{key, kind:'TOKEN', required, asset_id, amount}`: needs `TOKEN_REWARDS_ENABLED`.
- `{key, kind:'PERK', required, perk_type WHITELIST|ACCESS|COMMUNITY_ROLE|NFT, description, fulfillment_method, deadline_days}`: NFT needs `NFT_REWARDS_ENABLED`.

Commands (buyer = request owner):
- `create_campaign_pool`: `request_id`, `chain_id`, `items`.
  - Only before any application.
  - Needs `REQUESTS_ENABLED` and `CRYPTO_CHECKOUT_ENABLED`.
- `update_pool_template`: `pool_id`, `items`.
  - Creates a new version for future hires only.
  - Stale applications get 409 at select.
- `create_pool_funding`: `pool_id`, `asset_id`, `amount` (decimal).
  - Returns an intent id; send exactly that amount with its reference.
  - Verify through `POST /api/crypto/deposits` with that `intent_id`, or let the indexer pick it up.
- `refund_pool_unused`: `pool_id`, `asset_id`, `amount` (optional; defaults to all unallocated).
  - Needs the buyer's verified wallet.
  - 422 when above the unallocated balance.
- `close_campaign_pool`: `pool_id`. Returns 409 while allocations are active or balance remains.
- `fulfill_entitlement` (buyer): `entitlement_id`, `proof` (10+ chars); NFT also needs `nft_contract` and `nft_token_id` owned by the creator's wallet.
- `claim_entitlement` (creator): `entitlement_id`. A second claim gets 409.
- `create_pool`: retired; returns 422 pointing to `create_campaign_pool`.

Settlement:
- An approved pool order releases each allocation on chain.
- If a required asset fails, the order stays APPROVED with `settlement_status` PENDING and the job retries only the failed items.
- The order becomes COMPLETED once every required reward is released.

## W6-D additions (2026-09-14): discovery, trending, views, SEO

All discovery endpoints are public `GET`, return `cache-control: no-store` and `X-Robots-Tag: noindex, nofollow` (they are under `/api`).
- Invalid input → **400** `{ error, code: 'INVALID_INPUT' }`. Show the message; do not silently drop the filter.
- Database trouble → **503** `{ error, code: 'TEMPORARILY_UNAVAILABLE', retryable: true }` with `retry-after: 5` and **no items**. Show an error state with a retry action, never placeholder listings (DSC-02).
- Empty result → 200 with `items: []`, `next_cursor: null`. Show an empty state with a way to clear filters.
- Pagination is keyset: pass `next_cursor` back as `cursor` with the **same** `sort` and filters. A cursor from another sort → 400 (restart at page 1). `null` means no more pages.
- Money is `price_minor` as a string of cents with `currency`; timestamps are ISO/Postgres timestamps (server time).
- In `APP_ENV=production`, `is_test` fixture accounts never appear; locally they do.

### `GET /api/discovery/services`

Params (all optional):
- `q` (≤120 chars; letters/digits become AND-ed prefix terms), `taxonomy` (comma list of `CREATE,PUBLISH,ACCESS,DIGITAL`), `niche` (exact, case-insensitive), `creator` (handle).
- `price_min`, `price_max` (decimal USD, e.g. `150` or `149.99`), `turnaround_max` (hours 1–8760).
- `available=true` (the creator is accepting orders with room for this service's units). `available_before` and `sort=availability` return 400 since W7-CAP: there is no reopening date.
- `sort`: `relevance` (needs `q`; default when `q` is set) | `newest` (default otherwise) | `price_asc` | `price_desc` | `turnaround`.
- `cursor`, `limit` (1–48, default 24).

Response `{ items, next_cursor, sort, ranking }`; each item:
`{ id, service_version_id, service_version, title, summary (≤280 chars), taxonomy, price_minor, currency, turnaround_hours, revision_limit, published_at, creator_id, creator_name, handle, niche, avatar_color, rank, availability_status }`.
- `availability_status` ≠ `ACCEPTING` = show "Currently at capacity" or "Paused" and replace the booking CTA with "Post a request". The server still rejects a stale booking with 409 (DSC-05).
- `ranking` is a human-readable explanation of the order (show in a tooltip if desired).

### `GET /api/discovery/creators`

Params: `q`, `niche`, `taxonomy` (single), `available=true`, `sort` = `relevance` (needs `q`) | `reputation` (default) | `newest`, `cursor`, `limit` (1–48, default 24).

Item: `{ id, handle, display_name, niche, bio (≤200), avatar_color, joined_at, services_count, min_price_minor, taxonomies[], completed_orders, review_count, avg_rating, sample_count, availability_status, rank, reputation_label }`.
- `avg_rating` is `null` below 3 reviews and `reputation_label` is `NEW`; show "New" instead of stars. With ≥3 reviews the label is `RATED`.
- There are no follower counts; do not display or sort by followers (`sort=followers` → 400).

### `GET /api/discovery/auctions` (ending soon)

Params: `within_hours` (1–168, default 48), `cursor`, `limit` (1–24, default 12).

Response `{ items, server_now, next_cursor }`; item: `{ id, title, starting_price_minor, current_price_minor, minimum_increment_minor, buy_now_price_minor, bid_count, starts_at, ends_at, first_valid_bid_at, creator_name, server_now, buy_now_available }`.
- Only auctions live by server time are returned, soonest end first. Compute countdowns from `server_now`, not the browser clock. Bids are still validated by the bid API.

### `GET /api/discovery/trending`

Params: `niche`, `taxonomy` (single). Response always carries `formula` (`version: 'trending-v1'`, eligibility thresholds, score expression).
- `label: 'TRENDING'`: `items[{ id, title, taxonomy, price_minor, currency, turnaround_hours, creator_name, handle, completed_30d, reviews_30d, avg_rating_30d, views_7d, score }]`, ordered by score.
- `label: 'COLD_START'`: `note` plus `items[{ id, title, taxonomy, price_minor, currency, turnaround_hours, creator_name, handle, published_at, badge: 'NEW' }]`. Title the section "New services" (use `note`), **never** "Trending", and show no popularity numbers (DSC-04).

### `POST /api/services/[id]/view`

Call once when a public service page is viewed (same-origin `fetch`, no body). Response `{ counted: boolean, reason? }` with reason `ALREADY_COUNTED_TODAY | OWNER | NO_VIEWER_KEY | DAILY_CAP`; unknown/unpublished service → 404 `NOT_FOUND`. Fire-and-forget; never show counts from it.

### SEO

- `/sitemap.xml` and `/robots.txt` are served by the app. Non-production robots disallow all.
- Private prefixes (`/orders`, `/dashboard`, `/admin`, `/buyer`, `/creator`, `/settings`, `/api`, `/sign-in`, `/sign-up`, `/reset-password`) get `X-Robots-Tag: noindex, nofollow` from `next.config.ts`; pages there need no extra metadata.
- Public pages (`/services/[id]`, `/creators/[handle]`, `/requests/[id]`, `/auctions/[id]`, `/explore`) should set `alternates.canonical` using `canonicalUrl(path)` from `src/lib/seo.ts`.

## W7-CAP additions (2026-09-15): active-order limit

Capacity is one limit per creator: how many orders they work on at once, shared by all of their services (master §6).

Reads:
- Public service rows, `GET /api/discovery/services` and `GET /api/discovery/creators` items: `availability_status` = `ACCEPTING` | `AT_CAPACITY` | `PAUSED`. Buyers never see counts or a reopening date. Labels: "Accepting orders" (green), "Currently at capacity", "Paused". When not accepting, hide the booking form and offer "Post a request" (`/buyer/requests/new`).
- Service rows add `units_per_order` (how many places one order uses, default 1).
- `getDashboardData(actor).workload` (creator's own): `{ creator_id, max_active_units, accepting_orders, held_units, active_units, in_flight_units, version, availability_status }`. `in_flight_units = held_units + active_units`; it can exceed `max_active_units` after the creator lowers the limit.

Commands:
- `set_workload_limit`: `max_active_units` (1–100). Lowering it never cancels accepted work; new orders open again once in-flight units drop below it.
- `set_accepting_orders`: `accepting` = `true` | `false`. `false` blocks new bookings, accepted offers and new auctions (409 `NOT_ACCEPTING_ORDERS`); orders and auctions already running continue.
- `create_service` / `update_service`: optional `units_per_order` (1–10). A live edit creates a new service version; sold orders keep the weight they were sold with.
- Removed: `set_capacity`, `set_pool_timezone`, `pool_id`/`bucket_id` on `book` and `accept_offer`, `capacity` on `create_service`, `getCreatorPools`.

What counts: a checkout hold, an accepted offer awaiting payment, and a scheduled/live auction (from scheduling until it ends unsold or its order finishes) hold places. Funded work counts until the order is approved/completed or cancelled/refunded.


## W8-PUB additions (2026-09-15): PUBLISH, linked accounts, reports

Reads:
- `getDashboardData(actor).profile.social_accounts`: `[{ id, platform, handle, url, verification_status }]`.
- `getCreatorData(handle).social_accounts`: same fields. Always label `SELF_REPORTED` as "Self-reported"; never show "verified" unless `VERIFIED`.
- Public service rows add `publish_platform, publish_handle, publish_url, publish_format, min_live_hours, disclosure_text` (PUBLISH only). Owner rows add `publish_account_id, publish_format, min_live_hours, disclosure_text`.
- `getOrderData`:
  - `publish_terms` (null unless PUBLISH): `{ account_id, platform, handle, channel_url, format, min_live_hours, disclosure_text, editorial_policy_version }`.
  - `publish_proofs[]`: `{ id, delivery_id, delivery_version, platform, channel_url, post_url, post_id, published_at, disclosure_text, disclosure_attested, link_check: MATCHES_CHANNEL|SAME_PLATFORM, late }`.
- `getRequestData`:
  - `request` adds `publish_platform, publish_format, min_live_hours, disclosure_text`.
  - Applications add `publish_account_id, publish_platform, publish_handle, publish_url, publish_verification`.
  - Top level adds `my_social_accounts` (the creator's accounts on the request platform).
- `getOperatorQueues(actor).open_reports` (moderator/admin): `{ id, source, target_type, target_id, reason, details, status, created_at, reporter_name }`.

Commands:
- `add_social_account`: `platform` (X, INSTAGRAM, TIKTOK, YOUTUBE, NEWSLETTER, WEBSITE), `account` (@handle or link). 409 duplicate.
- `remove_social_account`: `account_id`. 409 while a published or paused listing posts on it.
- `create_service` / `update_service` for PUBLISH: `publish_account_id` (required), `publish_format` (POST, THREAD, QUOTE_POST, VIDEO, NEWSLETTER_ISSUE, ARTICLE), `min_live_hours` (0–2160, default 72), `disclosure_text` (2–80, default "#ad"). Samples: one approved public sample linked to the service is enough to publish.
- `book` on PUBLISH: `accept_publish_terms=on` required (422 otherwise). Briefs breaking the content policy return 422 with the rule.
- `create_request` / `update_request` for PUBLISH: `publish_platform`, `publish_format`, `min_live_hours`, `disclosure_text`. Platform cannot change after publishing.
- `apply` on PUBLISH: `publish_account_id` (own account on the request platform).
- `deliver` on PUBLISH orders: `post_url`, `published_at` (datetime-local, UTC), `disclosure_attested=on`, optional `body`. 422 for another channel or a time before the order started; 400 for missing fields or a future time.
- `report_content`: `target_type` (REQUEST, ORDER, SERVICE, PROFILE, SAMPLE, PUBLISH_PROOF), `target_id`, `reason` (UNDISCLOSED_PROMOTION, FAKE_ENGAGEMENT, GUARANTEED_RETURNS, DECEPTIVE_SCRIPT, IMPERSONATION, POST_REMOVED_EARLY, SPAM, OTHER), `details` (10+). Redirects back to `return_to`.
- `admin_resolve_report` (moderator/admin): `report_id`, `decision` ACTIONED|DISMISSED, `action` (NONE, CLOSE_REQUEST, PAUSE_SERVICE, REJECT_SAMPLE, SUSPEND_USER per target), `reason`.

## W9-ARC additions (2026-09-15): escrow checkout and payouts

- `getOrderData(...).crypto_payment` adds `escrow_ref` and `token_address`. The panel shows escrow contract (`recipient`), bucket (`escrow_ref`) and payment reference, and labels LOCAL/TESTNET modes.
- Paying on an RPC network: the buyer's wallet calls `approve(escrow, amount)` on the token, then `fund(escrowRef, paymentRef, token, amount)` on the escrow. `CryptoDepositActions` does this with an EIP-1193 wallet and then posts the transaction hash to `/api/crypto/deposits`. The server verifies the `Funded` log and the bucket; a wrong bucket is `WRONG_ESCROW`.
- Payouts are asynchronous:
  - After approval the order shows `settlement_status` PENDING until the escrow release is confirmed, then COMPLETED/RELEASED.
  - A cancellation shows `payment_status` REFUND_PENDING until the refund to the paying wallet is confirmed, then REFUNDED.
  - Operators see `app.chain_payouts` states QUEUED, SUBMITTING, UNKNOWN, RETRY, CONFIRMED, FAILED.
- Pool refunds (`refund_pool_unused`) return `state: REFUND_PENDING`; the escrow sends them to the wallet that funded the pool.
- Crypto order events: `SETTLEMENT_RELEASED` (rail CRYPTO, tx_hash), `REFUND_CONFIRMED`, `ESCROW_FROZEN` / `ESCROW_UNFROZEN` (disputes), `SETTLEMENT_FAILED`, `REFUND_FAILED`.

## P6-DIGITAL additions (2026-09-15): ready-made files (drizzle/0016)

- Flag `DIGITAL_PRODUCTS_ENABLED` (off by default) gates publishing and buying. With it off, `book` returns 422 `FEATURE_DISABLED` and `getServiceData().digital.purchases_enabled` is false.
- `create_service` / `update_service` for DIGITAL: `digital_license` NON_EXCLUSIVE|EXCLUSIVE, `digital_rights_text` (20–4000), `digital_stock` (blank = unlimited; EXCLUSIVE forces 1), `digital_updates` LATEST|PURCHASED_VERSION, `digital_download_limit` (1–1000, default 10). Publishing needs these terms and at least one release.
- `add_digital_release {service_id, asset_ids, notes?}` (creator): one READY upload with purpose `DIGITAL` (archives: `application/zip`, ≤100 MB, bucket `private-products`) becomes the next version. Releases are append-only.
- `book` on DIGITAL: no brief; `accept_license=on` required. Errors: 409 `SOLD_OUT` (no stock, or an exclusive license is held), 422 `FEATURE_DISABLED`. Order `terms.digital = { license, rights_text, updates_policy, download_limit, release_version, policy_version: 'digital-v1' }`; `terms.capacity = { model: 'DIGITAL_STOCK', units: 0 }`.
- Paying delivers at once: the order goes to DELIVERED with system delivery v1 (event `DIGITAL_DELIVERED`). `start`, `deliver` and `revision` are refused (409/422). Approve, dispute, messages and mutual cancellation work as usual.
- `refund_digital_purchase {order_id, reason?}` (buyer): before the first download and inside the review window → CANCELLED + full refund, entitlement REVOKED, event `DIGITAL_PURCHASE_CANCELLED`. After a download: 422; use a dispute or `request_cancellation`.
- `POST /api/digital/entitlements/[id]/download-url {version?}` → `{ url, expires_at, version }` (URL valid 5 minutes). 401 anonymous, 404 not the buyer, 403 version not covered by the license, 409 entitlement not ACTIVE, 429 download limit reached. `/api/assets/[id]/download-url` serves DIGITAL files to their creator only.
- Reads:
  - `getServiceData(id).digital = { latest_version, updated_at, purchases_enabled }` (null for other categories); `availability_status` may be `SOLD_OUT`.
  - `getOrderData(...).digital = { entitlement: { id, state, license, release_version, updates_policy, download_limit, download_count, first_downloaded_at }, releases: [{ version, notes, created_at, filename, size_bytes, available }] }` — only versions the license covers; never storage keys.
  - Owner `serviceRows` for DIGITAL add `releases` (version, notes, filename, size) and `licenses { active, held }`.
- UI: `<DownloadButton>` (client) posts to the download route and opens the signed URL; `<OrderDigitalPanel>` shows license, downloads used, versions and the pre-download cancel; `OrderBriefPanel digital` shows a "Purchase" summary instead of brief, work clock and revisions.

## 2026-09-15 removals: order limit and ACCESS scheduling (drizzle/0017)

- No limit on orders at once. `set_workload_limit` and `max_active_units` are gone; `availability_status` is `ACCEPTING` or `PAUSED` (DIGITAL adds `SOLD_OUT`). `AT_CAPACITY` and the `CAPACITY_UNAVAILABLE` error no longer exist. `set_accepting_orders` (pause/resume) stays; `getDashboardData().workload` keeps `held_units`, `active_units`, `in_flight_units`, `accepting_orders`.
- ACCESS: no availability, slots API, appointments, meeting link, `mark_session` or `report_creator_no_show`. A service has `access_session_minutes` only; `book` needs no `starts_at`; order `terms.access = { session_minutes, scheduling: 'AGREED_IN_MESSAGES' }`. ACCESS orders use the normal start/deliver/approve flow and messages to agree the time.
- The W7-CAP section above describes the removed limit; read it with this note.

## 2026-09-15 additions: profile photo and Explore master-detail

- Upload purpose `AVATAR` (images only, bucket `public-avatars`). Commands `set_avatar {asset_ids}` (own READY avatar; profile must exist) and `remove_avatar`. `update_profile` also takes `headline` (≤120), `location` (≤80), `languages` (≤120).
- `GET /api/avatars/[assetId]` → 302 to a short-lived signed URL only while an ACTIVE user's profile shows that photo; otherwise 404. Reads expose `avatar_asset_id` on service rows, search results, creator data and the dashboard profile (plus `headline`, `location`, `languages`, `public_samples`). `<Avatar name assetId size>` renders the photo or the initial.
- `/explore` query: `q`, `category`, `price` (`under_100`, `100_500`, `500_1000`, `over_1000`), `delivery` (hours: 24, 72, 168, 336), `niche`, `available=1`, `sort` (`relevance` with q, `newest`, `price_asc`, `price_desc`, `turnaround`), `cursor`, `selected`. 20 results per page; `getExploreData()` returns items with description, terms, up to 3 samples, completed jobs and rating (only with 3+ reviews), `matched` count, `next_cursor`, niches and a fallback `error`.
- Wide screens (≥1024px) show a sticky detail panel for the selected card (`selected` kept in the URL); narrower screens link cards straight to the service page. Filters submit on change; "Accepting orders" is a link switch; active filters show as removable chips.

## 2026-09-15 additions: separate buyer and creator accounts (drizzle/0019)

- An account is a buyer or a creator, not both. Sign-up (`POST /api/auth action=signup`) takes `role=buyer|creator`; anything else creates a buyer. Supabase sign-up stores the choice as `account_type` metadata and maps it the same way. Operator roles (moderator, finance, support, admin) stay separate grants.
- DB: `users_single_account_type` refuses a real account (`is_test=false`) holding both roles. Local test accounts may keep both (`dual_e`). Fixtures: `creator_c`, `creator_d`, `suspended` are creators; `buyer_a`, `buyer_b` are buyers.
- `/api/commands` returns 403 `FORBIDDEN` with an explanation when the account type does not match (`src/lib/account.ts`):
  - creator only: `add_sample`, `create_service`, `update_service`, `publish_service`, `pause_service`, `archive_service`, `set_accepting_orders`, `add_digital_release`, `add_social_account`, `remove_social_account`, `create_auction`, `cancel_auction`, `apply`, `withdraw_application`, `accept_offer`, `decline_offer`, `start`, `deliver`;
  - buyer only: `book`, `submit_brief`, `revision`, `approve`, `refund_digital_purchase`, `create_crypto_payment`, `create_request`, `update_request`, `close_request`, `cancel_request`, `select_application`, `withdraw_offer`, `bid`, `buy_now`, `create_pool`, `create_campaign_pool`, `update_pool_template`, `create_pool_funding`, `refund_pool_unused`, `close_campaign_pool`;
  - either side: order commands both parties use (`message`, `dispute`, `request_cancellation`, `respond_cancellation`, `review`, …), profile and reports. Each still checks the actor belongs to the order.
- Pages: `requireActorOrLoginPrompt(route, query, 'buyer' | 'creator')` shows "This page is for buyer/creator accounts" to the other type. Buyer pages: `/buyer/requests`, `/buyer/requests/new`. Creator pages: `/creator/services`, `/creator/services/new`, `/creator/auctions/new`, `/creator/requests`.
- Workspace: the sidebar and dashboard follow the account type (badge "Creator account"/"Buyer account"). `/creator/requests` lists the creator's applications (`getDashboardData().applications`) with offer state; `/buyer/requests` lists the buyer's briefs. Dashboard stats add `sales_minor` (completed orders as creator) and `funded_minor` (funded, not cancelled/refunded, as buyer).
- Service page: a creator account sees "Booking needs a buyer account" (or "This is your service"); request page: a buyer account sees "Applying needs a creator account"; auction page: a creator account sees "Bidding needs a buyer account". Profile: linked accounts and the sample check show for creators only.

## ORD-12 additions (2026-09-15): deadline extensions (drizzle/0020)

- `request_deadline_extension {order_id, new_due_at, reason}` — either party. `new_due_at` is a UTC `datetime-local`. Allowed on FUNDED/IN_PROGRESS (moves the delivery deadline) and REVISION_REQUESTED (moves the revision deadline); not on DIGITAL purchases. 400 for a date not after the current deadline, less than 1 h from now, more than 90 days later, or a reason under 10 characters; 409 when a proposal is already open or nothing is due. Returns `id` (the amendment).
- `respond_deadline_extension {amendment_id, decision}` — `accept`/`reject` by the other party, `withdraw` by the proposer (403 otherwise). 409 when already decided/expired or the deadline changed since the proposal; 422 when the proposed date has passed.
- A set delivery deadline cannot change any other way (DB guard). Any status change except starting work expires the open proposal.
- `getOrderData(...).amendments = [{ id, deadline: DELIVERY|REVISION, proposed_by, counterparty_id, proposed_by_name, reason, old_due_at, new_due_at, status, created_at, responded_at }]` (newest first) and `active_amendment` (the REQUESTED one or null).
- Events: `DEADLINE_EXTENSION_REQUESTED`, `DEADLINE_EXTENDED`, `DEADLINE_EXTENSION_REJECTED`, `DEADLINE_EXTENSION_WITHDRAWN`, `DEADLINE_EXTENSION_EXPIRED`. Notifications: `order.deadline_extension_requested {orderRef, newDueAt}`, `order.deadline_extension_resolved {orderRef, outcome ACCEPTED|REJECTED}`.
- UI: `<OrderDeadlinePanel>` on the order page (region "Deadline").

## ORD-14 additions (2026-09-15): card payment disputes (drizzle/0021)

- Provider webhooks `dispute.opened`, `dispute.won`, `dispute.lost` go to the existing `POST /api/webhooks/mock-payment`. They never change the order status, deliveries or reviews.
- Order timeline events: `PAYMENT_DISPUTE_OPENED` (with order and settlement status), `PAYMENT_DISPUTE_WON`, `PAYMENT_DISPUTE_LOST`.
- Notification `payment.disputed {orderRef, stage: OPENED|WON|LOST}` to the creator (in-app by default).
- Operator order view (`getOperatorOrder`) adds `payment_disputes: [{ id, provider_reference (redacted), amount_minor, currency, status, order_status_at_open, settlement_status_at_open, evidence, opened_at, closed_at }]`. Cases: `PAYMENT_DISPUTE`, `CHARGEBACK_LOST`, `UNMATCHED_PAYMENT_DISPUTE`, `UNEXPECTED_PAYMENT_DISPUTE`, `CONFLICTING_PAYMENT_DISPUTE`.
- An order with an OPEN or LOST payment dispute is not released to the creator by the settlement job.

## PAY-15 additions (2026-09-15): refunds after release (drizzle/0022)

- Finance/admin commands (reason ≥ 10 characters, audited): `admin_refund_after_release {order_id, amount}` (card orders with settlement RELEASED; amount ≤ what the creator received minus earlier refunds after release; 409 otherwise, or while a card payment dispute is open/lost), `admin_retry_refund_recovery {refund_id}` and `admin_cover_refund_deficit {refund_id}` (both only for DEFICIT; 409 otherwise).
- Refund states: RECOVERING → REFUND_PENDING → REFUNDED, or DEFICIT (reversal refused) → retry or cover → REFUND_PENDING → REFUNDED. `recovered_minor` comes only from provider-confirmed reversals; `covered_minor` only from an approved cover.
- `getOperatorOrder(...).post_release_refunds = [{ id, amount_minor, currency, status, recovered_minor, covered_minor, reason, covered_reason, created_at, updated_at }]`.
- Order events: `REFUND_AFTER_RELEASE_REQUESTED`, `REFUND_DEFICIT_OPENED`, `REFUND_AFTER_RELEASE_RECOVERED`, `REFUND_DEFICIT_COVERED`, `REFUND_AFTER_RELEASE_CONFIRMED`. The order status does not change. Buyer notification `refund.updated` (SUCCEEDED) when the provider confirms. Cases: `REFUND_DEFICIT`, `REFUND_FAILED`, `REVERSAL_AFTER_COVER`, `UNMATCHED_REVERSAL`, `UNEXPECTED_REVERSAL`.
