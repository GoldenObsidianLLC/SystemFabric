-- Shared, expiring SAML request/assertion cache. Cache keys are issuer-prefixed hashes.
-- SQL DELETE .. RETURNING provides atomic InResponseTo consumption across API replicas.
CREATE TABLE IF NOT EXISTS auth_saml_request_cache (
  cache_key text PRIMARY KEY,
  cache_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (length(cache_key) BETWEEN 1 AND 100),
  CHECK (length(cache_value) BETWEEN 1 AND 4096),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS auth_saml_request_cache_expiry_idx ON auth_saml_request_cache(expires_at);
