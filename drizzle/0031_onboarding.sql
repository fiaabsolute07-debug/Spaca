-- Onboarding (2026-09-16): a new account adds a photo, its name (project or creator) and a short introduction before
-- anything it does is seen by others. onboarded_at is null only for accounts created through sign-up that have not
-- finished setup. Every account that existed before onboarding, and accounts made another way (fixtures, operators),
-- count as set up: the column default fills them in.
ALTER TABLE app.users ADD COLUMN onboarded_at timestamptz DEFAULT now();
