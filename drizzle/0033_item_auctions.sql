-- Web3 item auctions (2026-09-17). Auctions stop selling creator service slots and sell web3 items instead — whitelist
-- spots, guaranteed mints, pre-market token allocations, points or anything else the seller describes. Earlier service
-- auctions (app.auctions, app.bids) are kept untouched as history.
--
-- Money model: escrow plus seller collateral. The seller locks collateral before the listing opens. The winner's
-- payment is held until the buyer confirms delivery (or the confirmation window passes), then it goes to the seller
-- with the collateral back. A seller who does not deliver by the stated deadline forfeits the collateral to the buyer,
-- who is also refunded. In this environment the escrow is a sandbox recorded in the double-entry ledger
-- (accounts sandbox_wallet:<user>, item_collateral:<listing>, item_escrow:<sale>); no funds move.

CREATE TABLE app.item_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  -- PROJECT: the project selling its own allocation (buyer accounts only). RESALE: someone reselling what they hold.
  origin text NOT NULL CHECK (origin IN ('PROJECT','RESALE')),
  item_type text NOT NULL CHECK (char_length(item_type) BETWEEN 2 AND 40),
  title text NOT NULL CHECK (char_length(title) BETWEEN 4 AND 120),
  project_name text NOT NULL CHECK (char_length(project_name) BETWEEN 1 AND 80),
  project_url text CHECK (project_url IS NULL OR (project_url ~ '^https://' AND char_length(project_url) <= 300)),
  network text NOT NULL CHECK (char_length(network) BETWEEN 1 AND 40),
  quantity text NOT NULL CHECK (char_length(quantity) BETWEEN 1 AND 60),
  description text NOT NULL CHECK (char_length(description) BETWEEN 20 AND 2000),
  delivery_method text NOT NULL CHECK (char_length(delivery_method) BETWEEN 10 AND 500),
  buyer_provides text NOT NULL CHECK (char_length(buyer_provides) BETWEEN 3 AND 120),
  delivery_due_at timestamptz NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  starting_price_minor bigint NOT NULL CHECK (starting_price_minor > 0),
  min_increment_minor bigint NOT NULL CHECK (min_increment_minor > 0),
  buy_now_price_minor bigint CHECK (buy_now_price_minor IS NULL OR buy_now_price_minor > starting_price_minor),
  collateral_minor bigint NOT NULL CHECK (collateral_minor > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'AWAITING_COLLATERAL' CHECK (status IN ('AWAITING_COLLATERAL','OPEN','SOLD','NO_BIDS','CANCELLED')),
  collateral_posted_at timestamptz,
  collateral_released_at timestamptz,
  bid_count integer NOT NULL DEFAULT 0 CHECK (bid_count >= 0),
  current_bid_id uuid,
  first_bid_at timestamptz,
  closed_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_listings_window CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '14 days'),
  CONSTRAINT item_listings_delivery_after_end CHECK (delivery_due_at >= ends_at + interval '1 hour' AND delivery_due_at <= ends_at + interval '365 days'),
  -- Collateral covers at least a fifth of the starting price; the page shows how much of the current bid it covers.
  CONSTRAINT item_listings_collateral_floor CHECK (collateral_minor * 5 >= starting_price_minor),
  CONSTRAINT item_listings_open_needs_collateral CHECK (status = 'AWAITING_COLLATERAL' OR status = 'CANCELLED' OR collateral_posted_at IS NOT NULL)
);
CREATE INDEX item_listings_open_idx ON app.item_listings (ends_at) WHERE status = 'OPEN';
CREATE INDEX item_listings_seller_idx ON app.item_listings (seller_id, created_at DESC);

CREATE TABLE app.item_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES app.item_listings(id) ON DELETE RESTRICT,
  bidder_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, sequence)
);
CREATE INDEX item_bids_ranking_idx ON app.item_bids (listing_id, amount_minor DESC, sequence ASC);
CREATE INDEX item_bids_bidder_idx ON app.item_bids (bidder_id, created_at DESC);
CREATE TRIGGER item_bids_immutable BEFORE UPDATE OR DELETE ON app.item_bids FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
ALTER TABLE app.item_listings ADD CONSTRAINT item_listings_current_bid_fk FOREIGN KEY (current_bid_id) REFERENCES app.item_bids(id) ON DELETE RESTRICT;

CREATE TABLE app.item_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL UNIQUE REFERENCES app.item_listings(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('WINNER','BUY_NOW')),
  bid_id uuid REFERENCES app.item_bids(id) ON DELETE RESTRICT,
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  collateral_minor bigint NOT NULL CHECK (collateral_minor > 0),
  status text NOT NULL DEFAULT 'AWAITING_PAYMENT' CHECK (status IN ('AWAITING_PAYMENT','AWAITING_DELIVERY','DELIVERED','COMPLETED','PAYMENT_EXPIRED','SELLER_DEFAULTED','DISPUTED','REFUNDED')),
  payment_due_at timestamptz NOT NULL,
  paid_at timestamptz,
  buyer_details text CHECK (buyer_details IS NULL OR char_length(buyer_details) BETWEEN 3 AND 300),
  delivered_at timestamptz,
  delivery_proof text CHECK (delivery_proof IS NULL OR char_length(delivery_proof) BETWEEN 5 AND 500),
  confirm_by timestamptz,
  completed_at timestamptz,
  disputed_at timestamptz,
  dispute_reason text CHECK (dispute_reason IS NULL OR char_length(dispute_reason) BETWEEN 10 AND 1000),
  resolution text CHECK (resolution IS NULL OR resolution IN ('RELEASED_TO_SELLER','REFUNDED_WITH_COLLATERAL','REFUNDED')),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_sales_winner_bid CHECK ((kind = 'WINNER') = (bid_id IS NOT NULL)),
  CONSTRAINT item_sales_not_self CHECK (buyer_id <> seller_id),
  CONSTRAINT item_sales_paid_fields CHECK ((paid_at IS NULL) = (buyer_details IS NULL)),
  CONSTRAINT item_sales_delivered_fields CHECK ((delivered_at IS NULL) = (delivery_proof IS NULL))
);
CREATE INDEX item_sales_due_idx ON app.item_sales (status, payment_due_at);
CREATE INDEX item_sales_buyer_idx ON app.item_sales (buyer_id, created_at DESC);

-- Only these moves are possible, whatever the application does.
CREATE OR REPLACE FUNCTION app.item_sale_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.listing_id IS DISTINCT FROM OLD.listing_id OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.price_minor IS DISTINCT FROM OLD.price_minor OR NEW.collateral_minor IS DISTINCT FROM OLD.collateral_minor OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'item sale terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'AWAITING_PAYMENT' AND NEW.status IN ('AWAITING_DELIVERY','PAYMENT_EXPIRED'))
    OR (OLD.status = 'AWAITING_DELIVERY' AND NEW.status IN ('DELIVERED','SELLER_DEFAULTED','DISPUTED'))
    OR (OLD.status = 'DELIVERED' AND NEW.status IN ('COMPLETED','DISPUTED'))
    OR (OLD.status = 'DISPUTED' AND NEW.status IN ('COMPLETED','SELLER_DEFAULTED','REFUNDED'))) THEN
    RAISE EXCEPTION 'item sale % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_sales_guard BEFORE UPDATE ON app.item_sales FOR EACH ROW EXECUTE FUNCTION app.item_sale_guard();
CREATE TRIGGER item_sales_no_delete BEFORE DELETE ON app.item_sales FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE OR REPLACE FUNCTION app.item_listing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_bid_at IS NOT NULL AND (NEW.starting_price_minor IS DISTINCT FROM OLD.starting_price_minor
     OR NEW.min_increment_minor IS DISTINCT FROM OLD.min_increment_minor OR NEW.buy_now_price_minor IS DISTINCT FROM OLD.buy_now_price_minor
     OR NEW.collateral_minor IS DISTINCT FROM OLD.collateral_minor OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.delivery_due_at IS DISTINCT FROM OLD.delivery_due_at OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
     OR NEW.description IS DISTINCT FROM OLD.description OR NEW.quantity IS DISTINCT FROM OLD.quantity) THEN
    RAISE EXCEPTION 'listing terms are frozen after the first bid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'AWAITING_COLLATERAL' AND NEW.status IN ('OPEN','CANCELLED'))
    OR (OLD.status = 'OPEN' AND NEW.status IN ('SOLD','NO_BIDS'))
    OR (OLD.status = 'OPEN' AND NEW.status = 'CANCELLED' AND OLD.first_bid_at IS NULL)) THEN
    RAISE EXCEPTION 'item listing % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_listings_guard BEFORE UPDATE ON app.item_listings FOR EACH ROW EXECUTE FUNCTION app.item_listing_guard();
CREATE TRIGGER item_listings_no_delete BEFORE DELETE ON app.item_listings FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

GRANT SELECT, INSERT, UPDATE ON app.item_listings, app.item_sales TO app_server;
GRANT SELECT, INSERT ON app.item_bids TO app_server;
