-- SystemFabric schema baseline v1.
-- Apply in a maintenance window after testing this migration against a disposable database.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  default_locale text NOT NULL DEFAULT 'en',
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 180),
  password_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  mfa_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array')
);

CREATE TABLE IF NOT EXISTS site_memberships (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, user_id, role_id)
);

CREATE TABLE IF NOT EXISTS content_type_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_-]{0,62}$'),
  label text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  source text NOT NULL CHECK (source IN ('git', 'admin')),
  active boolean NOT NULL DEFAULT true,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, slug, version)
);

CREATE TABLE IF NOT EXISTS content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  content_type text NOT NULL DEFAULT 'page',
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-_/]{0,240}$'),
  locale text NOT NULL DEFAULT 'en',
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'scheduled', 'published', 'archived', 'deleted')),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  scheduled_at timestamptz,
  search_vector tsvector NOT NULL DEFAULT ''::tsvector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS content_items_route_unique
  ON content_items(site_id, content_type, locale, slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS content_items_status_idx ON content_items(site_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS content_items_search_idx ON content_items USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS content_items_body_idx ON content_items USING GIN(body jsonb_path_ops);

CREATE TABLE IF NOT EXISTS content_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  change_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, version)
);

CREATE TABLE IF NOT EXISTS taxonomy_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  taxonomy text NOT NULL,
  slug text NOT NULL,
  label text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (site_id, taxonomy, slug)
);

-- Canonical relationship rows live in PostgreSQL so the graph projection can be rebuilt.
CREATE TABLE IF NOT EXISTS content_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('HAS_TERM', 'PARENT_OF', 'RELATED_TO', 'LOCALIZED_AS', 'NAVIGATES_TO')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (source_id <> target_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS content_relationships_unique_live_idx ON content_relationships(site_id, source_id, target_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS content_relationships_source_idx ON content_relationships(site_id, source_id, kind);
CREATE INDEX IF NOT EXISTS content_relationships_target_idx ON content_relationships(site_id, target_id, kind);

CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  width integer,
  height integer,
  alt_text text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, storage_key)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (aggregate_type, aggregate_id, aggregate_version, event_type)
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(status, available_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS ai_run_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  action text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'blocked')),
  latency_ms integer NOT NULL DEFAULT 0,
  input_chars integer NOT NULL DEFAULT 0,
  output_chars integer NOT NULL DEFAULT 0,
  estimated_input_tokens integer,
  estimated_output_tokens integer,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_run_audit_site_date_idx ON ai_run_audit(site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id uuid,
  result text NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_site_date_idx ON audit_events(site_id, created_at DESC);

-- Default permissions are seeds only. The application must enforce capabilities on every request.
INSERT INTO roles (slug, label, capabilities) VALUES
  ('site-owner', 'Site Owner', '["site:manage","content:read","content:create","content:edit","content:review","content:publish","media:manage","plugins:manage","ai:use","ai:approve"]'::jsonb),
  ('editor', 'Editor', '["content:read","content:create","content:edit","content:review","media:manage","ai:use"]'::jsonb),
  ('author', 'Author', '["content:read:own","content:create","content:edit:own","ai:use"]'::jsonb),
  ('viewer', 'Viewer', '["content:read"]'::jsonb)
ON CONFLICT (slug) DO NOTHING;
