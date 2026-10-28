-- SystemFabric 0.3.0: account lifecycle, MFA, reusable design assets, and plugin provenance.
-- Forward-only. Validate this migration on a disposable PostgreSQL instance before production.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at timestamptz;

CREATE TABLE IF NOT EXISTS identity_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('password-reset','email-verification')),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object')
);
CREATE INDEX IF NOT EXISTS identity_action_tokens_live_idx ON identity_action_tokens(purpose, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS mail_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient text NOT NULL,
  template text NOT NULL CHECK (template IN ('password-reset','email-verification','site-invitation','generic')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_outbox_pending_idx ON mail_outbox(available_at, created_at) WHERE status IN ('pending','failed');

CREATE TABLE IF NOT EXISTS user_mfa_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext text NOT NULL,
  pending_secret boolean NOT NULL DEFAULT true,
  last_used_step bigint NOT NULL DEFAULT -1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_mfa_recovery_codes_live_idx ON user_mfa_recovery_codes(user_id) WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_mfa_challenges_expiry_idx ON auth_mfa_challenges(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS site_design_systems (
  site_id uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tokens)='object'),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reusable_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,100}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,slug)
);
CREATE TABLE IF NOT EXISTS site_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,100}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  template_type text NOT NULL CHECK (template_type IN ('single','archive','header','footer','404','search','page')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  active boolean NOT NULL DEFAULT false,
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,slug)
);
CREATE UNIQUE INDEX IF NOT EXISTS site_templates_one_active_type_idx ON site_templates(site_id,template_type) WHERE active=true;
CREATE TABLE IF NOT EXISTS navigation_menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,100}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items)='array'),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,slug)
);

ALTER TABLE plugin_installs ADD COLUMN IF NOT EXISTS artifact_digest char(64);
ALTER TABLE plugin_installs ADD COLUMN IF NOT EXISTS sbom_reference text;
ALTER TABLE plugin_installs ADD COLUMN IF NOT EXISTS sbom_digest char(64);
ALTER TABLE plugin_installs ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance)='object');
ALTER TABLE plugin_installs ADD COLUMN IF NOT EXISTS signature_verified boolean NOT NULL DEFAULT false;
ALTER TABLE plugin_installs ADD COLUMN IF NOT EXISTS security_reviewed_at timestamptz;
ALTER TABLE plugin_installs ADD COLUMN IF NOT EXISTS security_reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Existing bootstrap-owner accounts are created by an explicit first-run owner operation.
-- Do not silently mark other accounts as email-verified.

CREATE TABLE IF NOT EXISTS auth_oidc_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash char(64) NOT NULL UNIQUE,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  issuer text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_oidc_states_expiry_idx ON auth_oidc_states(expires_at) WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS user_external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(issuer,subject),
  UNIQUE(user_id,issuer)
);
CREATE INDEX IF NOT EXISTS user_external_identities_user_idx ON user_external_identities(user_id);
