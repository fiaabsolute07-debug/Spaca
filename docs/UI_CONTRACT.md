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
