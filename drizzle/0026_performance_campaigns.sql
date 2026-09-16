-- Performance campaigns (master §9.6): a fixed fee per post plus a view bonus with a hard cap. Off by default.
--
-- The campaign holds the maximum per hire (base fee + bonus cap) when a creator is hired, and whatever the bonus does
-- not use is refunded to the buyer at settlement, so a project can never be charged more than it saw before hiring.
-- The view cap comes from the creator's own recent median, frozen at hire: buying views afterwards cannot raise it.
-- Views come from a measurement source and are recorded as facts; screenshots are never accepted.

INSERT INTO app.feature_flags (key, enabled, description) VALUES
  ('PERFORMANCE_CAMPAIGNS_ENABLED', false, 'Campaigns that pay a fixed fee plus a capped view bonus (master §9.6)')
ON CONFLICT (key) DO NOTHING;

-- 1. Campaign terms. Performance applies to PUBLISH campaigns, where a post exists to measure.
ALTER TABLE app.requests ADD COLUMN payment_model text NOT NULL DEFAULT 'FIXED' CHECK (payment_model IN ('FIXED','PERFORMANCE'));
ALTER TABLE app.requests ADD COLUMN base_fee_minor bigint CHECK (base_fee_minor IS NULL OR base_fee_minor > 0);
ALTER TABLE app.requests ADD COLUMN rpm_rate_minor bigint CHECK (rpm_rate_minor IS NULL OR rpm_rate_minor > 0);
ALTER TABLE app.requests ADD COLUMN bonus_cap_minor bigint CHECK (bonus_cap_minor IS NULL OR bonus_cap_minor > 0);
ALTER TABLE app.requests ADD COLUMN measure_after_days integer CHECK (measure_after_days IS NULL OR measure_after_days BETWEEN 1 AND 30);
ALTER TABLE app.requests ADD COLUMN verify_days integer CHECK (verify_days IS NULL OR verify_days BETWEEN 1 AND 30);
ALTER TABLE app.requests ADD COLUMN median_multiplier numeric(4,2) CHECK (median_multiplier IS NULL OR (median_multiplier >= 1 AND median_multiplier <= 10));
ALTER TABLE app.requests ADD CONSTRAINT requests_performance_complete CHECK (
  payment_model <> 'PERFORMANCE' OR (taxonomy = 'PUBLISH'
    AND base_fee_minor IS NOT NULL AND rpm_rate_minor IS NOT NULL AND bonus_cap_minor IS NOT NULL
    AND measure_after_days IS NOT NULL AND verify_days IS NOT NULL AND median_multiplier IS NOT NULL)
);

-- 2. The creator's baseline, frozen at the moment they are hired. Evidence, so never edited afterwards.
CREATE TABLE app.performance_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  social_account_id uuid NOT NULL REFERENCES app.social_accounts(id) ON DELETE RESTRICT,
  eligible_posts integer NOT NULL CHECK (eligible_posts >= 0),
  median_views bigint NOT NULL CHECK (median_views >= 0),
  window_days integer NOT NULL CHECK (window_days > 0),
  measured_at_days integer NOT NULL CHECK (measured_at_days > 0),
  source text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX performance_baselines_creator_idx ON app.performance_baselines (creator_id, computed_at DESC);
CREATE TRIGGER performance_baselines_immutable BEFORE UPDATE OR DELETE ON app.performance_baselines
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- 3. One measurement per order: the frozen terms, then the measured facts.
CREATE TABLE app.performance_measurements (
  order_id uuid PRIMARY KEY REFERENCES app.orders(id) ON DELETE RESTRICT,
  baseline_id uuid NOT NULL REFERENCES app.performance_baselines(id) ON DELETE RESTRICT,
  baseline_median bigint NOT NULL CHECK (baseline_median >= 0),
  views_cap bigint NOT NULL CHECK (views_cap >= 0),
  rpm_rate_minor bigint NOT NULL CHECK (rpm_rate_minor > 0),
  bonus_cap_minor bigint NOT NULL CHECK (bonus_cap_minor > 0),
  post_url text NOT NULL,
  published_at timestamptz NOT NULL,
  measure_at timestamptz NOT NULL,
  verify_until timestamptz,
  measured_views bigint CHECK (measured_views IS NULL OR measured_views >= 0),
  views_payable bigint CHECK (views_payable IS NULL OR views_payable >= 0),
  bonus_minor bigint CHECK (bonus_minor IS NULL OR bonus_minor >= 0),
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','MEASURED','HELD','APPROVED','REJECTED')),
  hold_reason text,
  source text NOT NULL,
  measured_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'SCHEDULED') = (measured_views IS NULL)),
  CHECK (views_payable IS NULL OR views_payable <= views_cap),
  CHECK (bonus_minor IS NULL OR bonus_minor <= bonus_cap_minor),
  CHECK ((measured_views IS NULL) = (measured_at IS NULL)),
  CHECK (status <> 'HELD' OR hold_reason IS NOT NULL),
  CHECK (status <> 'REJECTED' OR hold_reason IS NOT NULL)
);
CREATE INDEX performance_measurements_due_idx ON app.performance_measurements (status, measure_at);

-- Terms and measured facts never change; a decided measurement is terminal.
CREATE OR REPLACE FUNCTION app.performance_measurement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.baseline_id IS DISTINCT FROM OLD.baseline_id
     OR NEW.baseline_median IS DISTINCT FROM OLD.baseline_median OR NEW.views_cap IS DISTINCT FROM OLD.views_cap
     OR NEW.rpm_rate_minor IS DISTINCT FROM OLD.rpm_rate_minor OR NEW.bonus_cap_minor IS DISTINCT FROM OLD.bonus_cap_minor
     OR NEW.post_url IS DISTINCT FROM OLD.post_url OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.measure_at IS DISTINCT FROM OLD.measure_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'performance measurement terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.measured_views IS NOT NULL AND (NEW.measured_views IS DISTINCT FROM OLD.measured_views
     OR NEW.views_payable IS DISTINCT FROM OLD.views_payable OR NEW.bonus_minor IS DISTINCT FROM OLD.bonus_minor) THEN
    RAISE EXCEPTION 'a measured view count never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('APPROVED','REJECTED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'performance measurement for order % is already %', OLD.order_id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER performance_measurements_guard BEFORE UPDATE ON app.performance_measurements
  FOR EACH ROW EXECUTE FUNCTION app.performance_measurement_guard();

-- 4. The part of the hold the bonus did not use. Refunded to the buyer when the order settles.
ALTER TABLE app.orders ADD COLUMN performance_refund_minor bigint CHECK (performance_refund_minor IS NULL OR performance_refund_minor >= 0);
ALTER TABLE app.orders ADD CONSTRAINT orders_performance_refund_within_amount
  CHECK (performance_refund_minor IS NULL OR performance_refund_minor < amount_minor);

GRANT SELECT, INSERT, UPDATE ON app.performance_baselines, app.performance_measurements TO app_server;
