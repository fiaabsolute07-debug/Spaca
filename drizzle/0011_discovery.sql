-- W6-D: discovery (master §16.8 P5-01..07; DSC-01..06). PostgreSQL full-text search on the published immutable
-- version and creator profiles, indexes for filters/sorts and trending inputs, and rate-limited eligible views.
-- The 'simple' configuration avoids language-specific stemming (content is multilingual, e.g. Vietnamese).

ALTER TABLE app.service_versions ADD COLUMN search_document tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(taxonomy, '')), 'C')
) STORED;
CREATE INDEX service_versions_search_idx ON app.service_versions USING gin (search_document);
CREATE INDEX service_versions_filter_idx ON app.service_versions (taxonomy, price_minor, turnaround_hours);
CREATE INDEX service_versions_created_idx ON app.service_versions (created_at DESC, id);

ALTER TABLE app.profiles ADD COLUMN search_document tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(handle, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(niche, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(bio, '')), 'B')
) STORED;
CREATE INDEX profiles_search_idx ON app.profiles USING gin (search_document);
CREATE INDEX profiles_niche_idx ON app.profiles (lower(niche));

CREATE INDEX services_published_idx ON app.services (published_version_id) WHERE status = 'PUBLISHED';
CREATE INDEX capacity_buckets_free_idx ON app.capacity_buckets (pool_id, starts_at) WHERE reserved_units + committed_units < total_units;
CREATE INDEX orders_completed_service_idx ON app.orders (service_id, completed_at) WHERE status = 'COMPLETED';
CREATE INDEX orders_completed_creator_idx ON app.orders (creator_id, completed_at) WHERE status = 'COMPLETED';
CREATE INDEX reviews_creator_idx ON app.reviews (creator_id, created_at);
CREATE INDEX auctions_ending_idx ON app.auctions (ends_at, id) WHERE status IN ('SCHEDULED','LIVE');

-- Eligible views (P5-04): one per viewer per service per day, owner views excluded by the writer; raw identifiers are
-- never stored, only a salted hash.
CREATE TABLE app.service_views (
  service_id uuid NOT NULL REFERENCES app.services(id) ON DELETE CASCADE,
  viewer_hash text NOT NULL CHECK (viewer_hash ~ '^[0-9a-f]{64}$'),
  view_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, viewer_hash, view_date)
);
CREATE INDEX service_views_recent_idx ON app.service_views (view_date, service_id);
CREATE INDEX service_views_viewer_idx ON app.service_views (viewer_hash, view_date);

GRANT SELECT, INSERT ON app.service_views TO app_server;
