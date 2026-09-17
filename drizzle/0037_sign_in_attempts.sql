-- Password sign-in throttling (2026-09-17, before launch with first-party sessions). Failed email/password sign-ins are
-- counted per address (only a hash is kept) so guessing a password is slowed down. A sign-in drops that address's
-- attempts older than a day.

CREATE TABLE app.sign_in_attempts (
  id bigserial PRIMARY KEY,
  email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sign_in_attempts_email_idx ON app.sign_in_attempts (email_hash, created_at);

GRANT SELECT, INSERT, DELETE ON app.sign_in_attempts TO app_server;
GRANT USAGE ON SEQUENCE app.sign_in_attempts_id_seq TO app_server;
