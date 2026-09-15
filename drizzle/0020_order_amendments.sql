-- ORD-12: deadlines move only by mutual agreement, recorded as immutable amendments.
-- One party proposes a later deadline; the other accepts or declines. The proposal is tied to the order version it
-- was made on, so any later change to the order (delivery, revision, dispute, cancellation) expires it.

CREATE TABLE app.order_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  kind text NOT NULL DEFAULT 'DEADLINE_EXTENSION' CHECK (kind IN ('DEADLINE_EXTENSION')),
  -- DELIVERY moves orders.delivery_due_at (funded or in progress); REVISION moves orders.revision_due_at.
  deadline text NOT NULL CHECK (deadline IN ('DELIVERY','REVISION')),
  proposed_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  counterparty_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 2000),
  old_due_at timestamptz NOT NULL,
  new_due_at timestamptz NOT NULL,
  order_version integer NOT NULL,
  policy_version text NOT NULL DEFAULT 'amend-v1',
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','ACCEPTED','REJECTED','WITHDRAWN','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (proposed_by <> counterparty_id),
  CHECK (new_due_at > old_due_at),
  CHECK ((status = 'REQUESTED') = (responded_at IS NULL))
);
CREATE UNIQUE INDEX order_amendments_one_open ON app.order_amendments (order_id) WHERE status = 'REQUESTED';
CREATE INDEX order_amendments_order_idx ON app.order_amendments (order_id, created_at);

-- Proposed terms never change, a decided amendment never changes again, and nothing is deleted.
CREATE OR REPLACE FUNCTION app.order_amendment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.deadline IS DISTINCT FROM OLD.deadline
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.old_due_at IS DISTINCT FROM OLD.old_due_at OR NEW.new_due_at IS DISTINCT FROM OLD.new_due_at
     OR NEW.order_version IS DISTINCT FROM OLD.order_version OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'amendment terms are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'amendment % is already %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_amendments_guard BEFORE UPDATE ON app.order_amendments FOR EACH ROW EXECUTE FUNCTION app.order_amendment_guard();
CREATE TRIGGER order_amendments_no_delete BEFORE DELETE ON app.order_amendments FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- A delivery deadline, once set, moves only to the new date of an amendment accepted in the same transaction (ORD-04/12).
CREATE OR REPLACE FUNCTION app.order_delivery_due_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.delivery_due_at IS NOT NULL AND NEW.delivery_due_at IS DISTINCT FROM OLD.delivery_due_at THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.order_amendments a
      WHERE a.order_id = NEW.id AND a.deadline = 'DELIVERY' AND a.status = 'ACCEPTED'
        AND a.old_due_at = OLD.delivery_due_at AND a.new_due_at = NEW.delivery_due_at
        AND a.responded_at = now()
    ) THEN
      RAISE EXCEPTION 'delivery deadline of order % changes only through an accepted amendment', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_delivery_due_guard BEFORE UPDATE OF delivery_due_at ON app.orders FOR EACH ROW EXECUTE FUNCTION app.order_delivery_due_guard();

-- Any status change except starting work (FUNDED → IN_PROGRESS, same deadline) ends an open proposal: the consent was
-- given for the order as it was. Covers commands, jobs and operator actions alike.
CREATE OR REPLACE FUNCTION app.order_amendment_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expired record;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'FUNDED' AND NEW.status = 'IN_PROGRESS') THEN
    FOR expired IN UPDATE app.order_amendments SET status = 'EXPIRED', responded_at = now()
        WHERE order_id = NEW.id AND status = 'REQUESTED' RETURNING id, kind LOOP
      INSERT INTO app.order_events (order_id, actor_id, kind, payload)
        VALUES (NEW.id, NULL, 'DEADLINE_EXTENSION_EXPIRED', jsonb_build_object('amendment_id', expired.id, 'order_status', NEW.status));
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER orders_amendment_expiry AFTER UPDATE OF status ON app.orders FOR EACH ROW EXECUTE FUNCTION app.order_amendment_expiry();

GRANT SELECT, INSERT, UPDATE ON app.order_amendments TO app_server;
