-- W4-A: auctions v2 (master §5.3, §10; AUC-01..14). Exact state enum with a DB transition guard, immutable
-- first_valid_bid_at, sequenced idempotent bids with auditable invalidation, and one purchase intent per sale.

-- Auctions ---------------------------------------------------------------------------------------------------
ALTER TABLE app.auctions DROP CONSTRAINT IF EXISTS auctions_status_check;
UPDATE app.auctions SET status = 'SETTLED' WHERE status = 'CLOSED';
UPDATE app.auctions SET status = CASE WHEN bid_count = 0 THEN 'NO_BIDS' ELSE 'WINNER_DEFAULTED' END WHERE status = 'EXPIRED';
ALTER TABLE app.auctions ADD CONSTRAINT auctions_status_check
  CHECK (status IN ('SCHEDULED','LIVE','AWAITING_WINNER_PAYMENT','SETTLED','NO_BIDS','WINNER_DEFAULTED','CANCELLED'));
ALTER TABLE app.auctions ADD COLUMN first_valid_bid_at timestamptz;
UPDATE app.auctions a SET first_valid_bid_at = (SELECT min(b.created_at) FROM app.bids b WHERE b.auction_id = a.id);
ALTER TABLE app.auctions ADD COLUMN payment_due_at timestamptz;
ALTER TABLE app.auctions ADD COLUMN terms_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app.auctions ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE app.auctions ADD COLUMN closed_at timestamptz;
ALTER TABLE app.auctions ADD COLUMN cancel_reason text;
ALTER TABLE app.auctions ADD CONSTRAINT auctions_max_duration CHECK (ends_at - starts_at <= interval '7 days') NOT VALID;
CREATE INDEX IF NOT EXISTS auctions_due_idx ON app.auctions (ends_at) WHERE status IN ('SCHEDULED','LIVE');

-- Bids: per-auction sequence, request key, and invalidation instead of deletion --------------------------------
ALTER TABLE app.bids ADD COLUMN sequence bigint;
WITH numbered AS (SELECT id, row_number() OVER (PARTITION BY auction_id ORDER BY created_at, id) AS seq FROM app.bids)
UPDATE app.bids b SET sequence = n.seq FROM numbered n WHERE n.id = b.id;
ALTER TABLE app.bids ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE app.bids ADD CONSTRAINT bids_auction_sequence_key UNIQUE (auction_id, sequence);
ALTER TABLE app.bids ADD COLUMN request_key text;
UPDATE app.bids SET request_key = id::text;
ALTER TABLE app.bids ALTER COLUMN request_key SET NOT NULL;
ALTER TABLE app.bids ADD CONSTRAINT bids_request_key_unique UNIQUE (auction_id, bidder_id, request_key);
ALTER TABLE app.bids ADD COLUMN status text NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED','INVALIDATED'));
ALTER TABLE app.bids ADD COLUMN invalidated_reason text;
ALTER TABLE app.bids ADD COLUMN invalidated_by uuid REFERENCES app.users(id) ON DELETE RESTRICT;
ALTER TABLE app.bids ADD COLUMN invalidated_at timestamptz;
ALTER TABLE app.bids ADD CONSTRAINT bids_invalidation_fields CHECK ((status = 'INVALIDATED') = (invalidated_at IS NOT NULL AND invalidated_reason IS NOT NULL));
CREATE INDEX bids_ranking_idx ON app.bids (auction_id, amount_minor DESC, sequence ASC) WHERE status = 'ACCEPTED';
CREATE INDEX bids_bidder_idx ON app.bids (bidder_id, created_at DESC);

CREATE OR REPLACE FUNCTION app.bid_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.auction_id IS DISTINCT FROM OLD.auction_id OR NEW.bidder_id IS DISTINCT FROM OLD.bidder_id OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'accepted bids are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'INVALIDATED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'invalidated bids are terminal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bids_guard BEFORE UPDATE ON app.bids FOR EACH ROW EXECUTE FUNCTION app.bid_guard();
CREATE TRIGGER bids_no_delete BEFORE DELETE ON app.bids FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

ALTER TABLE app.auctions ADD COLUMN current_bid_id uuid REFERENCES app.bids(id) ON DELETE RESTRICT;
ALTER TABLE app.auctions ADD COLUMN winning_bid_id uuid REFERENCES app.bids(id) ON DELETE RESTRICT;
UPDATE app.auctions a SET current_bid_id = (SELECT b.id FROM app.bids b WHERE b.auction_id = a.id ORDER BY b.amount_minor DESC, b.sequence ASC LIMIT 1);

-- Purchase intents: the single sale path of an auction (winner after close, or Buy Now) --------------------------
CREATE TABLE app.auction_purchase_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES app.auctions(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('WINNER','BUY_NOW')),
  bid_id uuid REFERENCES app.bids(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FUNDED','DEFAULTED','EXPIRED')),
  order_id uuid NOT NULL UNIQUE REFERENCES app.orders(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auction_purchase_intents_winner_bid CHECK ((kind = 'WINNER') = (bid_id IS NOT NULL))
);
CREATE UNIQUE INDEX auction_purchase_intents_one_sale ON app.auction_purchase_intents (auction_id) WHERE status IN ('ACTIVE','FUNDED');
CREATE INDEX auction_purchase_intents_buyer_idx ON app.auction_purchase_intents (buyer_id, created_at DESC);

INSERT INTO app.auction_purchase_intents (auction_id, buyer_id, kind, bid_id, amount_minor, status, order_id, expires_at, created_at)
SELECT o.source_ref, o.buyer_id, CASE WHEN b.id IS NULL THEN 'BUY_NOW' ELSE 'WINNER' END, b.id, o.amount_minor,
  CASE WHEN o.status = 'AWAITING_PAYMENT' THEN 'ACTIVE' WHEN o.funded_at IS NULL THEN 'EXPIRED' ELSE 'FUNDED' END,
  o.id, o.created_at + interval '24 hours', o.created_at
FROM app.orders o
JOIN app.auctions au ON au.id = o.source_ref
LEFT JOIN LATERAL (SELECT id FROM app.bids WHERE auction_id = o.source_ref AND bidder_id = o.buyer_id AND amount_minor = o.amount_minor ORDER BY sequence LIMIT 1) b ON true
WHERE o.source = 'AUCTION'
ON CONFLICT DO NOTHING;
UPDATE app.auctions a SET winning_bid_id = i.bid_id FROM app.auction_purchase_intents i WHERE i.auction_id = a.id AND i.kind = 'WINNER' AND a.winning_bid_id IS NULL;

-- Auction guard: §10.2 transitions, terms frozen after the first valid bid, first_valid_bid_at write-once ---------
CREATE OR REPLACE FUNCTION app.auction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_valid_bid_at IS NOT NULL AND NEW.first_valid_bid_at IS DISTINCT FROM OLD.first_valid_bid_at THEN
    RAISE EXCEPTION 'first_valid_bid_at is write-once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.first_valid_bid_at IS NOT NULL AND (NEW.starting_price_minor IS DISTINCT FROM OLD.starting_price_minor
     OR NEW.minimum_increment_minor IS DISTINCT FROM OLD.minimum_increment_minor OR NEW.buy_now_price_minor IS DISTINCT FROM OLD.buy_now_price_minor
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.service_version_id IS DISTINCT FROM OLD.service_version_id OR NEW.terms_snapshot IS DISTINCT FROM OLD.terms_snapshot) THEN
    RAISE EXCEPTION 'auction terms are frozen after the first valid bid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'SCHEDULED' AND NEW.status IN ('LIVE','NO_BIDS','CANCELLED'))
    OR (OLD.status = 'LIVE' AND NEW.status IN ('AWAITING_WINNER_PAYMENT','NO_BIDS'))
    OR (OLD.status = 'LIVE' AND NEW.status = 'CANCELLED' AND OLD.first_valid_bid_at IS NULL)
    OR (OLD.status = 'AWAITING_WINNER_PAYMENT' AND NEW.status IN ('SETTLED','WINNER_DEFAULTED'))) THEN
    RAISE EXCEPTION 'auction % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auctions_guard BEFORE UPDATE ON app.auctions FOR EACH ROW EXECUTE FUNCTION app.auction_guard();
CREATE TRIGGER auctions_no_delete BEFORE DELETE ON app.auctions FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Order outcomes drive the sale: funding settles; an unpaid cancellation defaults (no silent relist, AUC-10/11).
CREATE OR REPLACE FUNCTION app.auction_order_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source <> 'AUCTION' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'FUNDED' AND OLD.status = 'AWAITING_PAYMENT' THEN
    UPDATE app.auction_purchase_intents SET status = 'FUNDED', updated_at = now() WHERE order_id = NEW.id AND status = 'ACTIVE';
    UPDATE app.auctions SET status = 'SETTLED', closed_at = coalesce(closed_at, now()), version = version + 1, updated_at = now()
      WHERE id = NEW.source_ref AND status = 'AWAITING_WINNER_PAYMENT';
  ELSIF NEW.status = 'CANCELLED' AND OLD.status = 'AWAITING_PAYMENT' THEN
    UPDATE app.auction_purchase_intents SET status = CASE kind WHEN 'WINNER' THEN 'DEFAULTED' ELSE 'EXPIRED' END, updated_at = now()
      WHERE order_id = NEW.id AND status = 'ACTIVE';
    UPDATE app.auctions SET status = 'WINNER_DEFAULTED', closed_at = coalesce(closed_at, now()), version = version + 1, updated_at = now()
      WHERE id = NEW.source_ref AND status = 'AWAITING_WINNER_PAYMENT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_auction_sync AFTER UPDATE OF status ON app.orders FOR EACH ROW EXECUTE FUNCTION app.auction_order_sync();

GRANT SELECT, INSERT, UPDATE ON app.auction_purchase_intents TO app_server;
