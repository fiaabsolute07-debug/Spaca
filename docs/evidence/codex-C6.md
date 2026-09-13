# C6 — Operator console UI

Implemented by Codex (Astra), 2026-09-14 Asia/Ho_Chi_Minh. Ready for Claude's integration review and browser verification. Platform fee remains **0%**.

## Scope and implementation

Only added `src/app/admin/**`, `src/components/admin/**`, this evidence file, and appended 24 lines to `src/app/globals.css`. No dependencies, migrations, backend code, other pages, or tests were changed by C6. Existing concurrent changes were left intact. No git staging, commits, resets, stashes, or checkouts were performed. The initially requested root `BUILD_STATUS.md` / `HANDOFF.md` were absent; their existing `docs/` versions were read.

Every page exports `dynamic = 'force-dynamic'`, calls `requireActorOrLoginPrompt`, and invokes its backend read through `operatorRead`. That shared helper catches `OperatorAccessError` and calls `notFound()`; other errors propagate. Backend role enforcement remains authoritative. Navigation relevance is presentation only; forms explain the required roles, and backend commands enforce them.

| Page | Read model | Commands |
|---|---|---|
| `/admin` | `getOperatorQueues` | None; counts and links for all returned queues, including empty queues relevant to actor roles |
| `/admin/disputes` | `getOperatorQueues` | `admin_resolve_dispute` (`dispute_id`, `outcome`, partial-only USD `refund_amount`, `reason`) |
| `/admin/cases` | `getOperatorQueues` | `admin_assign_case` (`case_id`, `assignee_id`, `reason`); `admin_resolve_case` (`case_id`, `status`, `reason`) |
| `/admin/operations` | `getOperatorQueues` | `admin_retry_operation` (`operation_id`, `reason`); also displays failed outbox, reconciling holds, review holds, overdue orders |
| `/admin/moderation` | `getOperatorQueues` | `admin_moderate_sample` (`sample_id`, `decision`, `reason`); `admin_quarantine_asset` (`asset_id`, `reason`) |
| `/admin/users?q=` | `searchOperatorUsers` | `admin_suspend_user` / `admin_reactivate_user` (`user_id`, `reason`); `admin_grant_role` / `admin_revoke_role` (`user_id`, `role`, `reason`) |
| `/admin/flags` | `getOperatorQueues` | `admin_set_flag` (`key`, `enabled`, `reason`), with live-payment environment-gate warning |
| `/admin/audit?entity_type=&entity_id=` | `getAuditLog` | None; actor, roles snapshot, action, entity, reason, time, before/after JSON details |
| `/admin/orders/[orderId]` | `getOperatorOrder` | `admin_refund_order` (`order_id`, `reason`); state, amounts, parties, clocks, events, operations, cases, disputes, file metadata, review holds |

Each command uses the existing `CommandForm`, posts to `/api/commands`, includes its generated idempotency key and same-page `return_to`, and requires a textarea reason of 10–2000 characters. User command returns use `/admin/users` without `q` because of the existing redirect issue below. Order operations are read-only in the detail view; retries are on `/admin/operations`.

Queue counts describe returned rows (maximum 200 per queue), not uncapped database totals. Cases retain the read model's severity/age ordering. Audit IDs and order IDs receive format validation without bypassing the backend authorization call.

## Components created

- `src/components/admin/admin-nav.tsx`: `AdminNav`, role-relevant links and current-page indication.
- `src/components/admin/ui.tsx`: `AdminPage`, `AdminCommand`, `SelectField`, `OrderLink`, `AdminTable`; `operatorRead`, age/list/query formatters, reference masking, audit JSON redaction.
- `src/components/admin/queue-tables.tsx`: `ProviderOperations`, `ReviewHolds`, reused in queues and order detail.

The existing root layout supplies the local-test environment banner and footer; C6 does not label data or payments as live. No brief/delivery text, sample URLs, download URLs, or provider response payloads are rendered. References are further masked, including short references the read model leaves unchanged. Raw provider error strings are represented as “Error recorded” to avoid reference leakage. Audit JSON redacts content/URL/reference/secret fields. Files are metadata only, with no download actions.

CSS uses wrapping navigation, `minmax(0, 1fr)` grids, constrained inputs, and focusable `.table-wrap` scroll regions. Tables scroll within their regions; cards collapse on small screens. These are implementation measures, not browser-verified viewport results.

## Verification commands and results

Both required commands ran twice: once after initial implementation and once after redirect/UUID hardening. Final results:

```sh
PATH="/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" ./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false
```

PASS, exit 0, no diagnostics.

```sh
PATH="/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" ./node_modules/.bin/vitest run tests/unit
```

PASS, exit 0, **6 test files / 36 tests** on both runs. Final run: 00:06:24 local time, 955 ms. These existing unit tests do not exercise the new pages or database authorization.

```sh
git diff --check -- src/app/admin src/components/admin src/app/globals.css
```

PASS, exit 0. The new files are untracked; this command checks the tracked CSS diff. Source inspection covered new page/form field names and formatting.

The following exact read-only source check also passed:

```sh
python3 - <<'PY'
from pathlib import Path
import subprocess
pages = sorted(Path('src/app/admin').rglob('page.tsx'))
assert len(pages) == 9
for page in pages:
    text = page.read_text()
    for required in ("export const dynamic = 'force-dynamic'", 'requireActorOrLoginPrompt(', 'operatorRead('):
        assert required in text, (page, required)
original = subprocess.check_output(['git', 'show', 'HEAD:src/app/globals.css'])
assert Path('src/app/globals.css').read_bytes().startswith(original)
print('PASS: 9 dynamic authenticated pages use operatorRead; globals.css retains its HEAD prefix.')
PY
```

Additional read-only inspection used `cat`, `sed`, `rg`, `git status --short`, `git diff --stat`, `git diff --numstat`, and a Python line-length scan. No network or installs were used.

## Not verified

- No database startup, migrations, DB integration suite, browser, screenshots, or Next build were run in this task.
- No claim of working command transactions, persisted audit entries, runtime role isolation, signed-download access, or viewport acceptance follows from typecheck/unit passes.
- 360/768/1440 layouts and page-level horizontal overflow remain **NOT_RUN**.
- No provider sandbox/live payments, external email, or deployment were attempted.

## Requests for Claude

1. Run the browser checks at **360/768/1440** with moderator, finance, and admin dev personas; add support for RESUME/case workflows if practical. Check anonymous login prompts, buyer/creator 404s, unauthorized audit/user/order reads, every mutation/error notice, and no page-level horizontal scroll. Verify server rejection of short reasons, wrong-role actions, and live-payment enabling without its environment gate.
2. **Redirect integration gap:** `src/app/api/commands/route.ts` currently selects `result.path || returnTo`. `admin_quarantine_asset` returns `/admin/orders/{id}` for order assets, so successful quarantine navigates away from `/admin/moderation` despite its same-page hidden `return_to`. Please make the authorized admin return path effective or coordinate the intended redirect. The same route appends `?error=` unconditionally, so a query-bearing return path would break error display. C6 avoids query-bearing command returns; user search must be repeated after mutation.
3. Harden malformed UUID handling inside the read models too: `getAuditLog` directly casts `entityId`, and `getOperatorOrder` accepts any 36-character mixture of hex/hyphens. C6 protects these pages, but backend callers should also receive a defined invalid-ID outcome.
4. Pending samples currently expose metadata and a raw URL, with no asset ID or operator preview contract. C6 omits URLs to satisfy the no-signed-URL rule and provides manual asset-ID quarantine. If content preview or sample-to-asset quarantine is needed, supply an authorized preview contract and `storage_asset_id`; no backend additions are required for the current metadata console.

Please review and integrate only the C6 paths listed above; concurrent request/domain/documentation changes belong to Claude.
