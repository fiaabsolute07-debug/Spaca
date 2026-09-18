-- Sign up with Google (2026-09-18). Until now an account could only be created by signing up with X (drizzle/0035),
-- and Google (drizzle/0036) could only be connected afterwards. A Google sign-up carries the same two things an X
-- sign-up does: the purpose it started with, and the account type chosen before leaving spaca.

ALTER TABLE app.google_oauth_states DROP CONSTRAINT google_oauth_states_purpose_check;
ALTER TABLE app.google_oauth_states ADD CONSTRAINT google_oauth_states_purpose_check CHECK (purpose IN ('CONNECT','SIGN_IN','SIGN_UP'));
-- Each account is one type, chosen in the sign-up dialog before Google's account chooser opens.
ALTER TABLE app.google_oauth_states ADD COLUMN account_type text CHECK (account_type IS NULL OR account_type IN ('buyer','creator'));
ALTER TABLE app.google_oauth_states ADD CONSTRAINT google_oauth_states_signup_type CHECK ((purpose = 'SIGN_UP') = (account_type IS NOT NULL));
