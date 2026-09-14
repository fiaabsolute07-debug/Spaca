-- W9-ARC: SpacaEscrow settlement (master §11.3, §11.7 model A) and a payout outbox so no chain call runs inside a
-- database transaction (§6.4). Deposits name the escrow bucket they fund; payouts are queued in the same transaction as
-- the business change, then signed and submitted by the dispatch_chain_payouts worker and applied when confirmed.

ALTER TABLE app.chain_networks ADD COLUMN contract_kind text NOT NULL DEFAULT 'SPACA_ESCROW_V1' CHECK (contract_kind IN ('SPACA_ESCROW_V1'));

ALTER TABLE app.chain_deposits ADD COLUMN escrow_ref text CHECK (escrow_ref IS NULL OR escrow_ref ~ '^0x[0-9a-f]{64}$');
ALTER TABLE app.crypto_payment_intents ADD COLUMN escrow_ref text CHECK (escrow_ref IS NULL OR escrow_ref ~ '^0x[0-9a-f]{64}$');
ALTER TABLE app.pool_funding_intents ADD COLUMN escrow_ref text CHECK (escrow_ref IS NULL OR escrow_ref ~ '^0x[0-9a-f]{64}$');
UPDATE app.crypto_payment_intents SET escrow_ref = '0x' || encode(sha256(convert_to('spaca:escrow:order:' || order_id::text, 'UTF8')), 'hex') WHERE escrow_ref IS NULL;
-- One bucket per pool asset: the escrow holds a single token per bucket.
UPDATE app.pool_funding_intents SET escrow_ref = '0x' || encode(sha256(convert_to('spaca:escrow:pool:' || pool_id::text || ':' || pool_asset_id::text, 'UTF8')), 'hex') WHERE escrow_ref IS NULL;
ALTER TABLE app.crypto_payment_intents ALTER COLUMN escrow_ref SET NOT NULL;
ALTER TABLE app.pool_funding_intents ALTER COLUMN escrow_ref SET NOT NULL;

CREATE TABLE app.chain_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('ALLOCATION','POOL_REFUND','ORDER_RELEASE','ORDER_REFUND','FREEZE','UNFREEZE')),
  subject_id uuid NOT NULL,
  order_id uuid REFERENCES app.orders(id) ON DELETE RESTRICT,
  chain_id bigint NOT NULL REFERENCES app.chain_networks(chain_id) ON DELETE RESTRICT,
  escrow_ref text NOT NULL CHECK (escrow_ref ~ '^0x[0-9a-f]{64}$'),
  payout_ref text NOT NULL UNIQUE CHECK (payout_ref ~ '^0x[0-9a-f]{64}$'),
  recipient text CHECK (recipient IS NULL OR recipient ~ '^0x[0-9a-f]{40}$'),
  token text CHECK (token IS NULL OR token ~ '^0x[0-9a-f]{40}$'),
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic >= 0),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','SUBMITTING','UNKNOWN','RETRY','CONFIRMED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chain_payouts_freeze_has_no_amount CHECK ((kind IN ('FREEZE','UNFREEZE')) = (amount_atomic = 0)),
  CONSTRAINT chain_payouts_release_has_recipient CHECK (kind NOT IN ('ALLOCATION','ORDER_RELEASE') OR (recipient IS NOT NULL AND token IS NOT NULL)),
  CONSTRAINT chain_payouts_confirmed_fields CHECK ((state = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);
CREATE INDEX chain_payouts_due_idx ON app.chain_payouts (next_attempt_at, created_at) WHERE state IN ('QUEUED','SUBMITTING','UNKNOWN','RETRY');
CREATE INDEX chain_payouts_subject_idx ON app.chain_payouts (kind, subject_id);
CREATE INDEX chain_payouts_order_idx ON app.chain_payouts (order_id) WHERE order_id IS NOT NULL;

-- What was queued never changes; CONFIRMED and FAILED are final.
CREATE OR REPLACE FUNCTION app.chain_payout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
     OR NEW.escrow_ref IS DISTINCT FROM OLD.escrow_ref OR NEW.payout_ref IS DISTINCT FROM OLD.payout_ref OR NEW.recipient IS DISTINCT FROM OLD.recipient
     OR NEW.token IS DISTINCT FROM OLD.token OR NEW.amount_atomic IS DISTINCT FROM OLD.amount_atomic THEN
    RAISE EXCEPTION 'chain payout terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('CONFIRMED','FAILED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'chain payout % is final (%)', OLD.id, OLD.state USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER chain_payouts_guard BEFORE UPDATE ON app.chain_payouts FOR EACH ROW EXECUTE FUNCTION app.chain_payout_guard();
CREATE TRIGGER chain_payouts_no_delete BEFORE DELETE ON app.chain_payouts FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Authorizations now cover refunds (recipient fixed by the contract) and dispute freezes (no amount).
ALTER TABLE app.release_authorizations DROP CONSTRAINT IF EXISTS release_authorizations_payout_kind_check;
ALTER TABLE app.release_authorizations ADD CONSTRAINT release_authorizations_payout_kind_check CHECK (payout_kind IN ('ALLOCATION','POOL_REFUND','ORDER_RELEASE','ORDER_REFUND','FREEZE','UNFREEZE'));
ALTER TABLE app.release_authorizations DROP CONSTRAINT IF EXISTS release_authorizations_amount_atomic_check;
ALTER TABLE app.release_authorizations ADD CONSTRAINT release_authorizations_amount_atomic_check CHECK (amount_atomic >= 0);
ALTER TABLE app.release_authorizations ALTER COLUMN recipient DROP NOT NULL;
ALTER TABLE app.release_authorizations ALTER COLUMN token DROP NOT NULL;
ALTER TABLE app.release_authorizations ADD COLUMN chain_payout_id uuid REFERENCES app.chain_payouts(id) ON DELETE RESTRICT;
ALTER TABLE app.release_authorizations DROP CONSTRAINT IF EXISTS release_authorizations_outcome_check;
ALTER TABLE app.release_authorizations ADD CONSTRAINT release_authorizations_outcome_check CHECK (outcome IN ('TRANSFERRED','FAILED','UNKNOWN'));

GRANT SELECT, INSERT, UPDATE ON app.chain_payouts TO app_server;
