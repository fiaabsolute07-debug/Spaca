-- W2-B operator foundations (master §2.1, §4.1, §14.3): privileged roles with grant history, append-only
-- audit log, server-side feature flags and kill switches, case/dispute ownership.

-- Privileged roles are granted records, never self-selected profile data --------------------------------
CREATE TABLE app.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('moderator','finance','support','admin')),
  granted_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  granted_reason text NOT NULL CHECK (char_length(granted_reason) BETWEEN 10 AND 1000),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  revoked_reason text,
  revoked_at timestamptz,
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL) OR (revoked_at IS NOT NULL AND char_length(revoked_reason) >= 10))
);
CREATE UNIQUE INDEX user_roles_one_active ON app.user_roles (user_id, role) WHERE revoked_at IS NULL;

-- Move any privileged role that lived in users.roles into user_roles (bootstrap grant, no granter).
INSERT INTO app.user_roles (user_id, role, granted_reason)
SELECT u.id, r.role, 'Migrated from users.roles during 0005 bootstrap'
FROM app.users u CROSS JOIN LATERAL unnest(u.roles) AS r(role)
WHERE r.role IN ('moderator','finance','support','admin')
ON CONFLICT DO NOTHING;
UPDATE app.users SET roles = ARRAY(SELECT x FROM unnest(roles) x WHERE x IN ('buyer','creator'));
ALTER TABLE app.users ADD CONSTRAINT users_marketplace_roles_only CHECK (roles <@ ARRAY['buyer','creator']::text[]);

-- Audit log is append-only -------------------------------------------------------------------------------
ALTER TABLE app.audit_log ALTER COLUMN reason SET NOT NULL;
ALTER TABLE app.audit_log ADD CONSTRAINT audit_log_reason_length CHECK (char_length(reason) BETWEEN 3 AND 2000);
ALTER TABLE app.audit_log ADD COLUMN IF NOT EXISTS actor_roles text[] NOT NULL DEFAULT '{}';
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON app.audit_log FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON app.audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON app.audit_log (actor_id, created_at DESC);

-- Server-side feature flags and kill switches (§2.1) ----------------------------------------------------------
CREATE TABLE app.feature_flags (
  key text PRIMARY KEY CHECK (key ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  enabled boolean NOT NULL,
  description text NOT NULL,
  changed_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  changed_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.feature_flags (key, enabled, description) VALUES
  ('BOOKING_ENABLED', true, 'Book Now checkout for published services'),
  ('REQUESTS_ENABLED', true, 'Buyer requests, applications and hires'),
  ('AUCTIONS_ENABLED', true, 'Auction creation, bids and Buy Now'),
  ('CRYPTO_CHECKOUT_ENABLED', false, 'Crypto funding rails (testnet only until live gates)'),
  ('TOKEN_REWARDS_ENABLED', false, 'Token reward pools'),
  ('NFT_REWARDS_ENABLED', false, 'NFT rewards'),
  ('DISCOVERY_ADVANCED_ENABLED', false, 'Advanced search and ranking'),
  ('ACCESS_BOOKING_ENABLED', false, 'ACCESS appointment bookings'),
  ('DIGITAL_PRODUCTS_ENABLED', false, 'DIGITAL product sales'),
  ('LIVE_PAYMENTS_ENABLED', false, 'Live money movement; requires readiness gates'),
  ('CHECKOUT_CREATION_ENABLED', true, 'Kill switch: creating new checkouts/funding intents'),
  ('BIDDING_ENABLED', true, 'Kill switch: accepting new bids'),
  ('PAYOUT_CREATION_ENABLED', true, 'Kill switch: creating new creator releases/payouts')
ON CONFLICT (key) DO NOTHING;

-- Ownership for operator queues ------------------------------------------------------------------------------
ALTER TABLE app.reconciliation_cases ADD COLUMN IF NOT EXISTS resolution text;
ALTER TABLE app.reconciliation_cases ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES app.users(id) ON DELETE RESTRICT;
ALTER TABLE app.reconciliation_cases ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE app.reconciliation_cases ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES app.users(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS reconciliation_cases_open_idx ON app.reconciliation_cases (status, severity, created_at) WHERE status IN ('OPEN','ASSIGNED');

ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES app.users(id) ON DELETE RESTRICT;
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES app.users(id) ON DELETE RESTRICT;
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS outcome text CHECK (outcome IS NULL OR outcome IN ('RESUME','APPROVE','REFUND_FULL','REFUND_PARTIAL'));
ALTER TABLE app.disputes ADD COLUMN IF NOT EXISTS refund_amount_minor bigint CHECK (refund_amount_minor IS NULL OR refund_amount_minor >= 0);

ALTER TABLE app.samples ADD COLUMN IF NOT EXISTS moderated_by uuid REFERENCES app.users(id) ON DELETE RESTRICT;
ALTER TABLE app.samples ADD COLUMN IF NOT EXISTS moderated_at timestamptz;
ALTER TABLE app.samples ADD COLUMN IF NOT EXISTS moderation_reason text;

GRANT SELECT, INSERT, UPDATE ON app.user_roles, app.feature_flags TO app_server;
GRANT SELECT, INSERT ON app.audit_log TO app_server;
REVOKE UPDATE, DELETE ON app.audit_log FROM app_server;
