# P6-ACCESS evidence: time-slot sessions with buffers, time zones, cancellation notice and no-shows (Claude, 2026-09-15)

Scope: master §6.5 (appointment intervals), §16.9 P6-03 and §18 CAP-11, XPL-03.

Environment: **local only**. Embedded PostgreSQL 18, mock payment provider, Next dev server on 3100, system Chrome (TZ=UTC for Playwright). No calendar or video-call integration.

## What changed

- **Migration `drizzle/0015_access_booking.sql`**
  - Session terms on `services` and `service_versions`: `access_session_minutes` (15–480), `access_buffer_minutes` (0–120), `access_cancel_notice_hours` (0–168), `access_no_show_minutes` (5–60).
    - A published ACCESS listing must have all four (CHECK); legacy published ACCESS listings moved to DRAFT.
    - The version CHECK is `NOT VALID`, like PUBLISH, so old history stays readable.
  - `app.availability_windows`: weekly windows (weekday 1–7, start/end minute, IANA time zone) per creator.
  - `app.appointments`: one per order, with UTC `starts_at`/`ends_at`, buffer, creator time zone, cancellation notice, no-show grace, private `meeting_url` (https only) and state HELD → BOOKED → COMPLETED / NO_SHOW_BUYER / NO_SHOW_CREATOR, or CANCELLED.
    - `blocked_until` = end + buffer, set by trigger.
    - **GiST exclusion constraint** `appointments_no_overlap` on (creator, [starts_at, blocked_until)) for HELD/BOOKED rows.
    - Times and parties are immutable; the state machine is enforced by trigger; no deletes.
    - Order trigger: FUNDED books the slot; CANCELLED/REFUNDED cancel it (hold expiry frees it too).
- **Time rules (`src/modules/access/time.ts`)**
  - 15-minute grid in the creator's local time; at least 12 h notice; 60-day horizon.
  - DST gap: local times that do not exist offer nothing. DST overlap: the first occurrence is used, never offered twice.
  - A session lasts real elapsed minutes and must end inside the same window.
- **Domain (`src/modules/access/index.ts`, `commands.ts`)**
  - `set_availability` replaces windows (JSON or the plain per-day form); overlapping windows and invalid zones are refused. An exclusive advisory lock serializes it against bookings, which take the shared lock.
  - `book` for ACCESS:
    - requires `ACCESS_BOOKING_ENABLED` and `starts_at` (ISO with zone), and the start must be offered;
    - claims the order limit, then inserts the HELD appointment. An exclusion violation returns 409 `SLOT_TAKEN`;
    - snapshots `terms.access` (length, buffer, notice, grace, creator time zone, start/end, `access-v1`);
    - sets `delivery_due_at` = session end + 24 h.
  - Publishing ACCESS needs the flag, complete terms and at least one availability window.
  - `set_meeting_link` (creator only, https). The link is readable only through the participant-scoped order read, and the event payload does not include it.
  - `mark_session`:
    - COMPLETED once started, or NO_SHOW_BUYER after the grace period, with a note of at least 20 characters;
    - moves the order FUNDED → IN_PROGRESS → DELIVERED with the note as the delivery, so the normal review/approve/dispute rules apply.
  - `report_creator_no_show` (buyer, after grace): appointment NO_SHOW_CREATOR, order → DISPUTED (via IN_PROGRESS), crypto escrow frozen, dispute notification.
  - Orders:
    - `start` and `deliver` are refused for sessions (outcome recording replaces them).
    - Buyer `cancel` of a funded session inside the notice is refused; `request_cancellation`/`respond_cancellation` accept FUNDED sessions, so a late cancellation needs the creator's agreement.
    - The creator can always cancel with a full refund.
- **Read API** `GET /api/services/[id]/slots?from&days` (1–14 days): free UTC starts for a published ACCESS service; 404 for other categories, 503 while the flag is off. No buyer data.
- **UI**
  - Service page: session terms and a slot picker in the viewer's time zone (says the creator's zone when different).
  - Creator services: "Session availability" plain form (time zone + one window per weekday; works without JavaScript).
  - New service: ACCESS fields.
  - Order page: Session panel (start in the viewer's zone, status, private join link, cancellation window, meeting link form, outcome and no-show actions only when valid). The delivery panel reads "Session record". Next step hides Start work and offers Request cancellation inside the notice.

## Tests run

| Suite | Result |
|---|---|
| `tests/unit/access-time.test.ts` | 4/4 (DST gap/overlap New York, 15-minute grid, notice, horizon, window validation) |
| `RUN_DB_INTEGRATION=1 vitest run tests/integration/access.db.test.ts` | 9/9 |
| `TZ=UTC playwright test tests/e2e/access.spec.ts` | 1/1 |
| Full `RUN_DB_INTEGRATION=1 vitest run` | 261 passed, 3 skipped (anvil, opt-in) |

What the DB suite proves:
- **CAP-11:** same start → 409; a start inside the previous buffer (+60 min for 60+15) → 409; a start whose own buffer reaches the next session (−60) → 409; +75 and −75 accepted. The slots API hides every blocked start. A raw SQL insert that overlaps is rejected by `appointments_no_overlap`. Four concurrent bookings of one start → exactly one 200. Workload drift 0.
- **Hold expiry and funding:** an expired hold cancels the appointment and the slot is offered again; funding sets BOOKED; `delivery_due_at` = end + 24 h; `terms.access` snapshot is exact.
- **Offered starts only:** off-grid, inside the 12 h notice, outside windows or missing `starts_at` → 422. Monday 09:00–10:00 with 60-minute sessions offers only Monday 09:00 UTC.
- **XPL-03 time zones:** Asia/Ho_Chi_Minh windows appear as the right UTC instants. Switching the creator to America/New_York keeps the booked instant and its snapshot zone, and new slots follow New York. Invalid zone and overlapping windows → 400. The plain form maps 23:59 to midnight.
- **Cancellation notice:** a session 72 h out is cancelled by the buyer with a full refund. One 14 h out is refused (422), then a cancellation request for $60 is accepted by the creator: CANCELLED, refund 6000 minor, settlement READY, appointment CANCELLED.
- **Outcomes** (Date faked with `vi.useFakeTimers({ toFake: ['Date'] })`):
  - COMPLETED is refused before the start; NO_SHOW_BUYER is refused before the grace period; short notes are refused.
  - Completed session → DELIVERED with the note as version 1; the buyer approves and the unit is freed.
  - Buyer no-show after 11 minutes → DELIVERED.
  - Creator no-show reported at 5 minutes → 422; at 12 minutes → DISPUTED, one dispute. The creator can no longer mark the session (409).
- Meeting link: buyer cannot set it (403), http refused, the event payload does not contain it; `start` refused for a session.
- Flag: ACCESS publish without windows → 400; session length off the 15-minute grid → 400; with the flag off, booking → 422 and slots → 503.

E2E journey (system Chrome):
1. Admin enables `ACCESS_BOOKING_ENABLED` with an audit reason.
2. creator_d saves 7 windows in Asia/Ho_Chi_Minh, then creates and publishes a 45-minute ACCESS service.
3. buyer_a picks the first slot in the picker, reserves and pays. The Session panel shows Booked; inside the notice, Cancel order is absent and Request cancellation is shown.
4. The creator sees no Start work, saves a meeting link and sees "record the outcome once the session starts". The buyer sees the join link.
5. The public service page at 390 px has no horizontal overflow and does not show the link.

## Regressions fixed

- `tests/integration/discovery.db.test.ts` published an ACCESS listing without terms. The fixture now sets availability and enables the flag around that publish.
- `scripts/discovery-benchmark.ts` inserts ACCESS terms for its generated ACCESS listings.

## Limits (not claimed)

- No calendar sync, reminders or video-call provider. The meeting link is whatever the creator pastes.
- Session outcomes are self-reported by the parties. Disputes decide contested no-shows; there is no attendance proof.
- Request/hire (bespoke) ACCESS orders do not create appointments yet; they agree a time in the brief. Only Book creates sessions.
- One window per weekday in the UI (the API accepts several).
- The dev DB now has `ACCESS_BOOKING_ENABLED` on from the E2E run; migrations keep it off by default.
