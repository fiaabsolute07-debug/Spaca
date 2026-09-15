-- Profile photo and richer public profile (P1A-06). An avatar is the user's own AVATAR upload (image only), served
-- through /api/avatars/[id] only while a profile points at it. Headline, location and languages round out the page.

ALTER TABLE app.upload_intents DROP CONSTRAINT upload_intents_purpose_check;
ALTER TABLE app.upload_intents ADD CONSTRAINT upload_intents_purpose_check CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE','DIGITAL','AVATAR'));
ALTER TABLE app.upload_intents DROP CONSTRAINT upload_intents_bucket_check;
ALTER TABLE app.upload_intents ADD CONSTRAINT upload_intents_bucket_check CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes','private-products','public-avatars'));
ALTER TABLE app.storage_assets DROP CONSTRAINT storage_assets_purpose_check;
ALTER TABLE app.storage_assets ADD CONSTRAINT storage_assets_purpose_check CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE','DIGITAL','AVATAR'));
ALTER TABLE app.storage_assets DROP CONSTRAINT storage_assets_bucket_check;
ALTER TABLE app.storage_assets ADD CONSTRAINT storage_assets_bucket_check CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes','private-products','public-avatars','private-quarantine'));

ALTER TABLE app.profiles ADD COLUMN avatar_asset_id uuid;
ALTER TABLE app.profiles ADD COLUMN avatar_purpose text NOT NULL DEFAULT 'AVATAR' CHECK (avatar_purpose = 'AVATAR');
ALTER TABLE app.profiles ADD CONSTRAINT profiles_avatar_asset_fk FOREIGN KEY (avatar_asset_id, user_id, avatar_purpose)
  REFERENCES app.storage_assets (id, owner_id, purpose) ON DELETE RESTRICT;
ALTER TABLE app.profiles ADD COLUMN headline text NOT NULL DEFAULT '' CHECK (char_length(headline) <= 120);
ALTER TABLE app.profiles ADD COLUMN location text NOT NULL DEFAULT '' CHECK (char_length(location) <= 80);
ALTER TABLE app.profiles ADD COLUMN languages text NOT NULL DEFAULT '' CHECK (char_length(languages) <= 120);

-- A photo still on a profile can never be deleted.
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
    OR OLD.purpose IN ('BRIEF','DISPUTE')) THEN
    RAISE EXCEPTION 'referenced storage assets cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
