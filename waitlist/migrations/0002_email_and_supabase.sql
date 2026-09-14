-- Onboarding email tracking, a longer-lived handle token for the email link, and Supabase hardening.

ALTER TABLE waitlist.signups
  ADD COLUMN welcome_email_status text NOT NULL DEFAULT 'PENDING'
    CHECK (welcome_email_status IN ('PENDING', 'SENT', 'PREVIEWED', 'FAILED', 'SKIPPED')),
  ADD COLUMN welcome_email_id text,
  ADD COLUMN welcome_email_sent_at timestamptz,
  ADD COLUMN welcome_email_error text CHECK (welcome_email_error IS NULL OR char_length(welcome_email_error) <= 300);

-- Signups created before this migration never get an automatic welcome email.
UPDATE waitlist.signups SET welcome_email_status = 'SKIPPED' WHERE created_at < now();

CREATE INDEX signups_email_status_idx ON waitlist.signups (welcome_email_status, created_at);

-- Supabase: the table lives outside the `public` schema (not exposed by the Data API by default). RLS stays
-- enabled with no policies, and the browser-facing roles get no grants, so only the server connection reads or writes.
ALTER TABLE waitlist.signups ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA waitlist FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA waitlist FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA waitlist FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA waitlist FROM authenticated';
  END IF;
END $$;
