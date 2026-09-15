-- PAY-16: provider costs that change or arrive after capture, split by policy `cost-v1` (src/modules/payments/cost-policy.ts).
-- One immutable row per provider fact. The creator's share is capped per order, only possible before their payout, and
-- after the payout a lower cost they already paid is recorded as a credit owed to them, never a debit.

CREATE TABLE app.provider_cost_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  event_id text NOT NULL,
  previous_fee_minor bigint NOT NULL CHECK (previous_fee_minor >= 0),
  actual_fee_minor bigint NOT NULL CHECK (actual_fee_minor >= 0),
  delta_minor bigint NOT NULL,
  creator_share_minor bigint NOT NULL,
  platform_share_minor bigint NOT NULL,
  creator_credit_minor bigint NOT NULL DEFAULT 0 CHECK (creator_credit_minor >= 0),
  phase text NOT NULL CHECK (phase IN ('BEFORE_RELEASE','AFTER_RELEASE','NO_CREATOR_SETTLEMENT')),
  fee_payer text NOT NULL CHECK (fee_payer IN ('CREATOR_AT_COST','PLATFORM_SUBSIDIZED')),
  cap_bps integer NOT NULL CHECK (cap_bps BETWEEN 0 AND 1000),
  cap_minor bigint NOT NULL CHECK (cap_minor >= 0),
  policy_version text NOT NULL DEFAULT 'cost-v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id),
  CHECK (delta_minor = actual_fee_minor - previous_fee_minor),
  CHECK (creator_share_minor + platform_share_minor = delta_minor),
  -- The creator never takes a share after payout, under a subsidized policy, or in the opposite direction of the change.
  CHECK (phase = 'BEFORE_RELEASE' OR creator_share_minor = 0),
  CHECK (fee_payer = 'CREATOR_AT_COST' OR (creator_share_minor = 0 AND creator_credit_minor = 0)),
  CHECK ((delta_minor >= 0 AND creator_share_minor BETWEEN 0 AND delta_minor) OR (delta_minor < 0 AND creator_share_minor BETWEEN delta_minor AND 0)),
  CHECK (creator_credit_minor = 0 OR (phase = 'AFTER_RELEASE' AND delta_minor < 0 AND creator_credit_minor <= -delta_minor))
);
CREATE INDEX provider_cost_adjustments_order_idx ON app.provider_cost_adjustments (order_id, created_at);

-- The creator's cumulative late increases stay within the cap recorded with each adjustment.
CREATE OR REPLACE FUNCTION app.provider_cost_cap_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  borne bigint;
BEGIN
  SELECT coalesce(sum(creator_share_minor) FILTER (WHERE creator_share_minor > 0), 0) INTO borne
    FROM app.provider_cost_adjustments WHERE order_id = NEW.order_id;
  IF NEW.creator_share_minor > 0 AND borne + NEW.creator_share_minor > NEW.cap_minor THEN
    RAISE EXCEPTION 'late cost share % exceeds the creator cap % for order %', borne + NEW.creator_share_minor, NEW.cap_minor, NEW.order_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_cost_adjustments_cap BEFORE INSERT ON app.provider_cost_adjustments FOR EACH ROW EXECUTE FUNCTION app.provider_cost_cap_guard();
CREATE TRIGGER provider_cost_adjustments_immutable BEFORE UPDATE OR DELETE ON app.provider_cost_adjustments FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

GRANT SELECT, INSERT ON app.provider_cost_adjustments TO app_server;
