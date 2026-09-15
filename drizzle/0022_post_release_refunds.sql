-- PAY-15: refunds after the creator was already paid.
-- The charge still holds nothing for the order, so the money must first come back from the creator's transfer (a
-- reversal, which can fail for lack of balance) or be covered by the platform as an explicit, approved loss. Until
-- one of those facts exists the shortfall is an open deficit; nothing is shown as recovered or refunded on intent.

CREATE TABLE app.post_release_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 2000),
  requested_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  -- RECOVERING: reversal requested. DEFICIT: the reversal could not move money. REFUND_PENDING: the full amount is
  -- recovered or covered and the buyer refund is requested. REFUNDED: the provider confirmed the buyer refund.
  status text NOT NULL DEFAULT 'RECOVERING' CHECK (status IN ('RECOVERING','DEFICIT','REFUND_PENDING','REFUNDED')),
  recovered_minor bigint NOT NULL DEFAULT 0 CHECK (recovered_minor >= 0),
  covered_minor bigint NOT NULL DEFAULT 0 CHECK (covered_minor >= 0),
  covered_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  covered_reason text CHECK (covered_reason IS NULL OR char_length(covered_reason) BETWEEN 10 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (recovered_minor + covered_minor <= amount_minor),
  CHECK ((covered_minor > 0) = (covered_by IS NOT NULL AND covered_reason IS NOT NULL)),
  CHECK (status NOT IN ('REFUND_PENDING','REFUNDED') OR recovered_minor + covered_minor = amount_minor),
  CHECK (status IN ('REFUND_PENDING','REFUNDED') OR recovered_minor + covered_minor < amount_minor)
);
CREATE UNIQUE INDEX post_release_refunds_one_active ON app.post_release_refunds (order_id) WHERE status <> 'REFUNDED';

-- Recovered money is a provider fact: it must equal the confirmed reversals recorded for this refund. Terms never
-- change, amounts never go down, and a refund is REFUNDED only with a provider-confirmed buyer refund.
CREATE OR REPLACE FUNCTION app.post_release_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  confirmed bigint;
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'post-release refund terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'REFUNDED' THEN
    RAISE EXCEPTION 'post-release refund % is already refunded', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.recovered_minor < OLD.recovered_minor OR NEW.covered_minor < OLD.covered_minor THEN
    RAISE EXCEPTION 'recovered and covered amounts never decrease' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.covered_minor > 0 AND (NEW.covered_by IS DISTINCT FROM OLD.covered_by OR NEW.covered_reason IS DISTINCT FROM OLD.covered_reason) THEN
    RAISE EXCEPTION 'an approved platform cover cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.recovered_minor <> OLD.recovered_minor THEN
    SELECT coalesce(sum((p.outcome->>'reversedAmount')::bigint), 0) INTO confirmed FROM app.provider_operations p
      WHERE p.kind = 'reversal.create' AND p.order_id = NEW.order_id AND p.outcome->>'refundId' = NEW.id::text AND p.outcome->>'reversalStatus' = 'SUCCEEDED';
    IF NEW.recovered_minor <> confirmed THEN
      RAISE EXCEPTION 'recovered amount % is not backed by confirmed reversals (%)', NEW.recovered_minor, confirmed USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'REFUNDED' AND NOT EXISTS (
    SELECT 1 FROM app.provider_operations p WHERE p.kind = 'refund.create' AND p.order_id = NEW.order_id
      AND p.operation_id = 'refund:after-release:' || NEW.id::text AND p.outcome->>'refundStatus' = 'SUCCEEDED'
  ) THEN
    RAISE EXCEPTION 'post-release refund % has no provider-confirmed buyer refund', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER post_release_refunds_guard BEFORE UPDATE ON app.post_release_refunds FOR EACH ROW EXECUTE FUNCTION app.post_release_refund_guard();
CREATE TRIGGER post_release_refunds_no_delete BEFORE DELETE ON app.post_release_refunds FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

GRANT SELECT, INSERT, UPDATE ON app.post_release_refunds TO app_server;
