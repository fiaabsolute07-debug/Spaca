-- Durable in-app notification timeline and local email sink (master §14.2).
-- Email rows are never sent from this table; status EMAIL_SINK marks them as captured locally.

CREATE TABLE IF NOT EXISTS app.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app','email')),
  template_id text NOT NULL CHECK (template_id ~ '^[a-z]+\.[a-z_]+$'),
  category text NOT NULL CHECK (category IN ('transactional','security','marketing')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  link_path text NOT NULL CHECK (link_path ~ '^/[A-Za-z0-9_/-]*$'),
  dedupe_key text NOT NULL UNIQUE CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  semantic_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('DELIVERED','EMAIL_SINK')),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON app.notifications(recipient_id, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS outbox_dispatch_idx ON app.outbox(status, available_at) WHERE status IN ('PENDING','FAILED');
CREATE INDEX IF NOT EXISTS webhook_inbox_unprocessed_idx ON app.webhook_inbox(created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS reservations_expiry_idx ON app.reservations(state, expires_at) WHERE state IN ('HELD','RECONCILING');
CREATE INDEX IF NOT EXISTS provider_operations_status_idx ON app.provider_operations(status, updated_at);

GRANT SELECT, INSERT, UPDATE ON app.notifications TO app_server;
