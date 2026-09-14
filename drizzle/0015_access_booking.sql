-- P6 ACCESS time-slot booking (master §6.5, §16.9 P6-03; XPL-03, CAP-11). Sessions are UTC instants; the creator's
-- weekly availability is local time in their zone. A GiST exclusion constraint makes overlapping sessions (including
-- the buffer after each session) impossible for one creator, whatever the application does.

ALTER TABLE app.services ADD COLUMN access_session_minutes integer CHECK (access_session_minutes IS NULL OR access_session_minutes BETWEEN 15 AND 480);
ALTER TABLE app.services ADD COLUMN access_buffer_minutes integer CHECK (access_buffer_minutes IS NULL OR access_buffer_minutes BETWEEN 0 AND 120);
ALTER TABLE app.services ADD COLUMN access_cancel_notice_hours integer CHECK (access_cancel_notice_hours IS NULL OR access_cancel_notice_hours BETWEEN 0 AND 168);
ALTER TABLE app.services ADD COLUMN access_no_show_minutes integer CHECK (access_no_show_minutes IS NULL OR access_no_show_minutes BETWEEN 5 AND 60);
UPDATE app.services SET status = 'DRAFT', version = version + 1, updated_at = now() WHERE taxonomy = 'ACCESS' AND status IN ('PUBLISHED','PAUSED');
ALTER TABLE app.services ADD CONSTRAINT services_access_terms_complete CHECK (
  taxonomy <> 'ACCESS' OR status IN ('DRAFT','ARCHIVED')
  OR (access_session_minutes IS NOT NULL AND access_buffer_minutes IS NOT NULL AND access_cancel_notice_hours IS NOT NULL AND access_no_show_minutes IS NOT NULL)
);

ALTER TABLE app.service_versions ADD COLUMN access_session_minutes integer;
ALTER TABLE app.service_versions ADD COLUMN access_buffer_minutes integer;
ALTER TABLE app.service_versions ADD COLUMN access_cancel_notice_hours integer;
ALTER TABLE app.service_versions ADD COLUMN access_no_show_minutes integer;
ALTER TABLE app.service_versions ADD CONSTRAINT service_versions_access_terms_complete CHECK (
  taxonomy <> 'ACCESS' OR (access_session_minutes IS NOT NULL AND access_buffer_minutes IS NOT NULL AND access_cancel_notice_hours IS NOT NULL AND access_no_show_minutes IS NOT NULL)
) NOT VALID;

CREATE TABLE app.availability_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_windows_order CHECK (end_minute > start_minute)
);
CREATE INDEX availability_windows_creator_idx ON app.availability_windows (creator_id, weekday);

CREATE TABLE app.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES app.orders(id) ON DELETE RESTRICT,
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  buffer_minutes integer NOT NULL CHECK (buffer_minutes BETWEEN 0 AND 120),
  -- The session plus the buffer after it; set by trigger so the exclusion constraint sees exactly what the rule says.
  blocked_until timestamptz NOT NULL,
  creator_time_zone text NOT NULL,
  cancel_notice_hours integer NOT NULL,
  no_show_minutes integer NOT NULL,
  -- Private to the two parties (P6-03); never part of public reads or the terms snapshot.
  meeting_url text CHECK (meeting_url IS NULL OR (meeting_url ~ '^https://' AND char_length(meeting_url) <= 1000)),
  state text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD','BOOKED','COMPLETED','NO_SHOW_BUYER','NO_SHOW_CREATOR','CANCELLED')),
  outcome_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  outcome_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_interval CHECK (ends_at > starts_at),
  CONSTRAINT appointments_no_overlap EXCLUDE USING gist (creator_id WITH =, tstzrange(starts_at, blocked_until, '[)') WITH &&) WHERE (state IN ('HELD','BOOKED'))
);
CREATE INDEX appointments_creator_upcoming_idx ON app.appointments (creator_id, starts_at) WHERE state IN ('HELD','BOOKED');

CREATE OR REPLACE FUNCTION app.appointment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.creator_id IS DISTINCT FROM OLD.creator_id OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
       OR NEW.ends_at IS DISTINCT FROM OLD.ends_at OR NEW.buffer_minutes IS DISTINCT FROM OLD.buffer_minutes THEN
      RAISE EXCEPTION 'appointment time and parties are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
         (OLD.state = 'HELD' AND NEW.state IN ('BOOKED','CANCELLED'))
      OR (OLD.state = 'BOOKED' AND NEW.state IN ('COMPLETED','NO_SHOW_BUYER','NO_SHOW_CREATOR','CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'invalid appointment transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
  END IF;
  NEW.blocked_until := NEW.ends_at + (NEW.buffer_minutes * interval '1 minute');
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_guard BEFORE INSERT OR UPDATE ON app.appointments FOR EACH ROW EXECUTE FUNCTION app.appointment_guard();
CREATE TRIGGER appointments_no_delete BEFORE DELETE ON app.appointments FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Funding books the held slot; cancellation or refund frees it (like workload claims, exactly once).
CREATE OR REPLACE FUNCTION app.order_appointment_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  IF NEW.status = 'FUNDED' THEN
    UPDATE app.appointments SET state = 'BOOKED' WHERE order_id = NEW.id AND state = 'HELD';
  ELSIF NEW.status IN ('CANCELLED','REFUNDED') THEN
    UPDATE app.appointments SET state = 'CANCELLED' WHERE order_id = NEW.id AND state IN ('HELD','BOOKED');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER orders_appointment_sync AFTER UPDATE OF status ON app.orders FOR EACH ROW EXECUTE FUNCTION app.order_appointment_sync();

GRANT SELECT, INSERT, UPDATE, DELETE ON app.availability_windows TO app_server;
GRANT SELECT, INSERT, UPDATE ON app.appointments TO app_server;
