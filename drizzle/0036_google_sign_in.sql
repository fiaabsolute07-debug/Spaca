-- Connect Google (2026-09-17). An account connects its Google account (Gmail) from settings and can then sign in with it.
-- Sign-up stays X only (drizzle/0035). Only what spaca needs is kept: Google's account id (`sub`) and the verified email
-- Google reported; no Google token is stored.

ALTER TABLE app.user_identities DROP CONSTRAINT user_identities_provider_check;
ALTER TABLE app.user_identities DROP CONSTRAINT user_identities_source_check;
ALTER TABLE app.user_identities DROP CONSTRAINT user_identities_subject_check;
ALTER TABLE app.user_identities ADD CONSTRAINT user_identities_provider_check CHECK (provider IN ('X','GOOGLE'));
-- MOCK identities come from the local stand-ins and never match a real X or Google account.
ALTER TABLE app.user_identities ADD CONSTRAINT user_identities_source_check CHECK (
  (provider = 'X' AND source IN ('MOCK','X_API')) OR (provider = 'GOOGLE' AND source IN ('MOCK','GOOGLE_API')));
ALTER TABLE app.user_identities ADD CONSTRAINT user_identities_subject_check CHECK (
  (provider = 'X' AND subject ~ '^[0-9]{1,20}$') OR (provider = 'GOOGLE' AND subject ~ '^[0-9A-Za-z_-]{1,255}$'));
-- The address the identity provider verified (Google); shown in settings, never used to sign in by itself.
ALTER TABLE app.user_identities ADD COLUMN email text CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$'));
ALTER TABLE app.user_identities ADD CONSTRAINT user_identities_google_email CHECK (provider <> 'GOOGLE' OR email IS NOT NULL);

-- Single-use Google sign-in attempts. Only a hash of `state` is kept; the PKCE verifier never leaves the server.
CREATE TABLE app.google_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('CONNECT','SIGN_IN')),
  source text NOT NULL CHECK (source IN ('MOCK','GOOGLE_API')),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  code_verifier text NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  return_to text NOT NULL CHECK (return_to ~ '^/[^/]' AND char_length(return_to) <= 300),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Connecting always belongs to the signed-in account; a sign-in attempt has no account yet.
  CONSTRAINT google_oauth_states_owner CHECK ((purpose = 'CONNECT') = (user_id IS NOT NULL))
);
CREATE INDEX google_oauth_states_user_idx ON app.google_oauth_states (user_id, created_at);
CREATE INDEX google_oauth_states_anonymous_idx ON app.google_oauth_states (created_at) WHERE user_id IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.google_oauth_states TO app_server;
