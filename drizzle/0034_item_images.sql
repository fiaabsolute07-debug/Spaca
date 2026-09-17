-- Pictures for web3 item auctions (2026-09-17): the art of an NFT, a project banner, a screenshot of the allowlist, so
-- bidders can see what they are bidding on. An image is the seller's own ITEM_IMAGE upload (image only), served through
-- /api/item-images/[id] while its listing is visible. Up to six per listing, in order; the first is the cover. As with
-- campaign images, the browser makes a small copy for cards (thumb_asset_id) and the listing page shows the original.

ALTER TABLE app.upload_intents DROP CONSTRAINT upload_intents_purpose_check;
ALTER TABLE app.upload_intents ADD CONSTRAINT upload_intents_purpose_check CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE','DIGITAL','AVATAR','REQUEST_IMAGE','ITEM_IMAGE'));
ALTER TABLE app.upload_intents DROP CONSTRAINT upload_intents_bucket_check;
ALTER TABLE app.upload_intents ADD CONSTRAINT upload_intents_bucket_check CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes','private-products','public-avatars','public-campaigns','public-items'));
ALTER TABLE app.storage_assets DROP CONSTRAINT storage_assets_purpose_check;
ALTER TABLE app.storage_assets ADD CONSTRAINT storage_assets_purpose_check CHECK (purpose IN ('DELIVERY','BRIEF','DISPUTE','SAMPLE','DIGITAL','AVATAR','REQUEST_IMAGE','ITEM_IMAGE'));
ALTER TABLE app.storage_assets DROP CONSTRAINT storage_assets_bucket_check;
ALTER TABLE app.storage_assets ADD CONSTRAINT storage_assets_bucket_check CHECK (bucket IN ('public-portfolio','private-briefs','private-deliverables','private-disputes','private-products','public-avatars','public-campaigns','public-items','private-quarantine'));

-- The image's owner must be the listing's seller: both foreign keys share seller_id.
CREATE UNIQUE INDEX item_listings_id_seller_key ON app.item_listings (id, seller_id);
CREATE TABLE app.item_listing_images (
  listing_id uuid NOT NULL,
  seller_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  thumb_asset_id uuid,
  asset_purpose text NOT NULL DEFAULT 'ITEM_IMAGE' CHECK (asset_purpose = 'ITEM_IMAGE'),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, position),
  CONSTRAINT item_listing_images_asset_once UNIQUE (listing_id, asset_id),
  CONSTRAINT item_listing_images_listing_fk FOREIGN KEY (listing_id, seller_id) REFERENCES app.item_listings (id, seller_id) ON DELETE RESTRICT,
  CONSTRAINT item_listing_images_asset_fk FOREIGN KEY (asset_id, seller_id, asset_purpose) REFERENCES app.storage_assets (id, owner_id, purpose) ON DELETE RESTRICT,
  CONSTRAINT item_listing_images_thumb_fk FOREIGN KEY (thumb_asset_id, seller_id, asset_purpose) REFERENCES app.storage_assets (id, owner_id, purpose) ON DELETE RESTRICT,
  CONSTRAINT item_listing_images_thumb_distinct CHECK (thumb_asset_id IS NULL OR thumb_asset_id <> asset_id)
);
CREATE INDEX item_listing_images_asset_idx ON app.item_listing_images (asset_id);
CREATE INDEX item_listing_images_thumb_idx ON app.item_listing_images (thumb_asset_id);

-- A picture a listing still shows (or its card copy) can never be deleted.
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
    OR EXISTS (SELECT 1 FROM app.item_listing_images i WHERE i.asset_id = OLD.id OR i.thumb_asset_id = OLD.id)
    OR OLD.purpose IN ('BRIEF','DISPUTE')) THEN
    RAISE EXCEPTION 'referenced storage assets cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

GRANT SELECT, INSERT, DELETE ON app.item_listing_images TO app_server;
