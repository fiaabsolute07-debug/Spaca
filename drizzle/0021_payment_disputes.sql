-- ORD-14: card payment disputes (chargebacks) are payment facts, separate from the order.
-- A dispute never changes the order's status, deliveries, approval or reviews. It records the provider's facts,
-- an evidence snapshot for operators, and freezes any creator release still pending while it is open or lost.

CREATE TABLE app.payment_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_reference text NOT NULL,
  funding_reference text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','WON','LOST')),
  -- What the order looked like when the dispute arrived, and references to the work on record (no private text).
  order_status_at_open text NOT NULL,
  settlement_status_at_open text NOT NULL,
  evidence jsonb NOT NULL,
  opened_event_id text NOT NULL,
  closed_event_id text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (provider, provider_reference),
  CHECK ((status = 'OPEN') = (closed_at IS NULL)),
  CHECK ((status = 'OPEN') = (closed_event_id IS NULL))
);
CREATE INDEX payment_disputes_order_idx ON app.payment_disputes (order_id, status);

-- Facts only move forward: OPEN → WON or LOST, once. Everything recorded at opening stays as it was.
CREATE OR REPLACE FUNCTION app.payment_dispute_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference OR NEW.funding_reference IS DISTINCT FROM OLD.funding_reference
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.order_status_at_open IS DISTINCT FROM OLD.order_status_at_open OR NEW.settlement_status_at_open IS DISTINCT FROM OLD.settlement_status_at_open
     OR NEW.evidence IS DISTINCT FROM OLD.evidence OR NEW.opened_event_id IS DISTINCT FROM OLD.opened_event_id OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'payment dispute facts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'payment dispute % is already %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_disputes_guard BEFORE UPDATE ON app.payment_disputes FOR EACH ROW EXECUTE FUNCTION app.payment_dispute_guard();
CREATE TRIGGER payment_disputes_no_delete BEFORE DELETE ON app.payment_disputes FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

GRANT SELECT, INSERT, UPDATE ON app.payment_disputes TO app_server;
