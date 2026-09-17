-- Connected X accounts (2026-09-17). A creator signs in with X once (OAuth 2.0 + PKCE); spaca reads the account's public
-- profile a single time and keeps a copy, so buyers browsing Explore see the photo, followers and bio without any
-- further paid X API read. The copy is refreshed in the background only when someone looks at it and it is older than
-- a set age. No X access or refresh token is stored.
--
-- `source` keeps sandbox data apart from real X data everywhere: MOCK rows come from the local stand-in for X and are
-- labelled as such on every page; X_API rows come from api.x.com.

CREATE TABLE app.x_profiles (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('MOCK','X_API')),
  x_user_id text NOT NULL CHECK (x_user_id ~ '^[0-9]{1,20}$'),
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9_]{1,15}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- Only X's own image host, or the local sandbox avatar route.
  profile_image_url text CHECK (profile_image_url IS NULL OR profile_image_url ~ '^(https://pbs\.twimg\.com/|/api/dev/x/avatar/)'),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  location text NOT NULL DEFAULT '' CHECK (char_length(location) <= 100),
  verified boolean NOT NULL DEFAULT false,
  verified_type text CHECK (verified_type IS NULL OR verified_type IN ('blue','business','government','none')),
  protected boolean NOT NULL DEFAULT false,
  followers_count bigint NOT NULL CHECK (followers_count >= 0),
  following_count bigint NOT NULL CHECK (following_count >= 0),
  tweet_count bigint NOT NULL CHECK (tweet_count >= 0),
  listed_count bigint NOT NULL DEFAULT 0 CHECK (listed_count >= 0),
  x_created_at timestamptz,
  social_account_id uuid REFERENCES app.social_accounts(id) ON DELETE SET NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  fetched_at timestamptz NOT NULL,
  -- Set when someone viewed a stale copy; the refresh job clears it.
  refresh_requested_at timestamptz,
  -- X no longer returns the account (deleted, suspended or made private since connecting).
  unavailable_at timestamptz,
  refresh_failures integer NOT NULL DEFAULT 0 CHECK (refresh_failures >= 0),
  last_refresh_error text CHECK (last_refresh_error IS NULL OR char_length(last_refresh_error) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One X account belongs to one spaca account.
CREATE UNIQUE INDEX x_profiles_x_user_idx ON app.x_profiles (source, x_user_id);
CREATE INDEX x_profiles_refresh_idx ON app.x_profiles (refresh_requested_at) WHERE refresh_requested_at IS NOT NULL;

-- Single-use sign-in attempts. Only a hash of `state` is kept; the PKCE verifier never leaves the server.
CREATE TABLE app.x_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('MOCK','X_API')),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  code_verifier text NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  return_to text NOT NULL CHECK (return_to ~ '^/[^/]' AND char_length(return_to) <= 300),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX x_oauth_states_user_idx ON app.x_oauth_states (user_id, created_at);

-- Every billable X read, so spending can be capped per month and checked afterwards (X charges per profile returned).
CREATE TABLE app.x_api_usage (
  id bigserial PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('MOCK','X_API')),
  operation text NOT NULL CHECK (operation IN ('USERS_ME','USERS_LOOKUP')),
  resources integer NOT NULL CHECK (resources >= 0),
  user_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX x_api_usage_month_idx ON app.x_api_usage (source, created_at);

-- A linked X account becomes VERIFIED when its owner signs in with X (verified_by is the creator), or by an operator.
ALTER TABLE app.social_accounts ADD COLUMN verification_method text
  CHECK (verification_method IS NULL OR verification_method IN ('OPERATOR','X_OAUTH'));
ALTER TABLE app.social_accounts ADD CONSTRAINT social_accounts_oauth_self_verified
  CHECK (verification_method IS DISTINCT FROM 'X_OAUTH' OR (verification_status = 'VERIFIED' AND verified_by = creator_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.x_profiles, app.x_oauth_states TO app_server;
GRANT SELECT, INSERT ON app.x_api_usage TO app_server;
GRANT USAGE ON SEQUENCE app.x_api_usage_id_seq TO app_server;
