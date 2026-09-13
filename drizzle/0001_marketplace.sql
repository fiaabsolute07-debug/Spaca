CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_server') THEN
    CREATE ROLE app_server LOGIN PASSWORD 'local_dev_only';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  password_hash text,
  roles text[] NOT NULL DEFAULT ARRAY['buyer','creator']::text[],
  is_test boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.profiles (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9_-]{2,31}$'),
  bio text NOT NULL DEFAULT '',
  niche text NOT NULL DEFAULT 'Independent creator',
  avatar_color text NOT NULL DEFAULT '#e7bda6',
  social_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  url text NOT NULL CHECK (url ~ '^https?://'),
  description text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC','PRIVATE')),
  moderation_status text NOT NULL DEFAULT 'APPROVED' CHECK (moderation_status IN ('PENDING','APPROVED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.capacity_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  total_units integer NOT NULL CHECK (total_units >= 0),
  reserved_units integer NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  committed_units integer NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved_units + committed_units <= total_units)
);

CREATE TABLE IF NOT EXISTS app.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  pool_id uuid NOT NULL REFERENCES app.capacity_pools(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  description text NOT NULL CHECK (char_length(description) BETWEEN 20 AND 10000),
  taxonomy text NOT NULL CHECK (taxonomy IN ('CREATE','PUBLISH','ACCESS','DIGITAL')),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','EUR','GBP','JPY','VND')),
  turnaround_hours integer NOT NULL CHECK (turnaround_hours BETWEEN 1 AND 8760),
  revision_limit integer NOT NULL DEFAULT 1 CHECK (revision_limit = 1),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','PAUSED','ARCHIVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  brief text NOT NULL CHECK (char_length(brief) BETWEEN 20 AND 12000),
  taxonomy text NOT NULL CHECK (taxonomy IN ('CREATE','PUBLISH','ACCESS','DIGITAL')),
  budget_minor bigint NOT NULL CHECK (budget_minor > 0),
  per_creator_cap_minor bigint NOT NULL CHECK (per_creator_cap_minor > 0),
  target_hires integer NOT NULL DEFAULT 1 CHECK (target_hires BETWEEN 1 AND 100),
  deadline timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SELECTING','FILLED','CANCELLED','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES app.requests(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  quote_minor bigint NOT NULL CHECK (quote_minor > 0),
  turnaround_hours integer NOT NULL CHECK (turnaround_hours BETWEEN 1 AND 8760),
  note text NOT NULL CHECK (char_length(note) BETWEEN 20 AND 8000),
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','SELECTED','OFFERED','ACCEPTED','DECLINED','WITHDRAWN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, creator_id)
);

CREATE TABLE IF NOT EXISTS app.auctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES app.services(id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  title text NOT NULL,
  starting_price_minor bigint NOT NULL CHECK (starting_price_minor > 0),
  current_price_minor bigint CHECK (current_price_minor IS NULL OR current_price_minor >= starting_price_minor),
  minimum_increment_minor bigint NOT NULL CHECK (minimum_increment_minor > 0),
  buy_now_price_minor bigint CHECK (buy_now_price_minor IS NULL OR buy_now_price_minor >= starting_price_minor),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','LIVE','AWAITING_WINNER_PAYMENT','CLOSED','EXPIRED','CANCELLED')),
  bid_count integer NOT NULL DEFAULT 0 CHECK (bid_count >= 0),
  winner_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (buy_now_price_minor IS NULL OR buy_now_price_minor >= starting_price_minor)
);

CREATE TABLE IF NOT EXISTS app.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  service_id uuid REFERENCES app.services(id) ON DELETE RESTRICT,
  pool_id uuid REFERENCES app.capacity_pools(id) ON DELETE RESTRICT,
  source text NOT NULL DEFAULT 'BOOK' CHECK (source IN ('BOOK','REQUEST','AUCTION')),
  source_ref uuid,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'AWAITING_PAYMENT' CHECK (status IN ('AWAITING_PAYMENT','FUNDED','IN_PROGRESS','DELIVERED','REVISION_REQUESTED','APPROVED','COMPLETED','CANCELLED','REFUNDED','DISPUTED')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  platform_fee_minor bigint NOT NULL DEFAULT 0 CHECK (platform_fee_minor = 0),
  provider_fee_minor bigint CHECK (provider_fee_minor IS NULL OR provider_fee_minor >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','EUR','GBP','JPY','VND')),
  brief text NOT NULL CHECK (char_length(brief) >= 20),
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivery_due_at timestamptz,
  review_due_at timestamptz,
  revision_count integer NOT NULL DEFAULT 0 CHECK (revision_count BETWEEN 0 AND 1),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  payment_status text NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING','PROCESSING','SUCCEEDED','FAILED','REFUND_PENDING','REFUNDED')),
  settlement_status text NOT NULL DEFAULT 'NOT_READY' CHECK (settlement_status IN ('NOT_READY','READY','PENDING','RELEASED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> creator_id)
);

CREATE TABLE IF NOT EXISTS app.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES app.capacity_pools(id) ON DELETE RESTRICT,
  order_id uuid UNIQUE REFERENCES app.orders(id) ON DELETE CASCADE,
  auction_id uuid UNIQUE REFERENCES app.auctions(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('HELD','RECONCILING','COMMITTED','CONSUMED','RELEASED')),
  units integer NOT NULL DEFAULT 1 CHECK (units = 1),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (order_id IS NOT NULL OR auction_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS app.bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES app.auctions(id) ON DELETE CASCADE,
  bidder_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 12000),
  url text CHECK (url IS NULL OR url ~ '^https?://'),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, version)
);

CREATE TABLE IF NOT EXISTS app.order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid UNIQUE NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  opened_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 5000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UNDER_REVIEW','RESOLVED','CANCELLED')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  command text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, command, idempotency_key)
);

CREATE TABLE IF NOT EXISTS app.provider_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id text NOT NULL UNIQUE,
  order_id uuid REFERENCES app.orders(id) ON DELETE SET NULL,
  kind text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED','UNKNOWN')),
  provider_reference text,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  mode text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, mode, event_id)
);

CREATE TABLE IF NOT EXISTS app.ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES app.orders(id) ON DELETE SET NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES app.ledger_transactions(id) ON DELETE CASCADE,
  account text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  aggregate_id uuid,
  semantic_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE TABLE IF NOT EXISTS app.reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES app.orders(id) ON DELETE SET NULL,
  provider_operation_id uuid REFERENCES app.provider_operations(id) ON DELETE SET NULL,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'MEDIUM',
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','RESOLVED','IGNORED')),
  owner text,
  next_action text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.reward_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid REFERENCES app.requests(id) ON DELETE SET NULL,
  asset_symbol text NOT NULL,
  amount_atomic text NOT NULL CHECK (amount_atomic ~ '^[0-9]+$'),
  status text NOT NULL DEFAULT 'SIMULATED' CHECK (status IN ('SIMULATED','PENDING','CONFIRMED','FAILED')),
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  reason text,
  before_state jsonb,
  after_state jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON app.sessions(user_id);
CREATE INDEX IF NOT EXISTS services_public_idx ON app.services(status, taxonomy, created_at DESC);
CREATE INDEX IF NOT EXISTS services_creator_idx ON app.services(creator_id, status);
CREATE INDEX IF NOT EXISTS samples_creator_idx ON app.samples(creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_public_idx ON app.requests(status, deadline);
CREATE INDEX IF NOT EXISTS applications_request_idx ON app.applications(request_id, status, created_at);
CREATE INDEX IF NOT EXISTS auctions_public_idx ON app.auctions(status, ends_at);
CREATE INDEX IF NOT EXISTS bids_auction_idx ON app.bids(auction_id, amount_minor DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS orders_buyer_idx ON app.orders(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_creator_idx ON app.orders(creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON app.order_events(order_id, created_at);
CREATE INDEX IF NOT EXISTS messages_order_idx ON app.messages(order_id, created_at);

GRANT USAGE ON SCHEMA app TO app_server;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_server;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_server;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_server;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app_server;
