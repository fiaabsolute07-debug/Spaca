-- W1-A supply engine v2 (master §5.2, §6): service versions + order snapshots, weekly capacity buckets
-- in the creator's timezone, shared pools, DB-maintained counters, reservation state guard.
-- Additive/upgrade-safe: existing reservations are moved into a backfill bucket before pool counters are dropped.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Identity -------------------------------------------------------------------------------------------
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE app.users ADD CONSTRAINT users_timezone_length CHECK (char_length(timezone) BETWEEN 1 AND 64);

-- Pools: identity + policy only; counters live on buckets ---------------------------------------------
ALTER TABLE app.capacity_pools ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Weekly capacity';
ALTER TABLE app.capacity_pools ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE app.capacity_pools ADD COLUMN IF NOT EXISTS weekly_units integer;
ALTER TABLE app.capacity_pools ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE app.capacity_pools ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE app.capacity_pools SET weekly_units = total_units WHERE weekly_units IS NULL;
ALTER TABLE app.capacity_pools ALTER COLUMN weekly_units SET NOT NULL;
ALTER TABLE app.capacity_pools ADD CONSTRAINT capacity_pools_weekly_units_range CHECK (weekly_units BETWEEN 0 AND 100000);
ALTER TABLE app.capacity_pools ADD CONSTRAINT capacity_pools_name_length CHECK (char_length(name) BETWEEN 1 AND 80);
ALTER TABLE app.capacity_pools ADD CONSTRAINT capacity_pools_timezone_length CHECK (char_length(timezone) BETWEEN 1 AND 64);
ALTER TABLE app.capacity_pools ADD CONSTRAINT capacity_pools_version_positive CHECK (version > 0);
ALTER TABLE app.capacity_pools ADD CONSTRAINT capacity_pools_id_creator_key UNIQUE (id, creator_id);

CREATE TABLE app.capacity_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES app.capacity_pools(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  local_week_start date NOT NULL,
  timezone text NOT NULL,
  total_units integer NOT NULL CHECK (total_units >= 0),
  reserved_units integer NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  committed_units integer NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capacity_buckets_interval CHECK (ends_at > starts_at),
  CONSTRAINT capacity_buckets_no_oversell CHECK (reserved_units + committed_units <= total_units),
  CONSTRAINT capacity_buckets_pool_start_key UNIQUE (pool_id, starts_at),
  CONSTRAINT capacity_buckets_id_pool_key UNIQUE (id, pool_id),
  CONSTRAINT capacity_buckets_no_overlap EXCLUDE USING gist (pool_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
);
CREATE INDEX capacity_buckets_pool_window_idx ON app.capacity_buckets (pool_id, ends_at);

-- Backfill: one UTC bucket for the current week per pool, large enough for every existing claim.
INSERT INTO app.capacity_buckets (pool_id, starts_at, ends_at, local_week_start, timezone, total_units)
SELECT p.id,
       date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
       (date_trunc('week', now() AT TIME ZONE 'UTC') + interval '7 days') AT TIME ZONE 'UTC',
       date_trunc('week', now() AT TIME ZONE 'UTC')::date,
       'UTC',
       greatest(p.weekly_units, (SELECT count(*) FROM app.reservations r WHERE r.pool_id = p.id AND r.state IN ('HELD','RECONCILING','COMMITTED','CONSUMED')))
FROM app.capacity_pools p;

ALTER TABLE app.reservations ADD COLUMN IF NOT EXISTS bucket_id uuid;
ALTER TABLE app.reservations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE app.reservations r SET bucket_id = b.id FROM app.capacity_buckets b WHERE b.pool_id = r.pool_id AND r.bucket_id IS NULL;
ALTER TABLE app.reservations ALTER COLUMN bucket_id SET NOT NULL;
ALTER TABLE app.reservations ADD CONSTRAINT reservations_bucket_pool_fk FOREIGN KEY (bucket_id, pool_id) REFERENCES app.capacity_buckets (id, pool_id) ON DELETE RESTRICT;
CREATE INDEX reservations_bucket_state_idx ON app.reservations (bucket_id, state);

UPDATE app.capacity_buckets b SET
  reserved_units = (SELECT coalesce(sum(units), 0) FROM app.reservations r WHERE r.bucket_id = b.id AND r.state IN ('HELD','RECONCILING')),
  committed_units = (SELECT coalesce(sum(units), 0) FROM app.reservations r WHERE r.bucket_id = b.id AND r.state IN ('COMMITTED','CONSUMED'));

-- Pool-level counters were a second source of truth; drop them (constraints on them drop too).
ALTER TABLE app.capacity_pools DROP COLUMN total_units, DROP COLUMN reserved_units, DROP COLUMN committed_units, DROP COLUMN starts_at, DROP COLUMN ends_at;

-- Reservation state machine guard (§6.2): HELD → RECONCILING|COMMITTED|RELEASED, RECONCILING → HELD|COMMITTED|RELEASED,
-- COMMITTED → CONSUMED|RELEASED; CONSUMED and RELEASED are terminal (CAP-06/CAP-12). Bucket, pool and units are immutable.
CREATE OR REPLACE FUNCTION app.reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state IN ('HELD','RECONCILING','COMMITTED','CONSUMED') THEN
      RAISE EXCEPTION 'reservation % in state % cannot be deleted', OLD.id, OLD.state USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.bucket_id IS DISTINCT FROM OLD.bucket_id OR NEW.pool_id IS DISTINCT FROM OLD.pool_id OR NEW.units IS DISTINCT FROM OLD.units THEN
    RAISE EXCEPTION 'reservation bucket, pool and units are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'HELD' AND NEW.state IN ('RECONCILING','COMMITTED','RELEASED'))
    OR (OLD.state = 'RECONCILING' AND NEW.state IN ('HELD','COMMITTED','RELEASED'))
    OR (OLD.state = 'COMMITTED' AND NEW.state IN ('CONSUMED','RELEASED'))
  ) THEN
    RAISE EXCEPTION 'invalid reservation transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER reservations_guard BEFORE UPDATE OR DELETE ON app.reservations FOR EACH ROW EXECUTE FUNCTION app.reservation_guard();

-- Counters are derived from reservation state in the same transaction; the bucket CHECK makes oversell impossible
-- even if application locking were wrong. reserved = HELD+RECONCILING, committed = COMMITTED+CONSUMED.
CREATE OR REPLACE FUNCTION app.reservation_counters() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta_reserved integer := 0;
  delta_committed integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state = OLD.state THEN RETURN NULL; END IF;
    delta_reserved := delta_reserved - CASE WHEN OLD.state IN ('HELD','RECONCILING') THEN OLD.units ELSE 0 END;
    delta_committed := delta_committed - CASE WHEN OLD.state IN ('COMMITTED','CONSUMED') THEN OLD.units ELSE 0 END;
  END IF;
  delta_reserved := delta_reserved + CASE WHEN NEW.state IN ('HELD','RECONCILING') THEN NEW.units ELSE 0 END;
  delta_committed := delta_committed + CASE WHEN NEW.state IN ('COMMITTED','CONSUMED') THEN NEW.units ELSE 0 END;
  IF delta_reserved <> 0 OR delta_committed <> 0 THEN
    UPDATE app.capacity_buckets
       SET reserved_units = reserved_units + delta_reserved,
           committed_units = committed_units + delta_committed,
           updated_at = now()
     WHERE id = NEW.bucket_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER reservations_counters AFTER INSERT OR UPDATE ON app.reservations FOR EACH ROW EXECUTE FUNCTION app.reservation_counters();

-- Immutable rows helper ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;

-- Service versions (live terms immutable; SUP-03) ------------------------------------------------------
CREATE TABLE app.service_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES app.services(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  description text NOT NULL CHECK (char_length(description) BETWEEN 20 AND 10000),
  taxonomy text NOT NULL CHECK (taxonomy IN ('CREATE','PUBLISH','ACCESS','DIGITAL')),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  currency text NOT NULL CHECK (currency IN ('USD','EUR','GBP','JPY','VND')),
  turnaround_hours integer NOT NULL CHECK (turnaround_hours BETWEEN 1 AND 8760),
  revision_limit integer NOT NULL CHECK (revision_limit BETWEEN 0 AND 3),
  review_window_hours integer NOT NULL DEFAULT 72 CHECK (review_window_hours BETWEEN 24 AND 336),
  platform_fee_bps integer NOT NULL DEFAULT 0 CHECK (platform_fee_bps = 0),
  pool_id uuid NOT NULL REFERENCES app.capacity_pools(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_versions_service_version_key UNIQUE (service_id, version),
  CONSTRAINT service_versions_id_service_key UNIQUE (id, service_id)
);
CREATE TRIGGER service_versions_immutable BEFORE UPDATE OR DELETE ON app.service_versions FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

ALTER TABLE app.services ADD COLUMN IF NOT EXISTS published_version_id uuid;
ALTER TABLE app.services ADD CONSTRAINT services_id_creator_key UNIQUE (id, creator_id);
ALTER TABLE app.services ADD CONSTRAINT services_pool_owner_fk FOREIGN KEY (pool_id, creator_id) REFERENCES app.capacity_pools (id, creator_id);
ALTER TABLE app.services DROP CONSTRAINT IF EXISTS services_status_check;
ALTER TABLE app.services ADD CONSTRAINT services_status_check CHECK (status IN ('DRAFT','PUBLISHED','PAUSED','ARCHIVED'));
ALTER TABLE app.services DROP CONSTRAINT IF EXISTS services_revision_limit_check;
ALTER TABLE app.services ADD CONSTRAINT services_revision_limit_check CHECK (revision_limit BETWEEN 0 AND 3);

INSERT INTO app.service_versions (service_id, version, title, description, taxonomy, price_minor, currency, turnaround_hours, revision_limit, pool_id, created_by)
SELECT s.id, 1, s.title, s.description, s.taxonomy, s.price_minor, s.currency, s.turnaround_hours, s.revision_limit, s.pool_id, s.creator_id
FROM app.services s;
UPDATE app.services s SET published_version_id = v.id
FROM app.service_versions v WHERE v.service_id = s.id AND v.version = 1 AND s.status <> 'DRAFT';
ALTER TABLE app.services ADD CONSTRAINT services_published_version_fk FOREIGN KEY (published_version_id, id) REFERENCES app.service_versions (id, service_id);
ALTER TABLE app.services ADD CONSTRAINT services_listed_requires_version CHECK (status = 'DRAFT' OR published_version_id IS NOT NULL);

-- Samples linked to services with owner consistency (SUP-01) --------------------------------------------
ALTER TABLE app.samples ADD CONSTRAINT samples_id_creator_key UNIQUE (id, creator_id);
CREATE TABLE app.service_samples (
  service_id uuid NOT NULL,
  sample_id uuid NOT NULL,
  creator_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, sample_id),
  FOREIGN KEY (service_id, creator_id) REFERENCES app.services (id, creator_id) ON DELETE CASCADE,
  FOREIGN KEY (sample_id, creator_id) REFERENCES app.samples (id, creator_id) ON DELETE CASCADE
);
INSERT INTO app.service_samples (service_id, sample_id, creator_id)
SELECT s.id, sm.id, s.creator_id FROM app.services s JOIN app.samples sm ON sm.creator_id = s.creator_id
ON CONFLICT DO NOTHING;

-- Orders and auctions reference the exact version they sold ---------------------------------------------
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS service_version_id uuid REFERENCES app.service_versions(id) ON DELETE RESTRICT;
UPDATE app.orders o SET service_version_id = v.id FROM app.service_versions v
WHERE o.service_id IS NOT NULL AND v.service_id = o.service_id AND v.version = 1 AND o.service_version_id IS NULL;
CREATE INDEX IF NOT EXISTS orders_service_version_idx ON app.orders (service_version_id);

ALTER TABLE app.auctions ADD COLUMN IF NOT EXISTS service_version_id uuid REFERENCES app.service_versions(id) ON DELETE RESTRICT;
UPDATE app.auctions a SET service_version_id = s.published_version_id FROM app.services s WHERE s.id = a.service_id AND a.service_version_id IS NULL;

-- Sold terms are immutable once the order exists (SUP-03, §5.1 snapshots).
CREATE OR REPLACE FUNCTION app.order_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.service_version_id IS DISTINCT FROM OLD.service_version_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.platform_fee_minor IS DISTINCT FROM OLD.platform_fee_minor
     OR NEW.terms IS DISTINCT FROM OLD.terms THEN
    RAISE EXCEPTION 'order % sold terms are immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_snapshot_guard BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.order_snapshot_guard();

GRANT SELECT, INSERT, UPDATE, DELETE ON app.capacity_buckets, app.service_versions, app.service_samples TO app_server;
