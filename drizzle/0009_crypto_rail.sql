-- W5-C1: crypto checkout rail (master §11.1-11.4; CRY-01..05, CRY-11 allowlist, CRY-14 mainnet gate).
-- Chain facts are verified by the server/indexer, never taken from a client-submitted hash. Only LOCAL (simulated)
-- and TESTNET networks can be enabled; MAINNET stays disabled until a separate go-live gate exists.

CREATE TABLE app.chain_networks (
  chain_id bigint PRIMARY KEY CHECK (chain_id > 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  mode text NOT NULL CHECK (mode IN ('LOCAL','TESTNET','MAINNET')),
  settlement_address text NOT NULL CHECK (settlement_address ~ '^0x[0-9a-f]{40}$'),
  finality_confirmations integer NOT NULL CHECK (finality_confirmations BETWEEN 0 AND 10000),
  enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  verification_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chain_networks_mainnet_blocked CHECK (mode <> 'MAINNET' OR NOT enabled),
  CONSTRAINT chain_networks_testnet_verified CHECK (mode <> 'TESTNET' OR NOT enabled OR verified_at IS NOT NULL)
);

-- Assets: decimals come from the registry entry (verified per interface), never from the symbol.
-- balance_key groups interfaces of one balance (native USDC and its ERC-20 interface) so a deposit is counted once.
CREATE TABLE app.chain_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL REFERENCES app.chain_networks(chain_id) ON DELETE RESTRICT,
  symbol text NOT NULL CHECK (symbol ~ '^[A-Z0-9.]{2,12}$'),
  kind text NOT NULL CHECK (kind IN ('NATIVE','ERC20')),
  contract_address text CHECK (contract_address IS NULL OR contract_address ~ '^0x[0-9a-f]{40}$'),
  decimals integer NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  balance_key text NOT NULL CHECK (char_length(balance_key) BETWEEN 1 AND 40),
  usd_pegged boolean NOT NULL DEFAULT false,
  transfer_behavior text NOT NULL DEFAULT 'UNKNOWN' CHECK (transfer_behavior IN ('STANDARD','FEE_ON_TRANSFER','REBASING','UNKNOWN')),
  allowlisted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chain_assets_native_has_no_contract CHECK ((kind = 'NATIVE') = (contract_address IS NULL)),
  CONSTRAINT chain_assets_standard_only CHECK (NOT allowlisted OR transfer_behavior = 'STANDARD'),
  CONSTRAINT chain_assets_pegged_needs_cents CHECK (NOT usd_pegged OR decimals >= 2)
);
CREATE UNIQUE INDEX chain_assets_identity ON app.chain_assets (chain_id, kind, coalesce(contract_address, ''));

-- Wallet proof of control: server-built EIP-4361-style message, single-use nonce, domain/chain/expiry bound.
CREATE TABLE app.wallet_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  chain_id bigint NOT NULL REFERENCES app.chain_networks(chain_id) ON DELETE RESTRICT,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  nonce text NOT NULL UNIQUE CHECK (nonce ~ '^[A-Za-z0-9]{16,64}$'),
  domain text NOT NULL,
  uri text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX wallet_challenges_user_idx ON app.wallet_challenges (user_id, issued_at DESC);

CREATE TABLE app.wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  chain_id bigint NOT NULL REFERENCES app.chain_networks(chain_id) ON DELETE RESTRICT,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  challenge_id uuid NOT NULL UNIQUE REFERENCES app.wallet_challenges(id) ON DELETE RESTRICT,
  verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX wallets_active_address ON app.wallets (chain_id, address) WHERE revoked_at IS NULL;

-- Orders remember which rail funded them (receipt labels, reconciliation).
ALTER TABLE app.orders ADD COLUMN payment_rail text NOT NULL DEFAULT 'MOCK_PROVIDER' CHECK (payment_rail IN ('MOCK_PROVIDER','CRYPTO'));

CREATE TABLE app.crypto_payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  chain_id bigint NOT NULL REFERENCES app.chain_networks(chain_id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES app.chain_assets(id) ON DELETE RESTRICT,
  network_mode text NOT NULL CHECK (network_mode IN ('LOCAL','TESTNET')),
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic > 0),
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^0x[0-9a-f]{64}$'),
  payer_wallet_id uuid REFERENCES app.wallets(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'AWAITING_DEPOSIT' CHECK (status IN ('AWAITING_DEPOSIT','PENDING_FINALITY','CONFIRMED','EXCEPTION','CANCELLED')),
  status_reason text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crypto_payment_intents_one_open ON app.crypto_payment_intents (order_id) WHERE status IN ('AWAITING_DEPOSIT','PENDING_FINALITY');
CREATE UNIQUE INDEX crypto_payment_intents_one_confirmed ON app.crypto_payment_intents (order_id) WHERE status = 'CONFIRMED';

-- One row per chain event identity (CRY-03). log_index is the settlement event's index in the receipt.
CREATE TABLE app.chain_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL REFERENCES app.chain_networks(chain_id) ON DELETE RESTRICT,
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  emitter text NOT NULL CHECK (emitter ~ '^0x[0-9a-f]{40}$'),
  token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  asset_id uuid REFERENCES app.chain_assets(id) ON DELETE RESTRICT,
  payer text NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic >= 0),
  reference text NOT NULL CHECK (reference ~ '^0x[0-9a-f]{64}$'),
  intent_id uuid REFERENCES app.crypto_payment_intents(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('PENDING_FINALITY','CREDITED','REJECTED','REORGED')),
  reason text,
  credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index),
  CONSTRAINT chain_deposits_credit_fields CHECK ((status = 'CREDITED') = (credited_at IS NOT NULL AND intent_id IS NOT NULL AND asset_id IS NOT NULL))
);
CREATE UNIQUE INDEX chain_deposits_one_credit_per_intent ON app.chain_deposits (intent_id) WHERE status = 'CREDITED';
CREATE INDEX chain_deposits_pending_idx ON app.chain_deposits (chain_id, block_number) WHERE status = 'PENDING_FINALITY';

CREATE OR REPLACE FUNCTION app.chain_deposit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.chain_id IS DISTINCT FROM OLD.chain_id OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash OR NEW.log_index IS DISTINCT FROM OLD.log_index
     OR NEW.amount_atomic IS DISTINCT FROM OLD.amount_atomic OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.token_address IS DISTINCT FROM OLD.token_address THEN
    RAISE EXCEPTION 'chain deposit identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('CREDITED','REJECTED','REORGED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'chain deposit % is final (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chain_deposits_guard BEFORE UPDATE ON app.chain_deposits FOR EACH ROW EXECUTE FUNCTION app.chain_deposit_guard();
CREATE TRIGGER chain_deposits_no_delete BEFORE DELETE ON app.chain_deposits FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Indexer checkpoint: only advanced after a scan range is fully processed (CRY-05).
CREATE TABLE app.chain_checkpoints (
  chain_id bigint PRIMARY KEY REFERENCES app.chain_networks(chain_id) ON DELETE RESTRICT,
  last_scanned_block bigint NOT NULL CHECK (last_scanned_block >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Registry rows change only through audited operator commands or the local seed; CHECKs above bound what can be enabled.
GRANT SELECT, INSERT, UPDATE ON app.chain_networks, app.chain_assets TO app_server;
GRANT SELECT, INSERT, UPDATE ON app.wallet_challenges, app.wallets, app.crypto_payment_intents, app.chain_deposits, app.chain_checkpoints TO app_server;
