-- spaca waitlist: one-time setup for the Supabase SQL Editor (same as scripts/migrate.ts). Run once.
BEGIN;
create table if not exists public.waitlist_migrations (id text primary key, applied_at timestamptz not null default now());
alter table public.waitlist_migrations enable row level security;

-- spaca waitlist: one row per email. Deliberately minimal — email and role are required, the X handle is an
-- optional second step. Raw IP addresses are never stored, only a salted hash used for rate limiting.
CREATE SCHEMA IF NOT EXISTS waitlist;

CREATE TABLE waitlist.signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role text NOT NULL CHECK (role IN ('project', 'creator')),
  x_handle text CHECK (x_handle IS NULL OR x_handle ~ '^[A-Za-z0-9_]{1,15}$'),
  consent_at timestamptz NOT NULL,
  source jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source) = 'object' AND pg_column_size(source) < 2048),
  ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  update_token_hash text NOT NULL CHECK (update_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX signups_ip_recent_idx ON waitlist.signups (ip_hash, created_at);
CREATE INDEX signups_role_created_idx ON waitlist.signups (role, created_at DESC);

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

insert into public.waitlist_migrations (id) values ('0001_signups.sql'), ('0002_email_and_supabase.sql');
COMMIT;
