-- Give each site/order refund request a durable, caller-supplied idempotency scope.
-- Existing refunds receive stable legacy keys before the column becomes mandatory.
ALTER TABLE commerce_refunds
  ADD COLUMN IF NOT EXISTS idempotency_key text;

UPDATE commerce_refunds
   SET idempotency_key = 'legacy_' || id::text
 WHERE idempotency_key IS NULL;

ALTER TABLE commerce_refunds
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS commerce_refunds_site_order_idempotency_idx
  ON commerce_refunds(site_id, order_id, idempotency_key);

CREATE INDEX IF NOT EXISTS commerce_refunds_site_order_status_idx
  ON commerce_refunds(site_id, order_id, status, created_at DESC);
