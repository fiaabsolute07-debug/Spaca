-- W3-R: requests v2 (master §5.3, §9; REQ-01..11). Versioned quotes, hire offers, and request budget/hire-count
-- reservations whose totals the database refuses to oversell.

-- Requests: total ceiling (materialized from cap × target when only a cap is given), optional per-creator cap,
-- application deadline, version and trigger-derived counters.
UPDATE app.requests SET status = 'OPEN' WHERE status = 'SELECTING';
UPDATE app.requests SET status = 'CLOSED' WHERE status = 'EXPIRED';
ALTER TABLE app.requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE app.requests ADD CONSTRAINT requests_status_check CHECK (status IN ('OPEN','FILLED','CLOSED','CANCELLED'));
ALTER TABLE app.requests ALTER COLUMN per_creator_cap_minor DROP NOT NULL;
ALTER TABLE app.requests ADD COLUMN application_deadline timestamptz;
UPDATE app.requests SET application_deadline = deadline;
ALTER TABLE app.requests ALTER COLUMN application_deadline SET NOT NULL;
ALTER TABLE app.requests ADD COLUMN currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD');
ALTER TABLE app.requests ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE app.requests ADD COLUMN reserved_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE app.requests ADD COLUMN committed_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE app.requests ADD COLUMN reserved_hires integer NOT NULL DEFAULT 0;
ALTER TABLE app.requests ADD COLUMN committed_hires integer NOT NULL DEFAULT 0;
ALTER TABLE app.requests ADD COLUMN closed_at timestamptz;
ALTER TABLE app.requests ADD CONSTRAINT requests_counters_nonnegative CHECK (reserved_minor >= 0 AND committed_minor >= 0 AND reserved_hires >= 0 AND committed_hires >= 0);
ALTER TABLE app.requests ADD CONSTRAINT requests_budget_not_oversold CHECK (reserved_minor + committed_minor <= budget_minor);
ALTER TABLE app.requests ADD CONSTRAINT requests_hires_not_oversold CHECK (reserved_hires + committed_hires <= target_hires);
ALTER TABLE app.requests ADD CONSTRAINT requests_cap_within_budget CHECK (per_creator_cap_minor IS NULL OR per_creator_cap_minor <= budget_minor);
ALTER TABLE app.requests ADD CONSTRAINT requests_application_deadline_order CHECK (application_deadline <= deadline);

-- Applications: one logical application per creator/request with an append-only version history.
UPDATE app.applications SET status = 'SUBMITTED' WHERE status IN ('SELECTED','OFFERED');
ALTER TABLE app.applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE app.applications ADD CONSTRAINT applications_status_check CHECK (status IN ('SUBMITTED','OFFERED','ACCEPTED','DECLINED','WITHDRAWN'));
ALTER TABLE app.applications ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE app.applications ADD COLUMN valid_until timestamptz;
UPDATE app.applications SET valid_until = created_at + interval '7 days';
ALTER TABLE app.applications ALTER COLUMN valid_until SET NOT NULL;
ALTER TABLE app.applications ADD COLUMN samples_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app.applications ADD CONSTRAINT applications_id_request_key UNIQUE (id, request_id);

CREATE TABLE app.application_versions (
  application_id uuid NOT NULL REFERENCES app.applications(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  quote_minor bigint NOT NULL CHECK (quote_minor > 0),
  turnaround_hours integer NOT NULL,
  note text NOT NULL,
  valid_until timestamptz NOT NULL,
  samples_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, version)
);
INSERT INTO app.application_versions (application_id, version, quote_minor, turnaround_hours, note, valid_until, samples_snapshot, created_at)
SELECT id, version, quote_minor, turnaround_hours, note, valid_until, samples_snapshot, updated_at FROM app.applications;
CREATE TRIGGER application_versions_append_only BEFORE UPDATE OR DELETE ON app.application_versions FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Hire offers: buyer's selection of one application version, with immutable terms, confirmed by the creator.
CREATE TABLE app.hire_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  application_id uuid NOT NULL,
  application_version integer NOT NULL,
  buyer_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'USD',
  terms_snapshot jsonb NOT NULL,
  capacity_plan_snapshot jsonb,
  status text NOT NULL DEFAULT 'OFFERED' CHECK (status IN ('OFFERED','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN','LAPSED')),
  expires_at timestamptz NOT NULL,
  order_id uuid UNIQUE REFERENCES app.orders(id) ON DELETE RESTRICT,
  response_reason text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, request_id) REFERENCES app.applications (id, request_id) ON DELETE RESTRICT,
  FOREIGN KEY (application_id, application_version) REFERENCES app.application_versions (application_id, version) ON DELETE RESTRICT,
  CONSTRAINT hire_offers_order_state CHECK ((status IN ('ACCEPTED','LAPSED')) = (order_id IS NOT NULL)),
  CONSTRAINT hire_offers_capacity_on_accept CHECK (status NOT IN ('ACCEPTED','LAPSED') OR capacity_plan_snapshot IS NOT NULL),
  CHECK (buyer_id <> creator_id)
);
CREATE UNIQUE INDEX hire_offers_one_active_per_application ON app.hire_offers (application_id) WHERE status IN ('OFFERED','ACCEPTED');
CREATE INDEX hire_offers_expiry_idx ON app.hire_offers (expires_at) WHERE status = 'OFFERED';
CREATE INDEX hire_offers_request_idx ON app.hire_offers (request_id, created_at);

CREATE OR REPLACE FUNCTION app.hire_offer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.application_version IS DISTINCT FROM OLD.application_version OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.terms_snapshot IS DISTINCT FROM OLD.terms_snapshot OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id OR NEW.creator_id IS DISTINCT FROM OLD.creator_id THEN
    RAISE EXCEPTION 'hire offer terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'OFFERED' AND NOT (OLD.status = 'ACCEPTED' AND NEW.status IN ('ACCEPTED','LAPSED')) THEN
    RAISE EXCEPTION 'hire offer % is already %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'hire offer order is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hire_offers_guard BEFORE UPDATE ON app.hire_offers FOR EACH ROW EXECUTE FUNCTION app.hire_offer_guard();
CREATE TRIGGER hire_offers_no_delete BEFORE DELETE ON app.hire_offers FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Budget/count reservations: HELD while offered or awaiting payment, COMMITTED once funded, RELEASED when the
-- offer ends or the hire's payment/refund makes it void. Counters on requests follow via trigger.
CREATE TABLE app.request_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES app.requests(id) ON DELETE RESTRICT,
  offer_id uuid NOT NULL UNIQUE REFERENCES app.hire_offers(id) ON DELETE RESTRICT,
  order_id uuid UNIQUE REFERENCES app.orders(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD','COMMITTED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_budget_reservations_request_idx ON app.request_budget_reservations (request_id, state);

CREATE OR REPLACE FUNCTION app.request_budget_counters() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d_reserved bigint := 0;
  d_committed bigint := 0;
  d_reserved_n integer := 0;
  d_committed_n integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.offer_id IS DISTINCT FROM OLD.offer_id OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
      RAISE EXCEPTION 'budget reservation identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id) OR OLD.state = 'RELEASED' AND NEW.state <> 'RELEASED'
       OR OLD.state = 'COMMITTED' AND NEW.state = 'HELD' THEN
      RAISE EXCEPTION 'budget reservation % cannot move from % to %', OLD.id, OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'HELD' THEN d_reserved := d_reserved - OLD.amount_minor; d_reserved_n := d_reserved_n - 1; END IF;
    IF OLD.state = 'COMMITTED' THEN d_committed := d_committed - OLD.amount_minor; d_committed_n := d_committed_n - 1; END IF;
  END IF;
  IF NEW.state = 'HELD' THEN d_reserved := d_reserved + NEW.amount_minor; d_reserved_n := d_reserved_n + 1; END IF;
  IF NEW.state = 'COMMITTED' THEN d_committed := d_committed + NEW.amount_minor; d_committed_n := d_committed_n + 1; END IF;
  IF d_reserved <> 0 OR d_committed <> 0 OR d_reserved_n <> 0 OR d_committed_n <> 0 THEN
    UPDATE app.requests SET
      reserved_minor = reserved_minor + d_reserved,
      committed_minor = committed_minor + d_committed,
      reserved_hires = reserved_hires + d_reserved_n,
      committed_hires = committed_hires + d_committed_n,
      status = CASE
        WHEN status = 'OPEN' AND committed_hires + d_committed_n >= target_hires THEN 'FILLED'
        WHEN status = 'FILLED' AND committed_hires + d_committed_n < target_hires THEN CASE WHEN deadline > now() THEN 'OPEN' ELSE 'CLOSED' END
        ELSE status END,
      updated_at = now()
    WHERE id = NEW.request_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER request_budget_reservations_counters AFTER INSERT OR UPDATE ON app.request_budget_reservations FOR EACH ROW EXECUTE FUNCTION app.request_budget_counters();
CREATE TRIGGER request_budget_reservations_no_delete BEFORE DELETE ON app.request_budget_reservations FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Order outcomes drive the hire's budget: funding commits; an unpaid cancellation or a full refund releases.
-- Every order path (webhooks, jobs, commands, operators) goes through this one trigger.
CREATE OR REPLACE FUNCTION app.request_order_budget_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source <> 'REQUEST' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'FUNDED' AND OLD.status = 'AWAITING_PAYMENT' THEN
    UPDATE app.request_budget_reservations SET state = 'COMMITTED', updated_at = now() WHERE order_id = NEW.id AND state = 'HELD';
  ELSIF NEW.status = 'CANCELLED' AND OLD.status = 'AWAITING_PAYMENT' THEN
    UPDATE app.request_budget_reservations SET state = 'RELEASED', updated_at = now() WHERE order_id = NEW.id AND state = 'HELD';
    UPDATE app.hire_offers SET status = 'LAPSED', response_reason = coalesce(response_reason, 'Payment was not completed') WHERE order_id = NEW.id AND status = 'ACCEPTED';
    UPDATE app.applications a SET status = 'SUBMITTED', updated_at = now() FROM app.hire_offers o
      WHERE o.order_id = NEW.id AND a.id = o.application_id AND a.status = 'ACCEPTED';
  ELSIF NEW.status = 'REFUNDED' THEN
    UPDATE app.request_budget_reservations SET state = 'RELEASED', updated_at = now() WHERE order_id = NEW.id AND state IN ('HELD','COMMITTED');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_request_budget_sync AFTER UPDATE OF status ON app.orders FOR EACH ROW EXECUTE FUNCTION app.request_order_budget_sync();

GRANT SELECT, INSERT, UPDATE ON app.hire_offers, app.request_budget_reservations TO app_server;
GRANT SELECT, INSERT ON app.application_versions TO app_server;
