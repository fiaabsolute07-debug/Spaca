-- Campaign images: a buyer shows creators what the project looks like (product screenshots, brand visuals). An image is
-- the buyer's own REQUEST_IMAGE upload (image only) attached to one of their campaigns, served through
-- /api/request-images/[id] only while the campaign is visible. Up to six per campaign, in order.

ALTER TABLE app.upload_intents DROP CONSTRAINT upload_intents_purpose_check;
ALTER TABLE app.upload_intents ADD CONSTRAINT upload_intents_purpose_check CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE','DIGITAL','AVATAR','REQUEST_IMAGE'));
ALTER TABLE app.upload_intents DROP CONSTRAINT upload_intents_bucket_check;
ALTER TABLE app.upload_intents ADD CONSTRAINT upload_intents_bucket_check CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes','private-products','public-avatars','public-campaigns'));
ALTER TABLE app.storage_assets DROP CONSTRAINT storage_assets_purpose_check;
ALTER TABLE app.storage_assets ADD CONSTRAINT storage_assets_purpose_check CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE','DIGITAL','AVATAR','REQUEST_IMAGE'));
ALTER TABLE app.storage_assets DROP CONSTRAINT storage_assets_bucket_check;
ALTER TABLE app.storage_assets ADD CONSTRAINT storage_assets_bucket_check CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes','private-products','public-avatars','public-campaigns','private-quarantine'));

-- The image's owner must be the campaign's buyer: both foreign keys share buyer_id.
CREATE UNIQUE INDEX requests_id_buyer_key ON app.requests (id, buyer_id);
CREATE TABLE app.request_images (
  request_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  asset_purpose text NOT NULL DEFAULT 'REQUEST_IMAGE' CHECK (asset_purpose = 'REQUEST_IMAGE'),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, position),
  CONSTRAINT request_images_asset_once UNIQUE (request_id, asset_id),
  CONSTRAINT request_images_request_fk FOREIGN KEY (request_id, buyer_id) REFERENCES app.requests (id, buyer_id) ON DELETE RESTRICT,
  CONSTRAINT request_images_asset_fk FOREIGN KEY (asset_id, buyer_id, asset_purpose) REFERENCES app.storage_assets (id, owner_id, purpose) ON DELETE RESTRICT
);
CREATE INDEX request_images_asset_idx ON app.request_images (asset_id);

-- An image still on a campaign can never be deleted.
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
    OR EXISTS (SELECT 1 FROM app.profiles p WHERE p.avatar_asset_id = OLD.id)
    OR EXISTS (SELECT 1 FROM app.request_images i WHERE i.asset_id = OLD.id)
    OR OLD.purpose IN ('BRIEF','DISPUTE')) THEN
    RAISE EXCEPTION 'referenced storage assets cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

GRANT SELECT, INSERT, DELETE ON app.request_images TO app_server;
