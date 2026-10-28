-- Identity sessions, workflow history, durable published snapshots, and plugin registry.
-- Apply with `npm run migrate`; this is a forward-only migration.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent_hash char(64),
  ip_hash char(64)
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_live_idx ON auth_sessions(expires_at) WHERE revoked_at IS NULL;

ALTER TABLE content_items ADD COLUMN IF NOT EXISTS published_snapshot jsonb;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS published_version integer;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS lock_version integer NOT NULL DEFAULT 1;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

UPDATE content_items
SET published_snapshot = jsonb_build_object(
  'title', title,
  'slug', slug,
  'locale', locale,
  'contentType', content_type,
  'status', 'published',
  'document', body,
  'version', version
), published_version = COALESCE(published_version, version)
WHERE status = 'published' AND published_snapshot IS NULL;

ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_status_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_status_check
  CHECK (status IN ('draft', 'in_review', 'approved', 'scheduled', 'published', 'archived', 'deleted'));

DROP INDEX IF EXISTS content_items_route_unique;
CREATE UNIQUE INDEX IF NOT EXISTS content_items_route_unique
  ON content_items(site_id, content_type, locale, slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS content_items_published_route_unique
  ON content_items(site_id, content_type, (published_snapshot->>'locale'), (published_snapshot->>'slug'))
  WHERE published_snapshot IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS content_items_due_publication_idx
  ON content_items(scheduled_at) WHERE status = 'scheduled' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  content_version integer NOT NULL,
  action text NOT NULL CHECK (action IN ('draft_saved','submitted_for_review','approved','rejected','scheduled','published','unpublished','archived','restored')),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_events_content_idx ON workflow_events(site_id, content_id, created_at DESC);

CREATE TABLE IF NOT EXISTS plugin_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9._-]{1,99}$'),
  version text NOT NULL,
  api_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','active','disabled','rejected','error')),
  source_type text NOT NULL CHECK (source_type IN ('npm-archive','oci-image')),
  package_sha256 char(64),
  image_digest text,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  requested_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(requested_capabilities) = 'array'),
  approved_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(approved_capabilities) = 'array'),
  installed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name)
);
CREATE INDEX IF NOT EXISTS plugin_installs_site_status_idx ON plugin_installs(site_id, status);

CREATE TABLE IF NOT EXISTS plugin_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  plugin_id uuid NOT NULL REFERENCES plugin_installs(id) ON DELETE CASCADE,
  action text NOT NULL,
  result text NOT NULL CHECK (result IN ('success','timeout','rejected','failure')),
  elapsed_ms integer NOT NULL DEFAULT 0,
  request_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plugin_invocations_plugin_idx ON plugin_invocations(site_id, plugin_id, created_at DESC);

-- Capabilities remain declarative and are enforced by the application on each request.
UPDATE roles SET capabilities = capabilities || '["content:approve","content:archive","plugins:read"]'::jsonb
WHERE slug = 'site-owner' AND NOT (capabilities @> '["content:approve"]'::jsonb);
UPDATE roles SET capabilities = capabilities || '["content:approve","plugins:read"]'::jsonb
WHERE slug = 'editor' AND NOT (capabilities @> '["content:approve"]'::jsonb);
UPDATE roles SET capabilities = capabilities || '["content:submit-review"]'::jsonb
WHERE slug IN ('author', 'editor', 'site-owner') AND NOT (capabilities @> '["content:submit-review"]'::jsonb);

ALTER TABLE content_items ADD COLUMN IF NOT EXISTS published_search_vector tsvector NOT NULL DEFAULT ''::tsvector;
UPDATE content_items SET published_search_vector = to_tsvector('simple', COALESCE(published_snapshot->>'title','') || ' ' || COALESCE(published_snapshot->>'slug',''))
WHERE published_snapshot IS NOT NULL AND published_search_vector = ''::tsvector;
CREATE INDEX IF NOT EXISTS content_items_published_search_idx ON content_items USING GIN(published_search_vector);

CREATE TABLE IF NOT EXISTS site_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email text NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id),
  token_hash char(64) NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS site_invitations_active_email_unique
  ON site_invitations(site_id, lower(email)) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS site_invitations_expiry_idx ON site_invitations(expires_at) WHERE accepted_at IS NULL;

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS publicly_accessible boolean NOT NULL DEFAULT true;
