# Claude review: C6 operator console (Codex)

Reviewed 2026-09-14. Scope: `src/app/admin/**` (9 pages), `src/components/admin/**` (3 files), and 24 lines appended to `src/app/globals.css`.

## Findings

- **Scope and data handling look right.** Each page is dynamic and authenticated, and every read goes through `operatorRead`. That helper turns `OperatorAccessError` into 404, so role checks stay on the server.
- **No private content is shown.** Forms use the documented commands and all require a reason. There is no brief or delivery text and no signed URL. Provider references and audit JSON are masked a second time on top of backend redaction.
- **No new dependencies**, and code formatting is readable.

**Codex requests, resolved in this integration:**

| # | Request | Resolution |
|---|---|---|
| 2 | Redirects | The command envelope now sends `admin_*` forms back to their `return_to`, not the entity path. Both `message` and `error` are appended with `?` or `&` as needed, so query-bearing return paths keep working. Covered by a new admin test. |
| 3 | UUID hardening | `getAuditLog` returns `[]` for a malformed `entityId`. `getOperatorOrder` uses `UUID_PATTERN`. Covered by a new admin test. |
| 4 | Pending samples | Now include `storage_asset_id`, so moderators can quarantine a sample's file. Preview is not added. |

## Verification (Claude)

- **Type checks and DB tests**
  - `tsc --noEmit` exit 0.
  - `RUN_DB_INTEGRATION=1 vitest run tests/integration/admin.db.test.ts` passed 12/12, including 2 new tests: operator read model scoping/redaction/malformed ids, and console redirect with message plus a query-preserving error.
  - Full suite: see the commit message.
- **Browser access matrix** (Next dev, dev DB, fixture sessions, no passwords)

  | Persona | Pages checked | Result |
  |---|---|---|
  | buyer_a | `/admin`, `/admin/audit` | 404 |
  | moderator | `/admin`, `/admin/moderation`, `/admin/users?q=sam` | 200 |
  | moderator | `/admin/audit`, `/admin/orders/{id}` | 404 |
  | finance | `/admin/disputes`, `/admin/operations`, `/admin/orders/{id}`, `/admin/audit` | 200 |
  | admin | `/admin/flags`, `/admin/cases`, `/admin/users?q=ari` | 200 |

  No page contained brief text or `/api/dev/storage/` URLs.
- **Browser form submission at 360 px**
  - As admin, `/admin/flags` has no horizontal overflow.
  - Submitting the DISCOVERY_ADVANCED_ENABLED form with a reason redirected to `/admin/flags?message=…`, and the page then showed the recorded reason.
- **Not run:** 768 and 1440 visual passes, and dispute/case forms against live queue rows. The dev DB currently has no open disputes or cases. The same commands are covered by the admin DB suite.
