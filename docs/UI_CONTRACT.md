# UI command/read contract
All forms POST /api/commands; hidden command, return_to (relative path), idempotency_key optional (root creates fallback; UI should provide crypto.randomUUID per form render). Form input strings. Success redirect to return_to or relevant entity; errors ?error= safe message. Root will export all read functions discussed. Fields below exact:

Public services rows: id,title,description,taxonomy,price_minor (string cents),currency,turnaround_hours,revision_limit,status,creator_id,creator_name,handle,niche,avatar_color,available_units,total_units,pool_id,samples (array optional).
creators: id (user id),handle,display_name,bio,niche,avatar_color,completed_jobs,rating (null initially),services_count.
requests: id,buyer_id,title,brief,taxonomy,budget_minor,per_creator_cap_minor,target_hires,deadline,status,buyer_name,application_count.
auctions: id,service_id,seller_id,title,creator_name,starting_price_minor,current_price_minor,minimum_increment_minor,buy_now_price_minor,ends_at,starts_at,status,bid_count,winner_id.
Orders: id,buyer_id,creator_id,service_id,source,title,status,amount_minor,platform_fee_minor,provider_fee_minor,currency,brief,delivery_due_at,review_due_at,revision_count,version,buyer_name,creator_name,settlement_status,payment_status.
Deliveries: id,order_id,body,url,version,created_at. Events: id,kind,payload,created_at. Messages: id,body,display_name,created_at. Reviews: rating,body.
ServiceData: {service,creator,samples}; samples title,url,description. null if notfound. getCreatorData(handle): {creator,services,samples}. getRequestData(actor|null,id): {request,applications}; applications only buyer/applicant visible; rows creator_name,quote_minor,note,status,id,creator_id. getAuctionData(actor|null,id): {auction,bids}; bids display_name (pseudonym),amount_minor,created_at.
Dashboard: {orders,services,applications,requests,auctions,stats}; stats {completed_orders,active_orders,gross_minor,available_minor,platform_fee_minor:'0'}; applications id,request_title,quote_minor,status,creator_id,request_id,creator_name; services same public fields. getPublicData accepts optional {q?,category?}.

Commands:
create_service: title,description,taxonomy CREATE/PUBLISH/ACCESS/DIGITAL,price (decimal USD),capacity integer,turnaround_hours,niche; three sample URLs sample_url_1/2/3 and sample_title_1/2/3 optional (or profile existing samples). creates draft then publish separately.
publish_service/pause_service: service_id
set_capacity: pool_id,total_units
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
create_auction: service_id,starting_price,minimum_increment,buy_now_price optional (USD),starts_at,ends_at datetime-local (local timezone applied browser), locks capacity
bid: auction_id,amount (USD)
buy_now/close_auction: auction_id (close only at deadline; service owner or system)
create_pool: request_id,asset_symbol,amount (integer atomic string) LOCAL SIMULATION ONLY no testnet claim
Only display sandbox actions under environment banner; no fake payment UI presented as live.

## W1-A additions (2026-09-13)
Public service rows (getPublicData/getServiceData/getCreatorData) now come from the published immutable version and add: service_version_id, service_version, version, weekly_units (total_units kept = weekly units), available_units (next bookable week), next_available_starts_at, next_available_ends_at, pool_timezone. Owner rows (getDashboardData.services) show current fields + status + version + service_version_id (published) and never leak to public pages.
book: service_id, brief (20+ chars), service_version_id (send the displayed version; 409 QUOTE_CHANGED if the creator updated terms), accept_terms ('on' records auto-accept consent in the order snapshot), bucket_id (optional week choice). Hold lasts CHECKOUT_HOLD_MINUTES (default 15).
create_service: optional pool_id to share an existing weekly pool (then capacity is ignored); sample_url_n/sample_title_n optional pairs.
update_service: service_id, expected_version (required), title, description, price, turnaround_hours. Live services get a new version; existing orders keep theirs.
publish_service / pause_service / archive_service: service_id, expected_version optional. Archived services cannot be republished (422).
set_capacity: pool_id, weekly_units (total_units accepted as alias). 409 CAPACITY_REDUCTION_CONFLICT if any current/future week already holds more.
set_pool_timezone: pool_id, timezone (IANA). Booked weeks keep their dates.
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

getCreatorPools(actor) returns [{id, name, weekly_units, timezone}].

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
- accept_offer: offer_id, pool_id (the creator's own), bucket_id optional. Redirects to /orders/{id} in AWAITING_PAYMENT. Errors: 422 QUOTE_EXPIRED, 409 capacity or state.

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
