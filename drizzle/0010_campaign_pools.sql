-- W5-C2: funded campaign pools (master §11.5/§11.6; CRY-06..10, CRY-12). A request can be backed by a pool funded
-- once per asset; each accepted hire allocates the reward template atomically and its order is funded from the
-- allocation. Per asset the database enforces:
--   confirmed_deposit = unallocated + allocated_active + pending_outflow + released + refunded   (all buckets >= 0)

ALTER TABLE app.orders DROP CONSTRAINT IF EXISTS orders_payment_rail_check;
ALTER TABLE app.orders ADD CONSTRAINT orders_payment_rail_check CHECK (payment_rail IN ('MOCK_PROVIDER','CRYPTO','POOL'));

CREATE TABLE app.campaign_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES app.requests(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  chain_id bigint NOT NULL REFERENCES app.chain_networks(chain_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'FUNDING' CHECK (status IN ('FUNDING','ACTIVE','CLOSED')),
  template_version integer NOT NULL DEFAULT 1 CHECK (template_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);

-- Reward templates are versioned and append-only: an accepted hire keeps the version it accepted (§11.6).
CREATE TABLE app.pool_templates (
  pool_id uuid NOT NULL REFERENCES app.campaign_pools(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 10),
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool_id, version)
);
CREATE TRIGGER pool_templates_append_only BEFORE UPDATE OR DELETE ON app.pool_templates FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TABLE app.pool_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES app.campaign_pools(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES app.chain_assets(id) ON DELETE RESTRICT,
  required boolean NOT NULL,
  target_atomic numeric(78,0) NOT NULL DEFAULT 0 CHECK (target_atomic >= 0),
  confirmed_deposit numeric(78,0) NOT NULL DEFAULT 0,
  unallocated numeric(78,0) NOT NULL DEFAULT 0,
  allocated_active numeric(78,0) NOT NULL DEFAULT 0,
  pending_outflow numeric(78,0) NOT NULL DEFAULT 0,
  released numeric(78,0) NOT NULL DEFAULT 0,
  refunded numeric(78,0) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, asset_id),
  CONSTRAINT pool_assets_nonnegative CHECK (confirmed_deposit >= 0 AND unallocated >= 0 AND allocated_active >= 0 AND pending_outflow >= 0 AND released >= 0 AND refunded >= 0),
  CONSTRAINT pool_assets_conservation CHECK (confirmed_deposit = unallocated + allocated_active + pending_outflow + released + refunded)
);

-- Deposits never shrink; only movements between buckets. Journal every movement for reconciliation.
CREATE OR REPLACE FUNCTION app.pool_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pool_id IS DISTINCT FROM OLD.pool_id OR NEW.asset_id IS DISTINCT FROM OLD.asset_id THEN
    RAISE EXCEPTION 'pool asset identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.confirmed_deposit < OLD.confirmed_deposit OR NEW.released < OLD.released OR NEW.refunded < OLD.refunded THEN
    RAISE EXCEPTION 'pool deposits, releases and refunds are cumulative' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pool_assets_guard BEFORE UPDATE ON app.pool_assets FOR EACH ROW EXECUTE FUNCTION app.pool_asset_guard();
CREATE TRIGGER pool_assets_no_delete BEFORE DELETE ON app.pool_assets FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TABLE app.pool_ledger (
  id bigserial PRIMARY KEY,
  pool_asset_id uuid NOT NULL REFERENCES app.pool_assets(id) ON DELETE RESTRICT,
  movement text NOT NULL CHECK (movement IN ('DEPOSIT','ALLOCATE','DEALLOCATE','RELEASE_START','RELEASE_DONE','RELEASE_FAILED','REFUND_START','REFUND_DONE','REFUND_FAILED')),
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic > 0),
  reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (movement, reference)
);
CREATE TRIGGER pool_ledger_append_only BEFORE UPDATE OR DELETE ON app.pool_ledger FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TABLE app.pool_funding_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES app.campaign_pools(id) ON DELETE RESTRICT,
  pool_asset_id uuid NOT NULL REFERENCES app.pool_assets(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  chain_id bigint NOT NULL REFERENCES app.chain_networks(chain_id) ON DELETE RESTRICT,
  network_mode text NOT NULL CHECK (network_mode IN ('LOCAL','TESTNET')),
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic > 0),
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^0x[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'AWAITING_DEPOSIT' CHECK (status IN ('AWAITING_DEPOSIT','PENDING_FINALITY','CONFIRMED','EXCEPTION','CANCELLED')),
  status_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.chain_deposits ADD COLUMN pool_intent_id uuid REFERENCES app.pool_funding_intents(id) ON DELETE RESTRICT;
ALTER TABLE app.chain_deposits DROP CONSTRAINT chain_deposits_credit_fields;
ALTER TABLE app.chain_deposits ADD CONSTRAINT chain_deposits_credit_fields CHECK ((status = 'CREDITED') = (credited_at IS NOT NULL));
ALTER TABLE app.chain_deposits ADD CONSTRAINT chain_deposits_credit_target CHECK (status <> 'CREDITED' OR (asset_id IS NOT NULL AND num_nonnulls(intent_id, pool_intent_id) = 1));
ALTER TABLE app.chain_deposits ADD CONSTRAINT chain_deposits_single_target CHECK (num_nonnulls(intent_id, pool_intent_id) <= 1);
CREATE UNIQUE INDEX chain_deposits_one_credit_per_pool_intent ON app.chain_deposits (pool_intent_id) WHERE status = 'CREDITED';

-- One allocation per hire and template item; the order is funded from these rows, never charged again.
CREATE TABLE app.pool_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES app.campaign_pools(id) ON DELETE RESTRICT,
  pool_asset_id uuid NOT NULL REFERENCES app.pool_assets(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  template_version integer NOT NULL,
  item_key text NOT NULL CHECK (item_key ~ '^[a-z0-9_-]{1,40}$'),
  kind text NOT NULL CHECK (kind IN ('CASH','TOKEN')),
  required boolean NOT NULL,
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic > 0),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','RELEASE_PENDING','RELEASED','CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  release_tx text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, item_key),
  FOREIGN KEY (pool_id, template_version) REFERENCES app.pool_templates (pool_id, version) ON DELETE RESTRICT
);
CREATE INDEX pool_allocations_open_idx ON app.pool_allocations (order_id) WHERE state IN ('ACTIVE','RELEASE_PENDING');

CREATE OR REPLACE FUNCTION app.pool_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pool_asset_id IS DISTINCT FROM OLD.pool_asset_id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.amount_atomic IS DISTINCT FROM OLD.amount_atomic
     OR NEW.item_key IS DISTINCT FROM OLD.item_key OR NEW.template_version IS DISTINCT FROM OLD.template_version OR NEW.required IS DISTINCT FROM OLD.required THEN
    RAISE EXCEPTION 'pool allocation terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('RELEASED','CANCELLED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'pool allocation % is final (%)', OLD.id, OLD.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pool_allocations_guard BEFORE UPDATE ON app.pool_allocations FOR EACH ROW EXECUTE FUNCTION app.pool_allocation_guard();
CREATE TRIGGER pool_allocations_no_delete BEFORE DELETE ON app.pool_allocations FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TABLE app.pool_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_asset_id uuid NOT NULL REFERENCES app.pool_assets(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic > 0),
  state text NOT NULL DEFAULT 'REFUND_PENDING' CHECK (state IN ('REFUND_PENDING','REFUNDED','FAILED')),
  last_error text,
  refund_tx text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Server-issued, domain-bound release authorizations (CRY-10); the nonce is consumed once.
CREATE TABLE app.release_authorizations (
  nonce text PRIMARY KEY CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  payout_kind text NOT NULL CHECK (payout_kind IN ('ALLOCATION','POOL_REFUND')),
  payout_id uuid NOT NULL,
  chain_id bigint NOT NULL,
  verifying_contract text NOT NULL,
  recipient text NOT NULL,
  token text NOT NULL,
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic > 0),
  expires_at timestamptz NOT NULL,
  signature text NOT NULL,
  consumed_at timestamptz,
  outcome text CHECK (outcome IN ('TRANSFERRED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX release_authorizations_payout_idx ON app.release_authorizations (payout_kind, payout_id);

-- PERK / NFT entitlements: unique per hire and item, and one NFT token can back one entitlement (CRY-12).
CREATE TABLE app.reward_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES app.campaign_pools(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  template_version integer NOT NULL,
  item_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PERK','NFT')),
  perk_type text NOT NULL,
  description text NOT NULL,
  fulfillment_method text NOT NULL,
  required boolean NOT NULL,
  deadline_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','FULFILLED','CLAIMED','CANCELLED')),
  proof jsonb,
  nft_chain_id bigint,
  nft_contract text CHECK (nft_contract IS NULL OR nft_contract ~ '^0x[0-9a-f]{40}$'),
  nft_token_id numeric(78,0),
  fulfilled_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, item_key),
  CHECK (kind <> 'NFT' OR status NOT IN ('FULFILLED','CLAIMED') OR (nft_chain_id IS NOT NULL AND nft_contract IS NOT NULL AND nft_token_id IS NOT NULL))
);
CREATE UNIQUE INDEX reward_entitlements_one_nft ON app.reward_entitlements (nft_chain_id, nft_contract, nft_token_id) WHERE nft_token_id IS NOT NULL AND status <> 'CANCELLED';

GRANT SELECT, INSERT, UPDATE ON app.campaign_pools, app.pool_assets, app.pool_funding_intents, app.pool_allocations, app.pool_refunds,
  app.release_authorizations, app.reward_entitlements TO app_server;
GRANT SELECT, INSERT ON app.pool_templates, app.pool_ledger TO app_server;
GRANT USAGE, SELECT ON SEQUENCE app.pool_ledger_id_seq TO app_server;
