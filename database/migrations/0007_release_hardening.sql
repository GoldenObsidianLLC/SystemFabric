-- SystemFabric 0.5.0: upload malware-scan lifecycle and community abuse workflows.
-- Forward-only migration. Existing assets are explicitly marked not_scanned; they
-- are not automatically declared clean by this schema change.
ALTER TABLE library_assets
  ADD COLUMN IF NOT EXISTS malware_scan_status text NOT NULL DEFAULT 'not_scanned',
  ADD COLUMN IF NOT EXISTS malware_scan_engine text,
  ADD COLUMN IF NOT EXISTS malware_scanned_at timestamptz,
  ADD COLUMN IF NOT EXISTS quarantine_reason text;

DO $$ BEGIN
  ALTER TABLE library_assets ADD CONSTRAINT library_assets_malware_scan_status_check
    CHECK (malware_scan_status IN ('not_scanned','clean','infected','error'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS library_assets_quarantine_idx
  ON library_assets(site_id,created_at) WHERE status='quarantined';

CREATE TABLE IF NOT EXISTS social_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_type text NOT NULL DEFAULT 'direct' CHECK (conversation_type IN ('direct','group')),
  group_id uuid REFERENCES social_groups(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((conversation_type='direct' AND group_id IS NULL) OR (conversation_type='group' AND group_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS social_conversation_members (
  conversation_id uuid NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  last_read_at timestamptz,
  PRIMARY KEY(conversation_id,user_id)
);
CREATE INDEX IF NOT EXISTS social_conversation_members_site_user_idx
  ON social_conversation_members(site_id,user_id) WHERE left_at IS NULL;
CREATE TABLE IF NOT EXISTS social_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','edited','deleted','moderated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS social_messages_conversation_idx
  ON social_messages(site_id,conversation_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS social_blocks (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id,blocker_id,blocked_id),
  CHECK(blocker_id <> blocked_id)
);
CREATE TABLE IF NOT EXISTS social_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('profile','group','activity','message','user')),
  target_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('spam','harassment','hate','sexual','violence','illegal','other')),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  moderation_note text NOT NULL DEFAULT '' CHECK (length(moderation_note) <= 4000),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_reports_queue_idx ON social_reports(site_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS social_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type text NOT NULL CHECK (notification_type ~ '^[a-z][a-z0-9_.-]{1,80}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_notifications_inbox_idx
  ON social_notifications(site_id,user_id,created_at DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS commerce_coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  coupon_id uuid NOT NULL REFERENCES commerce_coupons(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  discount_minor bigint NOT NULL CHECK(discount_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(coupon_id,order_id)
);
CREATE TABLE IF NOT EXISTS commerce_stock_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES commerce_products(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','committed','released','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id,product_id)
);
CREATE INDEX IF NOT EXISTS commerce_stock_reservations_expiry_idx
  ON commerce_stock_reservations(status,expires_at) WHERE status='reserved';
CREATE TABLE IF NOT EXISTS commerce_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_refund_id text,
  amount_minor bigint NOT NULL CHECK(amount_minor > 0),
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL DEFAULT '' CHECK(length(reason) <= 1000),
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','pending','succeeded','failed','cancelled')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_refund_id)
);
CREATE TABLE IF NOT EXISTS commerce_download_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES commerce_order_items(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES library_assets(id) ON DELETE RESTRICT,
  max_downloads integer CHECK(max_downloads IS NULL OR max_downloads > 0),
  download_count integer NOT NULL DEFAULT 0 CHECK(download_count >= 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_item_id,asset_id)
);
CREATE TABLE IF NOT EXISTS systemfabric_moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('hide','restore','warn','mute','suspend','ban','unban','dismiss_report')),
  reason text NOT NULL DEFAULT '' CHECK(length(reason) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS systemfabric_moderation_target_idx
  ON systemfabric_moderation_actions(site_id,target_type,target_id,created_at DESC);
