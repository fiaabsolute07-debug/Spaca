# Security or private data incident

Status: local procedure documented; end-to-end incident rehearsal **NOT_RUN**. Baseline `3bddff9`; concurrent P3 changes are unaccepted. [Shared tools and limits](README.md) apply. Platform fee always **0%**.

Owner: engineering incident lead + authorized operator; CRITICAL for active disclosure/privilege compromise.

1. Inspect `/admin/audit`, `/admin/users`, `/admin/moderation`, and restricted `app.audit_log`, `app.user_roles`, `app.upload_intents`, `app.storage_assets`, `app.delivery_assets` and `app.order_events`. Privileged roles come only from active `app.user_roles` grants; `users.roles` is limited to buyer/creator. Audit rows are append-only with reasons, not proof that every possible SQL mutation was audited.
2. Admin role control uses `admin_grant_role` / `admin_revoke_role` on `/admin/users`; moderation/admin uses `admin_suspend_user` (only admin can suspend another admin). Self-role changes/self-suspension are refused. Suspension preserves existing-order obligations; it is not a session-token revocation mechanism. Staff step-up/2FA and an operator session-revoke command are **NOT IMPLEMENTED**.
3. For an unsafe file use `/admin/moderation` → `admin_quarantine_asset` (moderator/admin, asset_id, reason). It moves the object to `private-quarantine`, prevents new download URLs, and marks a linked sample REJECTED. Inspect the audit and affected delivery's ReviewHold; quarantined files cannot auto-accept.
4. Verify upload flow: `POST /api/assets/upload-intents` → signed `PUT /api/dev/storage/upload/[token]` → `POST /api/assets/[id]/finalize`. Finalize checks size/signature/SHA-256 and rechecks permission. CLEAN is signature match, **not antivirus**. Downloads use `POST /api/assets/[id]/download-url` and `GET /api/dev/storage/download/[token]`, with five-minute bearer TTL. Never paste signed URLs into audit reasons or public reports; previously issued bearer links may remain valid during TTL.
5. `cleanup_storage` through the shared hook removes abandoned intents/unattached assets after grace, never referenced files. It is not incident-evidence deletion tooling. For broader financial containment use `/admin/flags`; affected credential rotation requires its owner's infrastructure tooling, which this app does not implement.

Verify outsider/cross-order download denial, quarantine and immutable scope using controlled fixtures before reopening access. LocalStorageProvider only; **Supabase adapter, antivirus, general session revocation and external incident notifications are NOT IMPLEMENTED**. Operator handles any authorized external notification separately.

Never force paid/refunded/released state, write balances or capacity counters, delete audit evidence, or retry an uncertain financial effect with a new operation key. Record actor, UTC time, original identifiers, reason, observed result and next owner. No live payment, external email or deployment is authorized here.
