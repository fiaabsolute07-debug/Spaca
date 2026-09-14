-- Capacity becomes a per-creator active-order limit (master §5.2, §6; decision of 2026-09-14, plan B).
-- Replaces weekly buckets and capacity pools: every service of a creator shares one CreatorWorkload, and a
-- WorkloadClaim holds units while checkout/auction/hire is pending (HELD), counts while work is underway
-- (ACTIVE), and frees the units when the order is approved/completed (DONE) or cancelled/refunded (RELEASED).
-- Upgrade-safe: existing reservations are mapped by their order's status and counters are recomputed.

-- 1. Workload per creator -------------------------------------------------------------------------------
CREATE TABLE app.creator_workloads (
  creator_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE RESTRICT,
  max_active_units integer NOT NULL DEFAULT 3 CHECK (max_active_units BETWEEN 1 AND 100),
  accepting_orders boolean NOT NULL DEFAULT true,
  held_units integer NOT NULL DEFAULT 0 CHECK (held_units >= 0),
  active_units integer NOT NULL DEFAULT 0 CHECK (active_units >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The old weekly figure is the closest stated intent; clamp it into the new range.
INSERT INTO app.creator_workloads (creator_id, max_active_units)
SELECT creator_id, least(greatest(max(weekly_units), 1), 100) FROM app.capacity_pools GROUP BY creator_id;

-- 2. Reservations become workload claims -------------------------------------------------------------
DROP TRIGGER IF EXISTS reservations_guard ON app.reservations;
DROP TRIGGER IF EXISTS reservations_counters ON app.reservations;
DROP FUNCTION IF EXISTS app.reservation_guard();
DROP FUNCTION IF EXISTS app.reservation_counters();

ALTER TABLE app.reservations RENAME TO workload_claims;
ALTER TABLE app.workload_claims RENAME CONSTRAINT reservations_order_id_key TO workload_claims_order_id_key;
ALTER TABLE app.workload_claims RENAME CONSTRAINT reservations_auction_id_key TO workload_claims_auction_id_key;
ALTER TABLE app.workload_claims DROP CONSTRAINT IF EXISTS reservations_state_check;
ALTER TABLE app.workload_claims DROP CONSTRAINT IF EXISTS reservations_units_check;

ALTER TABLE app.workload_claims ADD COLUMN creator_id uuid;
ALTER TABLE app.workload_claims ADD COLUMN origin text;
UPDATE app.workload_claims c SET creator_id = p.creator_id FROM app.capacity_pools p WHERE p.id = c.pool_id;
UPDATE app.workload_claims c SET origin = CASE
    WHEN c.auction_id IS NOT NULL THEN 'AUCTION'
    WHEN o.source = 'REQUEST' THEN 'OFFER'
    WHEN o.source = 'AUCTION' THEN 'AUCTION'
    ELSE 'BOOK' END
  FROM app.workload_claims c2 LEFT JOIN app.orders o ON o.id = c2.order_id
  WHERE c2.id = c.id;

-- Committed work frees its units once the order leaves the in-progress states; held claims keep their meaning.
UPDATE app.workload_claims c SET state = CASE
    WHEN c.state = 'RECONCILING' THEN 'EXPIRY_RECONCILING'
    WHEN c.state IN ('COMMITTED','CONSUMED') AND o.status IN ('APPROVED','COMPLETED') THEN 'DONE'
    WHEN c.state IN ('COMMITTED','CONSUMED') AND o.status IN ('CANCELLED','REFUNDED') THEN 'RELEASED'
    WHEN c.state IN ('COMMITTED','CONSUMED') THEN 'ACTIVE'
    ELSE c.state END
  FROM app.workload_claims c2 LEFT JOIN app.orders o ON o.id = c2.order_id
  WHERE c2.id = c.id;

ALTER TABLE app.workload_claims DROP COLUMN bucket_id;
ALTER TABLE app.workload_claims DROP COLUMN pool_id;
ALTER TABLE app.workload_claims ALTER COLUMN creator_id SET NOT NULL;
ALTER TABLE app.workload_claims ALTER COLUMN origin SET NOT NULL;
ALTER TABLE app.workload_claims ADD CONSTRAINT workload_claims_creator_fk FOREIGN KEY (creator_id) REFERENCES app.users(id) ON DELETE RESTRICT;
ALTER TABLE app.workload_claims ADD CONSTRAINT workload_claims_state_check CHECK (state IN ('HELD','EXPIRY_RECONCILING','ACTIVE','DONE','RELEASED'));
ALTER TABLE app.workload_claims ADD CONSTRAINT workload_claims_origin_check CHECK (origin IN ('BOOK','OFFER','AUCTION'));
ALTER TABLE app.workload_claims ADD CONSTRAINT workload_claims_units_check CHECK (units BETWEEN 1 AND 10);
CREATE INDEX workload_claims_creator_state_idx ON app.workload_claims (creator_id, state);
CREATE INDEX workload_claims_open_expiry_idx ON app.workload_claims (expires_at) WHERE state IN ('HELD','EXPIRY_RECONCILING');

-- Creators that only appear through claims still get a workload row before counters are computed.
INSERT INTO app.creator_workloads (creator_id)
SELECT DISTINCT creator_id FROM app.workload_claims ON CONFLICT (creator_id) DO NOTHING;
UPDATE app.creator_workloads w SET
  held_units = (SELECT coalesce(sum(units), 0) FROM app.workload_claims c WHERE c.creator_id = w.creator_id AND c.state IN ('HELD','EXPIRY_RECONCILING')),
  active_units = (SELECT coalesce(sum(units), 0) FROM app.workload_claims c WHERE c.creator_id = w.creator_id AND c.state = 'ACTIVE');

-- 3. Claim state machine (§6.2): new claims start HELD; DONE and RELEASED are terminal; owner and units are fixed.
CREATE OR REPLACE FUNCTION app.workload_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'HELD' THEN
      RAISE EXCEPTION 'a workload claim must start HELD' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.state IN ('HELD','EXPIRY_RECONCILING','ACTIVE','DONE') THEN
      RAISE EXCEPTION 'workload claim % in state % cannot be deleted', OLD.id, OLD.state USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.creator_id IS DISTINCT FROM OLD.creator_id OR NEW.units IS DISTINCT FROM OLD.units OR NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'workload claim creator, units and origin are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'HELD' AND NEW.state IN ('EXPIRY_RECONCILING','ACTIVE','RELEASED'))
    OR (OLD.state = 'EXPIRY_RECONCILING' AND NEW.state IN ('HELD','ACTIVE','RELEASED'))
    OR (OLD.state = 'ACTIVE' AND NEW.state IN ('DONE','RELEASED'))
  ) THEN
    RAISE EXCEPTION 'invalid workload claim transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER workload_claims_guard BEFORE INSERT OR UPDATE OR DELETE ON app.workload_claims FOR EACH ROW EXECUTE FUNCTION app.workload_claim_guard();

-- 4. Counters follow claim state in the same transaction. A new claim is refused when the creator paused new
-- orders or the claim would exceed the limit; the UPDATE takes the workload row lock, so concurrent claims are
-- serialized and see each other's units even if application locking were wrong. Existing claims never fail
-- here: lowering the limit or a revision may leave the total above it (§6.1 rules 6 and 9).
CREATE OR REPLACE FUNCTION app.workload_claim_counters() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta_held integer := 0;
  delta_active integer := 0;
  workload app.creator_workloads%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state = OLD.state THEN RETURN NULL; END IF;
    delta_held := delta_held - CASE WHEN OLD.state IN ('HELD','EXPIRY_RECONCILING') THEN OLD.units ELSE 0 END;
    delta_active := delta_active - CASE WHEN OLD.state = 'ACTIVE' THEN OLD.units ELSE 0 END;
  ELSE
    INSERT INTO app.creator_workloads (creator_id) VALUES (NEW.creator_id) ON CONFLICT (creator_id) DO NOTHING;
  END IF;
  delta_held := delta_held + CASE WHEN NEW.state IN ('HELD','EXPIRY_RECONCILING') THEN NEW.units ELSE 0 END;
  delta_active := delta_active + CASE WHEN NEW.state = 'ACTIVE' THEN NEW.units ELSE 0 END;
  IF delta_held = 0 AND delta_active = 0 THEN RETURN NULL; END IF;
  UPDATE app.creator_workloads
     SET held_units = held_units + delta_held, active_units = active_units + delta_active, updated_at = now()
   WHERE creator_id = NEW.creator_id
   RETURNING * INTO workload;
  IF TG_OP = 'INSERT' THEN
    IF NOT workload.accepting_orders THEN
      RAISE EXCEPTION 'creator % is not accepting new orders', NEW.creator_id USING ERRCODE = 'check_violation', HINT = 'NOT_ACCEPTING_ORDERS';
    END IF;
    IF workload.held_units + workload.active_units > workload.max_active_units THEN
      RAISE EXCEPTION 'creator % is at the active order limit', NEW.creator_id USING ERRCODE = 'check_violation', HINT = 'CAPACITY_UNAVAILABLE';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER workload_claims_counters AFTER INSERT OR UPDATE ON app.workload_claims FOR EACH ROW EXECUTE FUNCTION app.workload_claim_counters();

-- 5. Orders free their units exactly once when they leave the in-progress states (§6.1 rules 3 and 8; CAP-06/12).
-- Held claims are only released by cancellation, which every caller performs after the payment is terminal.
CREATE OR REPLACE FUNCTION app.order_workload_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  IF NEW.status IN ('APPROVED','COMPLETED') THEN
    UPDATE app.workload_claims SET state = 'DONE' WHERE order_id = NEW.id AND state = 'ACTIVE';
  ELSIF NEW.status IN ('CANCELLED','REFUNDED') THEN
    UPDATE app.workload_claims SET state = 'RELEASED' WHERE order_id = NEW.id AND state IN ('HELD','EXPIRY_RECONCILING','ACTIVE');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER orders_workload_release AFTER UPDATE OF status ON app.orders FOR EACH ROW EXECUTE FUNCTION app.order_workload_release();

-- 6. Services size each order in units; pools and weekly buckets go away -----------------------------------
ALTER TABLE app.services ADD COLUMN units_per_order integer NOT NULL DEFAULT 1 CHECK (units_per_order BETWEEN 1 AND 10);
ALTER TABLE app.service_versions ADD COLUMN units_per_order integer NOT NULL DEFAULT 1 CHECK (units_per_order BETWEEN 1 AND 10);

ALTER TABLE app.services DROP COLUMN pool_id;
ALTER TABLE app.service_versions DROP COLUMN pool_id;
ALTER TABLE app.orders DROP COLUMN pool_id;
DROP TABLE app.capacity_buckets;
DROP TABLE app.capacity_pools;

-- 7. Reconciliation (§6.2, runbook §20.4): counters that differ from the sum of claims.
CREATE VIEW app.workload_counter_drift AS
SELECT w.creator_id, w.held_units, w.active_units,
       coalesce(sum(c.units) FILTER (WHERE c.state IN ('HELD','EXPIRY_RECONCILING')), 0)::int AS claimed_held_units,
       coalesce(sum(c.units) FILTER (WHERE c.state = 'ACTIVE'), 0)::int AS claimed_active_units
FROM app.creator_workloads w
LEFT JOIN app.workload_claims c ON c.creator_id = w.creator_id
GROUP BY w.creator_id, w.held_units, w.active_units
HAVING w.held_units <> coalesce(sum(c.units) FILTER (WHERE c.state IN ('HELD','EXPIRY_RECONCILING')), 0)
    OR w.active_units <> coalesce(sum(c.units) FILTER (WHERE c.state = 'ACTIVE'), 0);

GRANT SELECT, INSERT, UPDATE ON app.creator_workloads TO app_server;
GRANT SELECT ON app.workload_counter_drift TO app_server;
