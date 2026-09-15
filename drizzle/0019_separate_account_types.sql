-- Buyer and creator accounts are separate (user decision 2026-09-15). New real accounts hold exactly one of the two
-- roles; local/test accounts (is_test) may keep both so older fixtures and suites still run. NOT VALID: existing rows
-- are left as they are, every new or updated row is checked.
ALTER TABLE app.users ADD CONSTRAINT users_single_account_type
  CHECK (is_test OR NOT (roles @> ARRAY['buyer','creator']::text[])) NOT VALID;
