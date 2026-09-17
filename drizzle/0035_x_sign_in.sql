-- Sign up with X (2026-09-17). New accounts are created by signing in with X; an email and password can be added later
-- from the account's settings. So an account may have no email, and an X account can be how someone signs in.
--
-- app.user_identities maps an X user id to the spaca account it signs in to. It is kept in step with app.x_profiles:
-- written when X is connected or used to sign up, removed when X is disconnected. The application refuses to remove the
-- last way into an account (an X identity without an email and password).

ALTER TABLE app.users ALTER COLUMN email DROP NOT NULL;

CREATE TABLE app.user_identities (
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('X')),
  -- MOCK identities come from the local stand-in for X and never match a real X account.
  source text NOT NULL CHECK (source IN ('MOCK','X_API')),
  subject text NOT NULL CHECK (subject ~ '^[0-9]{1,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  PRIMARY KEY (user_id, provider),
  UNIQUE (provider, source, subject)
);

-- Accounts that already connected X can sign in with it too.
INSERT INTO app.user_identities (user_id, provider, source, subject, created_at)
SELECT user_id, 'X', source, x_user_id, connected_at FROM app.x_profiles
ON CONFLICT DO NOTHING;

-- A sign-in or sign-up attempt has no account yet; connecting X from settings always has one.
ALTER TABLE app.x_oauth_states ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE app.x_oauth_states ADD COLUMN purpose text NOT NULL DEFAULT 'CONNECT' CHECK (purpose IN ('CONNECT','SIGN_IN','SIGN_UP'));
ALTER TABLE app.x_oauth_states ADD COLUMN account_type text CHECK (account_type IS NULL OR account_type IN ('buyer','creator'));
ALTER TABLE app.x_oauth_states ADD CONSTRAINT x_oauth_states_owner CHECK ((purpose = 'CONNECT') = (user_id IS NOT NULL));
ALTER TABLE app.x_oauth_states ADD CONSTRAINT x_oauth_states_signup_type CHECK ((purpose = 'SIGN_UP') = (account_type IS NOT NULL));
CREATE INDEX x_oauth_states_anonymous_idx ON app.x_oauth_states (created_at) WHERE user_id IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.user_identities TO app_server;
