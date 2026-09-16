-- Campaign card images: a card was loading the buyer's full-size upload (up to 10 MB each), so a list of campaigns
-- could pull tens of megabytes to draw thumbnails a few hundred pixels wide.
--
-- The browser now makes a small JPEG beside each upload and stores it as a second REQUEST_IMAGE asset owned by the
-- same buyer; cards load that one and the campaign page keeps the original. There is no image library on the server,
-- so nothing is re-encoded here: a campaign with no thumbnail simply falls back to its original.

ALTER TABLE app.request_images ADD COLUMN thumb_asset_id uuid;
ALTER TABLE app.request_images ADD CONSTRAINT request_images_thumb_fk
  FOREIGN KEY (thumb_asset_id, buyer_id, asset_purpose) REFERENCES app.storage_assets (id, owner_id, purpose) ON DELETE RESTRICT;
ALTER TABLE app.request_images ADD CONSTRAINT request_images_thumb_distinct
  CHECK (thumb_asset_id IS NULL OR thumb_asset_id <> asset_id);
CREATE INDEX request_images_thumb_idx ON app.request_images (thumb_asset_id);

-- A thumbnail a campaign still shows cannot be deleted either.
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
    OR EXISTS (SELECT 1 FROM app.request_images i WHERE i.asset_id = OLD.id OR i.thumb_asset_id = OLD.id)
    OR OLD.purpose IN ('BRIEF','DISPUTE')) THEN
    RAISE EXCEPTION 'referenced storage assets cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
