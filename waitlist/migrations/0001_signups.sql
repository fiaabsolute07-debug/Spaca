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
