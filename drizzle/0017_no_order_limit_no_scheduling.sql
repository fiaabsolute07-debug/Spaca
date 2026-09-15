-- Product decisions of 2026-09-15 (user):
-- 1. No limit on how many orders a creator takes at once. Creators keep "pause new orders"; claims still count
--    orders in progress (held/active) for the creator's dashboard and for pause, but never refuse on a number.
-- 2. ACCESS sessions are scheduled by the buyer and creator in order messages. No weekly availability windows, slots,
--    appointments, cancellation notice or no-show rules; an ACCESS listing only states the session length.

-- 1. Claims refuse only while the creator paused new orders.
CREATE OR REPLACE FUNCTION app.workload_claim_counters() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta_held integer := 0;
  delta_active integer := 0;
  workload app.creator_workloads%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state = OLD.state THEN RETURN NULL; END IF;
    delta_held := delta_held - CASE WHEN OLD.state IN ('HELD','EXPIRY_RECONCILING') THEN OLD.units ELSE 0 END;
    delta_active := delta_active - CASE WHEN OLD.state = 'ACTIVE' THEN OLD.units ELSE 0 END;
  ELSE
    INSERT INTO app.creator_workloads (creator_id) VALUES (NEW.creator_id) ON CONFLICT (creator_id) DO NOTHING;
  END IF;
  delta_held := delta_held + CASE WHEN NEW.state IN ('HELD','EXPIRY_RECONCILING') THEN NEW.units ELSE 0 END;
  delta_active := delta_active + CASE WHEN NEW.state = 'ACTIVE' THEN NEW.units ELSE 0 END;
  IF delta_held = 0 AND delta_active = 0 THEN RETURN NULL; END IF;
  UPDATE app.creator_workloads
     SET held_units = held_units + delta_held, active_units = active_units + delta_active, updated_at = now()
   WHERE creator_id = NEW.creator_id
   RETURNING * INTO workload;
  IF TG_OP = 'INSERT' AND NOT workload.accepting_orders THEN
    RAISE EXCEPTION 'creator % is not accepting new orders', NEW.creator_id USING ERRCODE = 'check_violation', HINT = 'NOT_ACCEPTING_ORDERS';
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE app.creator_workloads DROP COLUMN max_active_units;

-- 2. Remove ACCESS scheduling (drizzle/0015). Orders keep their terms snapshot JSON as history.
DROP TRIGGER IF EXISTS orders_appointment_sync ON app.orders;
DROP FUNCTION IF EXISTS app.order_appointment_sync();
DROP TABLE IF EXISTS app.appointments;
DROP FUNCTION IF EXISTS app.appointment_guard();
DROP TABLE IF EXISTS app.availability_windows;

ALTER TABLE app.services DROP CONSTRAINT services_access_terms_complete;
ALTER TABLE app.service_versions DROP CONSTRAINT service_versions_access_terms_complete;
ALTER TABLE app.services DROP COLUMN access_buffer_minutes, DROP COLUMN access_cancel_notice_hours, DROP COLUMN access_no_show_minutes;
ALTER TABLE app.service_versions DROP COLUMN access_buffer_minutes, DROP COLUMN access_cancel_notice_hours, DROP COLUMN access_no_show_minutes;
ALTER TABLE app.services ADD CONSTRAINT services_access_terms_complete CHECK (
  taxonomy <> 'ACCESS' OR status IN ('DRAFT','ARCHIVED') OR access_session_minutes IS NOT NULL
);
ALTER TABLE app.service_versions ADD CONSTRAINT service_versions_access_terms_complete CHECK (
  taxonomy <> 'ACCESS' OR access_session_minutes IS NOT NULL
) NOT VALID;
