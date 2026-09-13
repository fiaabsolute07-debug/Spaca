-- W1-B order lifecycle (master §7): work clock, delivery validity + view evidence, review holds,
-- mutual cancellation requests, one active dispute, partial refunds, DB-enforced transition matrix.

ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS funded_at timestamptz;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS brief_ready_at timestamptz;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS work_start_at timestamptz;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS revision_due_at timestamptz;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS status_before_dispute text;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS cancellation_refund_minor bigint;
ALTER TABLE app.orders ADD CONSTRAINT orders_cancellation_refund_range CHECK (cancellation_refund_minor IS NULL OR (cancellation_refund_minor >= 0 AND cancellation_refund_minor <= amount_minor));
ALTER TABLE app.orders ADD CONSTRAINT orders_status_before_dispute_values CHECK (status_before_dispute IS NULL OR status_before_dispute IN ('IN_PROGRESS','DELIVERED','REVISION_REQUESTED'));

ALTER TABLE app.orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE app.orders ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN ('PENDING','PROCESSING','SUCCEEDED','FAILED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED'));
ALTER TABLE app.orders DROP CONSTRAINT IF EXISTS orders_revision_count_check;
ALTER TABLE app.orders ADD CONSTRAINT orders_revision_count_check CHECK (revision_count BETWEEN 0 AND 3);

-- Backfill clocks for existing rows (best effort; never overwrites set values).
UPDATE app.orders SET brief_ready_at = coalesce(brief_ready_at, created_at) WHERE source IN ('BOOK','REQUEST');
UPDATE app.orders SET funded_at = coalesce(funded_at, updated_at) WHERE payment_status IN ('SUCCEEDED','REFUND_PENDING','REFUNDED') AND funded_at IS NULL;
UPDATE app.orders SET work_start_at = greatest(funded_at, brief_ready_at) WHERE work_start_at IS NULL AND funded_at IS NOT NULL AND brief_ready_at IS NOT NULL;

-- Deliveries: validity and buyer view evidence per version (§7.5) ------------------------------------------
ALTER TABLE app.deliveries ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'VALID';
ALTER TABLE app.deliveries ADD CONSTRAINT deliveries_validation_status_values CHECK (validation_status IN ('VALID','QUARANTINED','INVALID'));
ALTER TABLE app.deliveries ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES app.users(id) ON DELETE RESTRICT;
ALTER TABLE app.deliveries ADD COLUMN IF NOT EXISTS buyer_viewed_at timestamptz;
ALTER TABLE app.deliveries ADD COLUMN IF NOT EXISTS buyer_notified_at timestamptz;
CREATE OR REPLACE FUNCTION app.delivery_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.url IS DISTINCT FROM OLD.url OR NEW.version IS DISTINCT FROM OLD.version OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'delivery versions are append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deliveries_content_guard BEFORE UPDATE ON app.deliveries FOR EACH ROW EXECUTE FUNCTION app.delivery_content_guard();
CREATE TRIGGER deliveries_no_delete BEFORE DELETE ON app.deliveries FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Review holds (§7.5): one active hold for the current delivery version ------------------------------------
CREATE TABLE app.review_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  delivery_version integer NOT NULL CHECK (delivery_version > 0),
  reason text NOT NULL CHECK (reason IN ('NO_BUYER_NOTIFICATION_EVIDENCE','NO_AUTO_ACCEPT_CONSENT','DELIVERY_NOT_VALID')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text CHECK (resolution IS NULL OR resolution IN ('BUYER_VIEWED','BUYER_ACTED','OPERATOR','SUPERSEDED'))
);
CREATE UNIQUE INDEX review_holds_one_active ON app.review_holds (order_id) WHERE resolved_at IS NULL;

-- Mutual cancellation after work starts (§7.2, ORD-13/15) --------------------------------------------------
CREATE TABLE app.cancellation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  counterparty_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 5000),
  refund_amount_minor bigint NOT NULL CHECK (refund_amount_minor >= 0),
  order_version integer NOT NULL,
  policy_version text NOT NULL DEFAULT 'v1',
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','ACCEPTED','REJECTED','WITHDRAWN','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (requested_by <> counterparty_id)
);
CREATE UNIQUE INDEX cancellation_requests_one_active ON app.cancellation_requests (order_id) WHERE status = 'REQUESTED';
-- Consented terms never change after creation.
CREATE OR REPLACE FUNCTION app.cancellation_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.refund_amount_minor IS DISTINCT FROM OLD.refund_amount_minor OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id
     OR NEW.order_version IS DISTINCT FROM OLD.order_version OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'cancellation terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'REQUESTED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'cancellation request % is already %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cancellation_requests_terms_guard BEFORE UPDATE ON app.cancellation_requests FOR EACH ROW EXECUTE FUNCTION app.cancellation_terms_guard();

-- Disputes: at most one active per order -------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS disputes_one_active ON app.disputes (order_id) WHERE status IN ('OPEN','UNDER_REVIEW');

-- Reviews: one per reviewer per order ----------------------------------------------------------------------
ALTER TABLE app.reviews ADD COLUMN IF NOT EXISTS reviewer_id uuid REFERENCES app.users(id) ON DELETE RESTRICT;
UPDATE app.reviews SET reviewer_id = buyer_id WHERE reviewer_id IS NULL;
ALTER TABLE app.reviews ALTER COLUMN reviewer_id SET NOT NULL;
ALTER TABLE app.reviews DROP CONSTRAINT IF EXISTS reviews_order_id_key;
ALTER TABLE app.reviews ADD CONSTRAINT reviews_order_reviewer_key UNIQUE (order_id, reviewer_id);

-- Order transition matrix (§7.2), enforced in the database as defense in depth ------------------------------
CREATE OR REPLACE FUNCTION app.order_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'AWAITING_PAYMENT' AND NEW.status IN ('FUNDED','CANCELLED'))
    OR (OLD.status = 'FUNDED' AND NEW.status IN ('IN_PROGRESS','CANCELLED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('DELIVERED','DISPUTED','CANCELLED'))
    OR (OLD.status = 'DELIVERED' AND NEW.status IN ('REVISION_REQUESTED','APPROVED','DISPUTED','CANCELLED'))
    OR (OLD.status = 'REVISION_REQUESTED' AND NEW.status IN ('DELIVERED','DISPUTED','CANCELLED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('COMPLETED'))
    OR (OLD.status = 'DISPUTED' AND NEW.status IN ('IN_PROGRESS','DELIVERED','REVISION_REQUESTED','APPROVED','CANCELLED'))
    OR (OLD.status = 'CANCELLED' AND NEW.status IN ('REFUNDED'))
  ) THEN
    RAISE EXCEPTION 'invalid order transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'order status change must increment version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_transition_guard BEFORE UPDATE OF status ON app.orders FOR EACH ROW EXECUTE FUNCTION app.order_transition_guard();

CREATE INDEX IF NOT EXISTS orders_delivered_review_idx ON app.orders (review_due_at) WHERE status = 'DELIVERED';
CREATE INDEX IF NOT EXISTS orders_due_idx ON app.orders (delivery_due_at) WHERE status IN ('FUNDED','IN_PROGRESS','REVISION_REQUESTED');

GRANT SELECT, INSERT, UPDATE ON app.review_holds, app.cancellation_requests TO app_server;
