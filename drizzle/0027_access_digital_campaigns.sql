-- Campaigns for live sessions and for licensed files (master §9.2): until now a buyer could only ask for content
-- (CREATE) or a post (PUBLISH), because the terms an ACCESS or DIGITAL hire needs were nowhere on the campaign.
--
-- ACCESS states how long the session is; the time itself is agreed in the order messages, as it is for a booked
-- session. DIGITAL states what the buyer may do with the files, which is the whole of what they are paying for. Both
-- are frozen into the order terms at hire, so a campaign edited afterwards cannot change what was agreed.
--
-- A commissioned file is not a product listing: there is no stock, no release history and no download limit here.
-- Those belong to app.digital_releases and app.digital_entitlements, which a campaign never touches.

ALTER TABLE app.requests ADD COLUMN access_session_minutes integer
  CHECK (access_session_minutes IS NULL OR access_session_minutes BETWEEN 15 AND 480);
ALTER TABLE app.requests ADD COLUMN license_kind text
  CHECK (license_kind IS NULL OR license_kind IN ('NON_EXCLUSIVE','EXCLUSIVE'));
ALTER TABLE app.requests ADD COLUMN license_rights_text text
  CHECK (license_rights_text IS NULL OR length(license_rights_text) BETWEEN 20 AND 4000);

-- The terms exist exactly for the category that needs them, never for another.
ALTER TABLE app.requests ADD CONSTRAINT requests_access_complete
  CHECK ((taxonomy = 'ACCESS') = (access_session_minutes IS NOT NULL));
ALTER TABLE app.requests ADD CONSTRAINT requests_license_complete
  CHECK ((taxonomy = 'DIGITAL') = (license_kind IS NOT NULL AND license_rights_text IS NOT NULL));
