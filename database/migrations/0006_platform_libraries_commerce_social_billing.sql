-- SystemFabric 0.4.0: media/document/file libraries, commerce, communities, billing, and security.
-- PostgreSQL is the source of truth. Do not store cardholder data in SystemFabric.

CREATE TABLE IF NOT EXISTS library_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  asset_kind text NOT NULL CHECK (asset_kind IN ('image','video','audio','document','file','font')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 240),
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 240),
  storage_provider text NOT NULL DEFAULT 'local' CHECK (storage_provider IN ('local','s3','gcs','azure','s3-compatible')),
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 char(64) NOT NULL,
  alt_text text NOT NULL DEFAULT '' CHECK (length(alt_text) <= 1000),
  caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 4000),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 12000),
  is_public boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','deleted')),
  optimization_status text NOT NULL DEFAULT 'pending' CHECK (optimization_status IN ('pending','processing','optimized','skipped','failed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(site_id, storage_key)
);
CREATE INDEX IF NOT EXISTS library_assets_site_kind_created_idx ON library_assets(site_id,asset_kind,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS library_assets_site_sha_idx ON library_assets(site_id,sha256) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS library_assets_metadata_idx ON library_assets USING GIN(metadata jsonb_path_ops);

CREATE TABLE IF NOT EXISTS library_asset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES library_assets(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  storage_key text NOT NULL,
  sha256 char(64) NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asset_id,version)
);
CREATE TABLE IF NOT EXISTS media_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES library_assets(id) ON DELETE CASCADE,
  variant_key text NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  width integer,
  height integer,
  sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asset_id,variant_key)
);

ALTER TABLE navigation_menus ADD COLUMN IF NOT EXISTS presentation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(presentation)='object');

CREATE TABLE IF NOT EXISTS commerce_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,180}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  description text NOT NULL DEFAULT '',
  product_type text NOT NULL DEFAULT 'simple' CHECK (product_type IN ('simple','variable','downloadable','virtual','subscription')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  compare_at_price_minor bigint CHECK (compare_at_price_minor IS NULL OR compare_at_price_minor >= price_minor),
  sku text,
  inventory_quantity integer CHECK (inventory_quantity IS NULL OR inventory_quantity >= 0),
  stock_status text NOT NULL DEFAULT 'in_stock' CHECK (stock_status IN ('in_stock','out_of_stock','backorder')),
  requires_shipping boolean NOT NULL DEFAULT false,
  weight_grams integer CHECK (weight_grams IS NULL OR weight_grams >= 0),
  images jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(images)='array'),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes)='object'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,slug), UNIQUE(site_id,sku)
);
CREATE INDEX IF NOT EXISTS commerce_products_storefront_idx ON commerce_products(site_id,status,created_at DESC) WHERE status='published';

CREATE TABLE IF NOT EXISTS commerce_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{3,40}$'),
  discount_type text NOT NULL CHECK (discount_type IN ('percentage','fixed')),
  discount_value bigint NOT NULL CHECK (discount_value > 0),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  usage_limit integer CHECK (usage_limit IS NULL OR usage_limit > 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  starts_at timestamptz,
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,code)
);

CREATE TABLE IF NOT EXISTS commerce_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  order_number bigint GENERATED ALWAYS AS IDENTITY,
  customer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','paid','processing','fulfilled','cancelled','refunded','failed')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  shipping_minor bigint NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  billing_address jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(billing_address)='object'),
  shipping_address jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(shipping_address)='object'),
  provider text,
  provider_session_id text,
  provider_payment_id text,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,idempotency_key), UNIQUE(provider,provider_session_id)
);
CREATE INDEX IF NOT EXISTS commerce_orders_customer_idx ON commerce_orders(site_id,customer_id,created_at DESC);
CREATE TABLE IF NOT EXISTS commerce_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES commerce_products(id) ON DELETE SET NULL,
  name_snapshot text NOT NULL,
  sku_snapshot text,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object')
);
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  processed_at timestamptz,
  payload_digest char(64) NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,provider_event_id)
);

CREATE TABLE IF NOT EXISTS membership_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,100}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  description text NOT NULL DEFAULT '',
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  interval_unit text NOT NULL CHECK (interval_unit IN ('one_time','month','year')),
  interval_count integer NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 12),
  access_rules jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(access_rules)='object'),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,slug)
);
CREATE TABLE IF NOT EXISTS paid_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES membership_plans(id),
  status text NOT NULL CHECK (status IN ('pending','active','past_due','cancelled','expired')),
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,user_id,plan_id,provider_subscription_id)
);
CREATE INDEX IF NOT EXISTS paid_memberships_access_idx ON paid_memberships(site_id,user_id,status,current_period_end);

CREATE TABLE IF NOT EXISTS social_profiles (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 180),
  bio text NOT NULL DEFAULT '' CHECK (length(bio) <= 4000),
  avatar_asset_id uuid REFERENCES library_assets(id) ON DELETE SET NULL,
  website_url text,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','members','private')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id,user_id)
);
CREATE TABLE IF NOT EXISTS social_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,100}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 8000),
  privacy text NOT NULL DEFAULT 'public' CHECK (privacy IN ('public','private','hidden')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,slug)
);
CREATE TABLE IF NOT EXISTS social_group_memberships (
  group_id uuid NOT NULL REFERENCES social_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','moderator','member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','banned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id,user_id)
);
CREATE TABLE IF NOT EXISTS social_friendships (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(requester_id <> addressee_id), PRIMARY KEY(site_id,requester_id,addressee_id)
);
CREATE TABLE IF NOT EXISTS social_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES social_groups(id) ON DELETE CASCADE,
  activity_type text NOT NULL CHECK(activity_type IN ('status','comment','group_post','system')),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),
  visibility text NOT NULL DEFAULT 'members' CHECK(visibility IN ('public','members','private','group')),
  parent_id uuid REFERENCES social_activities(id) ON DELETE CASCADE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS social_activity_feed_idx ON social_activities(site_id,created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS firewall_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid REFERENCES sites(id) ON DELETE CASCADE,
  action text NOT NULL CHECK(action IN ('allow','deny','challenge','rate_limit')),
  scope text NOT NULL CHECK(scope IN ('ip','cidr','path','country','user_agent')),
  pattern text NOT NULL CHECK(length(pattern) BETWEEN 1 AND 500),
  reason text NOT NULL DEFAULT '' CHECK(length(reason) <= 500),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS firewall_rules_enabled_idx ON firewall_rules(enabled,scope,action);

CREATE TABLE IF NOT EXISTS cloud_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN ('aws-s3','s3-compatible','google-cloud-storage','azure-blob','cloudflare-r2','minio')),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 180),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config)='object'),
  credential_reference text NOT NULL,
  status text NOT NULL DEFAULT 'configured' CHECK(status IN ('configured','healthy','unhealthy','disabled')),
  last_health_check_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,name)
);

CREATE TABLE IF NOT EXISTS site_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  request_id text,
  event_type text NOT NULL,
  severity text NOT NULL CHECK(severity IN ('info','low','medium','high','critical')),
  source_ip inet,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_security_events_date_idx ON site_security_events(created_at DESC);

-- Example capability labels are additive and do not grant permissions by themselves.
UPDATE roles SET capabilities = capabilities || '["commerce:manage","commerce:read","memberships:manage","community:moderate","security:manage","library:manage","cloud:manage"]'::jsonb
WHERE slug='site-owner' AND NOT (capabilities ? 'commerce:manage');
