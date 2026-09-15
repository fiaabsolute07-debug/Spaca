-- P6 DIGITAL products (master §16.9 P6-05/06; XPL-04, XPL-05, XPL-06). A DIGITAL listing sells a license to private,
-- versioned files. Purchases create entitlements instead of workload claims; an exclusive license can be held by one
-- buyer at a time, enforced by the database whatever the application does. Behind DIGITAL_PRODUCTS_ENABLED (off).

-- Storage: creator-owned product files in their own private bucket, never tied to one order.
ALTER TABLE app.upload_intents DROP CONSTRAINT upload_intents_purpose_check;
ALTER TABLE app.upload_intents ADD CONSTRAINT upload_intents_purpose_check CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE','DIGITAL'));
ALTER TABLE app.upload_intents DROP CONSTRAINT upload_intents_bucket_check;
ALTER TABLE app.upload_intents ADD CONSTRAINT upload_intents_bucket_check CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes','private-products'));
ALTER TABLE app.storage_assets DROP CONSTRAINT storage_assets_purpose_check;
ALTER TABLE app.storage_assets ADD CONSTRAINT storage_assets_purpose_check CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE','DIGITAL'));
ALTER TABLE app.storage_assets DROP CONSTRAINT storage_assets_bucket_check;
ALTER TABLE app.storage_assets ADD CONSTRAINT storage_assets_bucket_check CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes','private-products','private-quarantine'));

-- License terms on the listing and its immutable versions.
ALTER TABLE app.services ADD COLUMN digital_license text CHECK (digital_license IS NULL OR digital_license IN ('NON_EXCLUSIVE','EXCLUSIVE'));
ALTER TABLE app.services ADD COLUMN digital_rights_text text CHECK (digital_rights_text IS NULL OR char_length(digital_rights_text) BETWEEN 20 AND 4000);
ALTER TABLE app.services ADD COLUMN digital_stock integer CHECK (digital_stock IS NULL OR digital_stock BETWEEN 1 AND 100000);
ALTER TABLE app.services ADD COLUMN digital_updates text CHECK (digital_updates IS NULL OR digital_updates IN ('LATEST','PURCHASED_VERSION'));
ALTER TABLE app.services ADD COLUMN digital_download_limit integer CHECK (digital_download_limit IS NULL OR digital_download_limit BETWEEN 1 AND 1000);
ALTER TABLE app.services ADD CONSTRAINT services_digital_exclusive_stock CHECK (digital_license IS DISTINCT FROM 'EXCLUSIVE' OR digital_stock = 1);
UPDATE app.services SET status = 'DRAFT', version = version + 1, updated_at = now() WHERE taxonomy = 'DIGITAL' AND status IN ('PUBLISHED','PAUSED');
ALTER TABLE app.services ADD CONSTRAINT services_digital_terms_complete CHECK (
  taxonomy <> 'DIGITAL' OR status IN ('DRAFT','ARCHIVED')
  OR (digital_license IS NOT NULL AND digital_rights_text IS NOT NULL AND digital_updates IS NOT NULL AND digital_download_limit IS NOT NULL)
);

ALTER TABLE app.service_versions ADD COLUMN digital_license text;
ALTER TABLE app.service_versions ADD COLUMN digital_rights_text text;
ALTER TABLE app.service_versions ADD COLUMN digital_stock integer;
ALTER TABLE app.service_versions ADD COLUMN digital_updates text;
ALTER TABLE app.service_versions ADD COLUMN digital_download_limit integer;
ALTER TABLE app.service_versions ADD CONSTRAINT service_versions_digital_terms_complete CHECK (
  taxonomy <> 'DIGITAL' OR (digital_license IS NOT NULL AND digital_rights_text IS NOT NULL AND digital_updates IS NOT NULL AND digital_download_limit IS NOT NULL)
) NOT VALID;

-- Releases: each version of the product file. Append-only; the asset must be the creator's own DIGITAL upload.
CREATE TABLE app.digital_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL,
  creator_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  asset_id uuid NOT NULL UNIQUE,
  asset_purpose text NOT NULL DEFAULT 'DIGITAL' CHECK (asset_purpose = 'DIGITAL'),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, version),
  FOREIGN KEY (service_id, creator_id) REFERENCES app.services (id, creator_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, creator_id, asset_purpose) REFERENCES app.storage_assets (id, owner_id, purpose) ON DELETE RESTRICT
);
CREATE TRIGGER digital_releases_append_only BEFORE UPDATE OR DELETE ON app.digital_releases FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Entitlements: one per DIGITAL order. HELD during checkout, ACTIVE once funded, RELEASED if the checkout ends unpaid,
-- REVOKED after a cancellation or refund.
CREATE TABLE app.digital_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES app.orders(id) ON DELETE RESTRICT,
  service_id uuid NOT NULL REFERENCES app.services(id) ON DELETE RESTRICT,
  service_version_id uuid NOT NULL REFERENCES app.service_versions(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  license text NOT NULL CHECK (license IN ('NON_EXCLUSIVE','EXCLUSIVE')),
  release_version integer NOT NULL CHECK (release_version >= 1),
  updates_policy text NOT NULL CHECK (updates_policy IN ('LATEST','PURCHASED_VERSION')),
  download_limit integer NOT NULL CHECK (download_limit BETWEEN 1 AND 1000),
  download_count integer NOT NULL DEFAULT 0,
  first_downloaded_at timestamptz,
  state text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD','EXPIRY_RECONCILING','ACTIVE','RELEASED','REVOKED')),
  expires_at timestamptz,
  activated_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digital_entitlements_downloads CHECK (download_count BETWEEN 0 AND download_limit AND ((download_count = 0) = (first_downloaded_at IS NULL))),
  CONSTRAINT digital_entitlements_hold_expiry CHECK (state NOT IN ('HELD','EXPIRY_RECONCILING') OR expires_at IS NOT NULL),
  CONSTRAINT digital_entitlements_self_purchase CHECK (buyer_id <> creator_id)
);
-- XPL-05: at most one live exclusive license per product.
CREATE UNIQUE INDEX digital_entitlements_one_exclusive ON app.digital_entitlements (service_id) WHERE license = 'EXCLUSIVE' AND state IN ('HELD','EXPIRY_RECONCILING','ACTIVE');
CREATE INDEX digital_entitlements_service_live_idx ON app.digital_entitlements (service_id) WHERE state IN ('HELD','EXPIRY_RECONCILING','ACTIVE');
CREATE INDEX digital_entitlements_buyer_idx ON app.digital_entitlements (buyer_id, created_at DESC);
CREATE INDEX digital_entitlements_hold_expiry_idx ON app.digital_entitlements (expires_at) WHERE state IN ('HELD','EXPIRY_RECONCILING');

CREATE OR REPLACE FUNCTION app.digital_entitlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stock integer;
  live integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Serialize sales of one product; each query below sees rows committed by the sale that held the lock.
    PERFORM pg_advisory_xact_lock(hashtextextended('digital-stock:' || NEW.service_id::text, 0));
    IF NEW.state <> 'HELD' OR NEW.download_count <> 0 THEN
      RAISE EXCEPTION 'entitlements start HELD without downloads' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM app.digital_entitlements e WHERE e.service_id = NEW.service_id AND e.license = 'EXCLUSIVE' AND e.state IN ('HELD','EXPIRY_RECONCILING','ACTIVE')) THEN
      RAISE EXCEPTION 'an exclusive license for this product is already sold or reserved' USING ERRCODE = 'check_violation', HINT = 'SOLD_OUT';
    END IF;
    SELECT count(*) INTO live FROM app.digital_entitlements e WHERE e.service_id = NEW.service_id AND e.state IN ('HELD','EXPIRY_RECONCILING','ACTIVE');
    IF NEW.license = 'EXCLUSIVE' AND live > 0 THEN
      RAISE EXCEPTION 'an exclusive license cannot be sold while other licenses are live' USING ERRCODE = 'check_violation', HINT = 'SOLD_OUT';
    END IF;
    SELECT s.digital_stock INTO stock FROM app.services s WHERE s.id = NEW.service_id;
    IF stock IS NOT NULL AND live >= stock THEN
      RAISE EXCEPTION 'this product is sold out' USING ERRCODE = 'check_violation', HINT = 'SOLD_OUT';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.service_id IS DISTINCT FROM OLD.service_id OR NEW.service_version_id IS DISTINCT FROM OLD.service_version_id
     OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id OR NEW.creator_id IS DISTINCT FROM OLD.creator_id OR NEW.license IS DISTINCT FROM OLD.license
     OR NEW.release_version IS DISTINCT FROM OLD.release_version OR NEW.updates_policy IS DISTINCT FROM OLD.updates_policy OR NEW.download_limit IS DISTINCT FROM OLD.download_limit THEN
    RAISE EXCEPTION 'entitlement terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.download_count < OLD.download_count OR (NEW.download_count > OLD.download_count AND NEW.state <> 'ACTIVE') THEN
    RAISE EXCEPTION 'downloads only increase, and only on an active entitlement' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
         (OLD.state = 'HELD' AND NEW.state IN ('EXPIRY_RECONCILING','ACTIVE','RELEASED'))
      OR (OLD.state = 'EXPIRY_RECONCILING' AND NEW.state IN ('ACTIVE','RELEASED'))
      OR (OLD.state = 'ACTIVE' AND NEW.state = 'REVOKED')
    ) THEN
      RAISE EXCEPTION 'invalid entitlement transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'ACTIVE' THEN NEW.activated_at := now(); NEW.expires_at := NULL; END IF;
    IF NEW.state IN ('RELEASED','REVOKED') THEN NEW.ended_at := now(); END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER digital_entitlements_guard BEFORE INSERT OR UPDATE ON app.digital_entitlements FOR EACH ROW EXECUTE FUNCTION app.digital_entitlement_guard();
CREATE TRIGGER digital_entitlements_no_delete BEFORE DELETE ON app.digital_entitlements FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Funding activates the license; cancellation or refund ends it (revoking downloads), exactly once.
CREATE OR REPLACE FUNCTION app.order_entitlement_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  IF NEW.status = 'FUNDED' THEN
    UPDATE app.digital_entitlements SET state = 'ACTIVE' WHERE order_id = NEW.id AND state IN ('HELD','EXPIRY_RECONCILING');
  ELSIF NEW.status IN ('CANCELLED','REFUNDED') THEN
    UPDATE app.digital_entitlements SET state = 'RELEASED' WHERE order_id = NEW.id AND state IN ('HELD','EXPIRY_RECONCILING');
    UPDATE app.digital_entitlements SET state = 'REVOKED' WHERE order_id = NEW.id AND state = 'ACTIVE';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER orders_entitlement_sync AFTER UPDATE OF status ON app.orders FOR EACH ROW EXECUTE FUNCTION app.order_entitlement_sync();

-- Every issued download link, for refund and dispute evidence.
CREATE TABLE app.digital_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id uuid NOT NULL REFERENCES app.digital_entitlements(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES app.digital_releases(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX digital_downloads_entitlement_idx ON app.digital_downloads (entitlement_id, created_at);
CREATE TRIGGER digital_downloads_append_only BEFORE UPDATE OR DELETE ON app.digital_downloads FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- A product file in a release can never be deleted.
CREATE OR REPLACE FUNCTION app.storage_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.mime IS DISTINCT FROM OLD.mime
     OR NEW.filename IS DISTINCT FROM OLD.filename OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'storage asset identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.lifecycle_state = 'DELETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'deleted storage assets are terminal' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.lifecycle_state = 'QUARANTINED' AND NEW.lifecycle_state = 'READY' THEN
    RAISE EXCEPTION 'quarantined assets cannot return to READY' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lifecycle_state = 'DELETED' AND OLD.lifecycle_state <> 'DELETED' AND (
       EXISTS (SELECT 1 FROM app.delivery_assets d WHERE d.asset_id = OLD.id)
    OR EXISTS (SELECT 1 FROM app.samples s WHERE s.storage_asset_id = OLD.id)
    OR EXISTS (SELECT 1 FROM app.digital_releases r WHERE r.asset_id = OLD.id)
    OR OLD.purpose IN ('BRIEF','DISPUTE')) THEN
    RAISE EXCEPTION 'referenced storage assets cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

GRANT SELECT, INSERT ON app.digital_releases, app.digital_downloads TO app_server;
GRANT SELECT, INSERT, UPDATE ON app.digital_entitlements TO app_server;
