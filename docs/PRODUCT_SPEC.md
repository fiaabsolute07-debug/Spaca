# Capacity — P0 product specification

## Product promise

Capacity is a creator capacity marketplace. A buyer can discover a creator, see a concrete service scope and samples, reserve an available slot, fund it in the local sandbox, exchange a private brief, receive delivery, request one included revision, approve, and leave a review. A creator can publish capacity with an explicit price, turnaround, sample set, and availability. The platform fee is **0%**; any third-party payment cost is a separately disclosed provider fact.

## Roles and visibility

| Role | Can see | Can do |
| --- | --- | --- |
| Anonymous visitor | Published services, public profiles/samples, open requests, live auctions | Search, view, sign up |
| Buyer | Own orders, own briefs and applications, participant messages/deliveries | Book, fund sandbox order, approve, request revision, dispute, cancel before work, review |
| Creator | Own profile/services, applications they submitted, participant orders | Create/publish/pause service, reserve capacity through orders, start, deliver, message |
| Operator/finance (future live gate) | Scoped support and financial evidence | Resolve disputes/refunds only through audited operations |

Private order data is always queried with a participant predicate. Public catalogue reads only published services and samples with `visibility = PUBLIC` and `moderation_status = APPROVED`; creator workspace reads are scoped to the owner. New linked samples enter `PENDING` moderation. The server owns role checks, capacity locks, money arithmetic, status transitions, and idempotency.

## P0 policy defaults

- USD is the first currency; all amounts are integer minor units (`bigint` in PostgreSQL).
- Platform fee is zero and is persisted as `platform_fee_minor = 0` on every order.
- One included revision is allowed. A revision request keeps the order in the workspace and never silently refunds.
- Sandbox funding is a deterministic local simulation. It does not call a live PSP and must remain visibly labelled.
- `POST` mutations require an exact same-origin `Origin` header, an authenticated actor where required, and an idempotency key. Relative redirect targets are allowlisted.
- No production release is allowed until provider, support, privacy, policy, and live database evidence are present.

## First transaction journey

1. Creator signs up, completes profile, creates a draft service, adds three samples, and publishes it.
2. Buyer signs up, opens the public service, submits a brief, and reserves one capacity unit.
3. Buyer funds the order through `sandbox_pay`; the server commits the reservation and records an event.
4. Creator starts and delivers. Buyer approves, which creates settlement intent/ledger evidence in the durable schema; the local provider remains simulated.
