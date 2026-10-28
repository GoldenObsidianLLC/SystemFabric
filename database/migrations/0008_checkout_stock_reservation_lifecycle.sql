-- SystemFabric 0.5.1: durable checkout inventory holds and recovery of pending orders.
-- Reservation expiry is aligned to Stripe Checkout expiration; payment transitions
-- commit reservations, while expiration/failure releases them only once.

CREATE INDEX IF NOT EXISTS commerce_stock_reservations_order_status_idx
  ON commerce_stock_reservations(site_id,order_id,status);

-- Backfill pending finite-stock orders created before the reservation lifecycle was
-- introduced. Existing Checkout Sessions use Stripe's default 24-hour expiration.
INSERT INTO commerce_stock_reservations(site_id,order_id,product_id,quantity,status,expires_at)
SELECT o.site_id,o.id,oi.product_id,oi.quantity,'reserved',o.created_at + interval '24 hours'
  FROM commerce_orders o
  JOIN commerce_order_items oi ON oi.order_id=o.id
 WHERE o.status='pending_payment'
   AND oi.product_id IS NOT NULL
   AND oi.metadata->>'stockReserved'='true'
   AND NOT EXISTS (
     SELECT 1 FROM commerce_stock_reservations r
      WHERE r.order_id=o.id AND r.product_id=oi.product_id
   )
ON CONFLICT(order_id,product_id) DO NOTHING;
