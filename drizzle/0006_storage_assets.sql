-- W2-S: private asset storage (master §4.4; §5 StorageAsset / UploadIntent / DeliverableAsset; SEC-05/06/14, ORD-07).
-- Object keys are server-generated. An asset id equals its upload intent id so clients track one id end to end.

CREATE TABLE app.upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE')),
  order_id uuid REFERENCES app.orders(id) ON DELETE RESTRICT,
  bucket text NOT NULL CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes')),
  object_key text NOT NULL CHECK (object_key ~ '^[a-z]+/[0-9a-f-]{36}/[0-9a-f-]{36}\.[a-z0-9]{2,5}$'),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 180),
  declared_mime text NOT NULL,
  declared_size bigint NOT NULL CHECK (declared_size > 0),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  outcome text CHECK (outcome IN ('FINALIZED','QUARANTINED','REJECTED','ABANDONED')),
  outcome_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key),
  CONSTRAINT upload_intents_order_scope CHECK ((purpose IN ('DELIVERY','BRIEF','DISPUTE')) = (order_id IS NOT NULL)),
  CONSTRAINT upload_intents_closed_outcome CHECK ((closed_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX upload_intents_owner_open_idx ON app.upload_intents (owner_id, created_at DESC) WHERE closed_at IS NULL;
CREATE INDEX upload_intents_expiry_idx ON app.upload_intents (expires_at) WHERE closed_at IS NULL;

CREATE TABLE app.storage_assets (
  id uuid PRIMARY KEY REFERENCES app.upload_intents(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE')),
  order_id uuid REFERENCES app.orders(id) ON DELETE RESTRICT,
  bucket text NOT NULL CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes','private-quarantine')),
  object_key text NOT NULL,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 180),
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  scan_status text NOT NULL CHECK (scan_status IN ('CLEAN','QUARANTINED')),
  scan_engine text NOT NULL,
  scan_detail text,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('READY','QUARANTINED','DELETED')),
  quarantined_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key),
  UNIQUE (id, order_id, purpose),
  UNIQUE (id, owner_id, purpose),
  CONSTRAINT storage_assets_order_scope CHECK ((purpose IN ('DELIVERY','BRIEF','DISPUTE')) = (order_id IS NOT NULL)),
  CONSTRAINT storage_assets_quarantine_bucket CHECK (lifecycle_state <> 'QUARANTINED' OR bucket = 'private-quarantine'),
  CONSTRAINT storage_assets_ready_clean CHECK (lifecycle_state <> 'READY' OR scan_status = 'CLEAN'),
  CONSTRAINT storage_assets_deleted_at CHECK ((lifecycle_state = 'DELETED') = (deleted_at IS NOT NULL))
);
CREATE INDEX storage_assets_order_idx ON app.storage_assets (order_id, purpose, created_at) WHERE order_id IS NOT NULL;
CREATE INDEX storage_assets_owner_idx ON app.storage_assets (owner_id, created_at DESC);

-- Identity, content and scope are immutable; lifecycle only moves forward and never deletes a referenced asset.
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
    OR OLD.purpose IN ('BRIEF','DISPUTE')) THEN
    RAISE EXCEPTION 'referenced storage assets cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER storage_assets_guard BEFORE UPDATE ON app.storage_assets FOR EACH ROW EXECUTE FUNCTION app.storage_asset_guard();
CREATE TRIGGER storage_assets_no_delete BEFORE DELETE ON app.storage_assets FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- DeliverableAsset: the asset must belong to the same order and be a DELIVERY asset (SEC-14), append-only like deliveries.
ALTER TABLE app.deliveries ADD CONSTRAINT deliveries_id_order_key UNIQUE (id, order_id);
CREATE TABLE app.delivery_assets (
  delivery_id uuid NOT NULL,
  order_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'DELIVERY' CHECK (purpose = 'DELIVERY'),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_id, asset_id),
  UNIQUE (delivery_id, position),
  FOREIGN KEY (delivery_id, order_id) REFERENCES app.deliveries (id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, order_id, purpose) REFERENCES app.storage_assets (id, order_id, purpose) ON DELETE RESTRICT
);
CREATE INDEX delivery_assets_asset_idx ON app.delivery_assets (asset_id);
CREATE TRIGGER delivery_assets_append_only BEFORE UPDATE OR DELETE ON app.delivery_assets FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Portfolio samples may carry an uploaded SAMPLE asset owned by the same creator instead of an external link.
ALTER TABLE app.samples ADD COLUMN storage_asset_id uuid;
ALTER TABLE app.samples ADD COLUMN asset_purpose text NOT NULL DEFAULT 'SAMPLE' CHECK (asset_purpose = 'SAMPLE');
ALTER TABLE app.samples ADD CONSTRAINT samples_storage_asset_fk FOREIGN KEY (storage_asset_id, creator_id, asset_purpose)
  REFERENCES app.storage_assets (id, owner_id, purpose) ON DELETE RESTRICT;
ALTER TABLE app.samples ALTER COLUMN url DROP NOT NULL;
ALTER TABLE app.samples ADD CONSTRAINT samples_url_or_asset CHECK (url IS NOT NULL OR storage_asset_id IS NOT NULL);
CREATE UNIQUE INDEX samples_storage_asset_unique ON app.samples (storage_asset_id) WHERE storage_asset_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON app.upload_intents, app.storage_assets TO app_server;
GRANT SELECT, INSERT ON app.delivery_assets TO app_server;
