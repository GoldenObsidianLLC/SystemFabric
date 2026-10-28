-- SystemFabric 0.3.0 hardening: AI governance, daily tenant budgets, and taxonomy soft deletion.
-- Validate against the supported PostgreSQL version before production deployment.

ALTER TABLE taxonomy_terms ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS taxonomy_terms_site_taxonomy_idx ON taxonomy_terms(site_id, taxonomy, label) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS site_ai_policies (
  site_id uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  allow_external_content boolean NOT NULL DEFAULT false,
  allowed_providers jsonb NOT NULL DEFAULT '["mock"]'::jsonb CHECK (jsonb_typeof(allowed_providers)='array'),
  max_data_classification text NOT NULL DEFAULT 'public' CHECK (max_data_classification IN ('public','internal','confidential')),
  daily_request_limit integer NOT NULL DEFAULT 200 CHECK (daily_request_limit BETWEEN 1 AND 100000),
  daily_input_chars_limit integer NOT NULL DEFAULT 200000 CHECK (daily_input_chars_limit BETWEEN 1000 AND 100000000),
  require_human_review boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  input_chars bigint NOT NULL DEFAULT 0 CHECK (input_chars >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id, usage_date)
);
CREATE INDEX IF NOT EXISTS ai_usage_daily_date_idx ON ai_usage_daily(usage_date DESC);

-- One-time seeds for existing sites; provider execution remains limited to mock until an owner opts in.
INSERT INTO site_ai_policies(site_id) SELECT id FROM sites ON CONFLICT(site_id) DO NOTHING;
