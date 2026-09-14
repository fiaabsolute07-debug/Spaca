-- P6 PUBLISH, self-reported social accounts and content reports (master §5.2 SocialAccount, §5.5 Report,
-- §16.9 P6-01/P6-02/P6-07; XPL-01, XPL-02, MOD-01, MOD-02). No social network API is called anywhere (SUP-06).

-- 1. Social accounts: creator-entered links are SELF_REPORTED; VERIFIED needs a verification method that
-- does not exist yet, so nothing can claim it except an audited operator action.
CREATE TABLE app.social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('X','INSTAGRAM','TIKTOK','YOUTUBE','NEWSLETTER','WEBSITE')),
  handle text CHECK (handle IS NULL OR char_length(handle) BETWEEN 1 AND 64),
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https://' AND char_length(canonical_url) <= 500),
  verification_status text NOT NULL DEFAULT 'SELF_REPORTED' CHECK (verification_status IN ('SELF_REPORTED','VERIFIED')),
  verified_at timestamptz,
  verified_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','OPERATOR')),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_accounts_verified_fields CHECK ((verification_status = 'VERIFIED') = (verified_at IS NOT NULL AND verified_by IS NOT NULL)),
  CONSTRAINT social_accounts_id_creator_key UNIQUE (id, creator_id)
);
-- One live claim per canonical account across the marketplace; a removed link can be added again.
CREATE UNIQUE INDEX social_accounts_canonical_live_idx ON app.social_accounts (platform, lower(canonical_url)) WHERE removed_at IS NULL;
CREATE INDEX social_accounts_creator_idx ON app.social_accounts (creator_id) WHERE removed_at IS NULL;

-- The legacy single profile link becomes a self-reported WEBSITE/X account.
INSERT INTO app.social_accounts (creator_id, platform, handle, canonical_url)
SELECT p.user_id,
       CASE WHEN p.social_url ~* '^https?://(www\.)?(x|twitter)\.com/[A-Za-z0-9_]{1,15}/?$' THEN 'X' ELSE 'WEBSITE' END,
       CASE WHEN p.social_url ~* '^https?://(www\.)?(x|twitter)\.com/[A-Za-z0-9_]{1,15}/?$'
            THEN lower(substring(p.social_url from '(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})')) END,
       CASE WHEN p.social_url ~* '^https?://(www\.)?(x|twitter)\.com/[A-Za-z0-9_]{1,15}/?$'
            THEN 'https://x.com/' || lower(substring(p.social_url from '(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})'))
            ELSE regexp_replace(p.social_url, '^http://', 'https://') END
FROM app.profiles p
WHERE p.social_url IS NOT NULL AND p.social_url ~* '^https?://'
ON CONFLICT DO NOTHING;

-- 2. PUBLISH terms live on the service and are snapshotted on every immutable version.
ALTER TABLE app.services ADD COLUMN publish_account_id uuid;
ALTER TABLE app.services ADD COLUMN publish_format text CHECK (publish_format IS NULL OR publish_format IN ('POST','THREAD','QUOTE_POST','VIDEO','NEWSLETTER_ISSUE','ARTICLE'));
ALTER TABLE app.services ADD COLUMN min_live_hours integer CHECK (min_live_hours IS NULL OR min_live_hours BETWEEN 0 AND 2160);
ALTER TABLE app.services ADD COLUMN disclosure_text text CHECK (disclosure_text IS NULL OR char_length(disclosure_text) BETWEEN 2 AND 80);
ALTER TABLE app.services ADD CONSTRAINT services_publish_account_owner_fk FOREIGN KEY (publish_account_id, creator_id) REFERENCES app.social_accounts (id, creator_id);
-- Legacy PUBLISH listings were sold without channel terms; they go back to DRAFT until the creator adds them.
-- Their versions and existing orders are untouched.
UPDATE app.services SET status = 'DRAFT', version = version + 1, updated_at = now() WHERE taxonomy = 'PUBLISH' AND status <> 'DRAFT' AND status <> 'ARCHIVED';
ALTER TABLE app.services ADD CONSTRAINT services_publish_terms_complete CHECK (
  taxonomy <> 'PUBLISH' OR status IN ('DRAFT','ARCHIVED') OR (publish_account_id IS NOT NULL AND publish_format IS NOT NULL AND min_live_hours IS NOT NULL AND disclosure_text IS NOT NULL)
);

ALTER TABLE app.service_versions ADD COLUMN publish_account_id uuid REFERENCES app.social_accounts(id) ON DELETE RESTRICT;
ALTER TABLE app.service_versions ADD COLUMN publish_platform text;
ALTER TABLE app.service_versions ADD COLUMN publish_handle text;
ALTER TABLE app.service_versions ADD COLUMN publish_url text;
ALTER TABLE app.service_versions ADD COLUMN publish_format text;
ALTER TABLE app.service_versions ADD COLUMN min_live_hours integer;
ALTER TABLE app.service_versions ADD COLUMN disclosure_text text;
-- NOT VALID: versions are immutable history; the rule applies to every version created from now on.
ALTER TABLE app.service_versions ADD CONSTRAINT service_versions_publish_terms_complete CHECK (
  taxonomy <> 'PUBLISH' OR (publish_account_id IS NOT NULL AND publish_platform IS NOT NULL AND publish_url IS NOT NULL
    AND publish_format IS NOT NULL AND min_live_hours IS NOT NULL AND disclosure_text IS NOT NULL)
) NOT VALID;

-- Requests for PUBLISH work carry the posting terms; each applicant names the channel they will post on.
ALTER TABLE app.requests ADD COLUMN publish_platform text CHECK (publish_platform IS NULL OR publish_platform IN ('X','INSTAGRAM','TIKTOK','YOUTUBE','NEWSLETTER','WEBSITE'));
ALTER TABLE app.requests ADD COLUMN publish_format text CHECK (publish_format IS NULL OR publish_format IN ('POST','THREAD','QUOTE_POST','VIDEO','NEWSLETTER_ISSUE','ARTICLE'));
ALTER TABLE app.requests ADD COLUMN min_live_hours integer CHECK (min_live_hours IS NULL OR min_live_hours BETWEEN 0 AND 2160);
ALTER TABLE app.requests ADD COLUMN disclosure_text text CHECK (disclosure_text IS NULL OR char_length(disclosure_text) BETWEEN 2 AND 80);
-- Existing PUBLISH requests get the default posting terms (an X post, live 72 hours, "#ad"); their buyers can edit them.
UPDATE app.requests SET publish_platform = 'X', publish_format = 'POST', min_live_hours = 72, disclosure_text = '#ad' WHERE taxonomy = 'PUBLISH';
ALTER TABLE app.requests ADD CONSTRAINT requests_publish_terms_complete CHECK (
  taxonomy <> 'PUBLISH' OR (publish_platform IS NOT NULL AND publish_format IS NOT NULL AND min_live_hours IS NOT NULL AND disclosure_text IS NOT NULL)
);
ALTER TABLE app.applications ADD COLUMN publish_account_id uuid REFERENCES app.social_accounts(id) ON DELETE RESTRICT;
ALTER TABLE app.application_versions ADD COLUMN publish_account_id uuid REFERENCES app.social_accounts(id) ON DELETE RESTRICT;

-- 3. Publication proof for a delivery (XPL-02): the post link, when it went live and the disclosure attestation.
-- Checked only against the sold channel (host and handle); content is never fetched from the platform.
CREATE TABLE app.publish_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  platform text NOT NULL,
  channel_url text NOT NULL,
  post_url text NOT NULL CHECK (post_url ~ '^https://' AND char_length(post_url) <= 1000),
  post_id text CHECK (post_id IS NULL OR char_length(post_id) <= 64),
  published_at timestamptz NOT NULL,
  disclosure_text text NOT NULL,
  disclosure_attested boolean NOT NULL CHECK (disclosure_attested),
  link_check text NOT NULL CHECK (link_check IN ('MATCHES_CHANNEL','SAME_PLATFORM')),
  late boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publish_proofs_delivery_key UNIQUE (delivery_id),
  FOREIGN KEY (delivery_id, order_id) REFERENCES app.deliveries (id, order_id) ON DELETE RESTRICT
);
CREATE INDEX publish_proofs_order_idx ON app.publish_proofs (order_id, created_at DESC);
CREATE TRIGGER publish_proofs_immutable BEFORE UPDATE OR DELETE ON app.publish_proofs FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- 4. Reports and moderation queue (MOD-01, P6-07). Evidence is kept; resolution needs an operator and a reason.
CREATE TABLE app.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('USER','POLICY_CHECK')),
  target_type text NOT NULL CHECK (target_type IN ('REQUEST','ORDER','SERVICE','PROFILE','SAMPLE','PUBLISH_PROOF')),
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('UNDISCLOSED_PROMOTION','FAKE_ENGAGEMENT','GUARANTEED_RETURNS','DECEPTIVE_SCRIPT','IMPERSONATION','POST_REMOVED_EARLY','SPAM','OTHER')),
  details text NOT NULL CHECK (char_length(details) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','ACTIONED','DISMISSED')),
  assigned_to uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  resolution text CHECK (resolution IS NULL OR char_length(resolution) BETWEEN 10 AND 2000),
  action text CHECK (action IS NULL OR action IN ('NONE','CLOSE_REQUEST','PAUSE_SERVICE','REJECT_SAMPLE','SUSPEND_USER')),
  resolved_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_resolution_fields CHECK ((status IN ('ACTIONED','DISMISSED')) = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL AND action IS NOT NULL)),
  CONSTRAINT reports_user_source_reporter CHECK (source <> 'USER' OR reporter_id IS NOT NULL)
);
CREATE INDEX reports_open_idx ON app.reports (status, created_at) WHERE status IN ('OPEN','ASSIGNED');
CREATE INDEX reports_target_idx ON app.reports (target_type, target_id);
-- One open report per reporter, target and reason; repeated clicks do not flood the queue.
CREATE UNIQUE INDEX reports_open_dedupe_idx ON app.reports (coalesce(reporter_id, '00000000-0000-0000-0000-000000000000'::uuid), target_type, target_id, reason) WHERE status IN ('OPEN','ASSIGNED');

GRANT SELECT, INSERT, UPDATE ON app.social_accounts, app.publish_proofs, app.reports TO app_server;
