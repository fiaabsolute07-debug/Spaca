# Security or private data incident

Status: procedure documented; incident rehearsal **NOT_RUN**. [Shared tooling and evidence limits](README.md) apply.

Severity / escalation: CRITICAL for active exposure/privilege compromise; engineering incident lead and authorized operator own escalation.

Required access: authorized read-only database/log inspection; finance authority for monetary decisions and engineering authority for recovery changes. Local fixture actions require access to the isolated dev process. No production access is implied.

## Symptoms

A foreign user can read private assets/orders, a secret is exposed, or an unexpected privileged action occurs.

## How to detect (read-only)

Preserve a redacted request/time/user/object timeline. Read affected `app.order_events`, `app.provider_operations`, `app.webhook_inbox`, `app.reconciliation_cases`, `app.reservations`, `app.outbox` and `app.ledger_transactions`/`app.ledger_entries` for unauthorized actions or monetary effects. Inspect `app.audit_log` where populated and restricted application/storage/auth logs for access evidence; order events are not a complete privileged audit log. TODO: full audit/role tooling and private storage incident coverage.

## Safe steps

1. Contain the affected endpoint, token or credential using approved infrastructure access; preserve restricted evidence. TODO: verified incident kill switches. Do not dump private records into a public issue.
2. Have the authorized credential owner rotate the affected key without printing it. Revoke affected sessions/upload intents where supported; previously issued signed URLs may remain usable until TTL expires. TODO: operator revocation workflow.
3. Reproduce with controlled local fixtures; engineering fixes authorization and adds a negative regression test covering neighboring flows. Require review before reopening the entrypoint.
4. If money is affected, follow runbooks 01–03 using original operation IDs. The local dev jobs hook is not a security containment command and can move mock funds. TODO: admin queue UI and operator retry command.
5. Prepare incident scope, evidence and remediation facts for the operator. External/user notifications are handled only by an authorized operator under the actual obligations.

## Expected result and invariant check

Expected: exposure contained and regression evidence proves the boundary; affected users/objects and financial consequences are accounted for. Verify ledger/capacity invariants, platform fee 0%, deduplicated outbox and preserved audit evidence before reopening. Record actor, UTC time, original IDs, reason, outcome and next owner in restricted incident evidence; use the audited case workflow when available.

## Forbidden actions

Never force paid, never set balances, never retry with a new key. Never publish secrets/private deliveries, delete audit evidence, impersonate users or send external incident messages without authority.
