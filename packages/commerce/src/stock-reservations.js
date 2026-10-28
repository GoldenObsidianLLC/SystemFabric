'use strict';

/**
 * Release one order's outstanding stock reservations exactly once. Call only
 * inside the caller's existing transaction after changing the order state.
 * Reservations already committed/released/expired are intentionally ignored.
 */
async function releaseOrderStockReservations(client, { siteId, orderId, status = 'released' }) {
  if (!['released', 'expired'].includes(status)) throw new TypeError('Reservation release status must be released or expired.');
  if (typeof siteId !== 'string' || typeof orderId !== 'string') throw new TypeError('siteId and orderId are required.');
  const result = await client.query(
    `WITH released AS (
       UPDATE commerce_stock_reservations
          SET status=$3,updated_at=now()
        WHERE site_id=$1 AND order_id=$2 AND status='reserved'
        RETURNING site_id,order_id,product_id,quantity
     ), restored AS (
       UPDATE commerce_products p
          SET inventory_quantity=p.inventory_quantity+r.quantity,
              stock_status=CASE WHEN p.inventory_quantity+r.quantity > 0 THEN 'in_stock' ELSE 'out_of_stock' END,
              version=p.version+1,updated_at=now()
         FROM (SELECT site_id,product_id,SUM(quantity)::integer AS quantity
                 FROM released GROUP BY site_id,product_id) r
        WHERE p.site_id=r.site_id AND p.id=r.product_id AND p.inventory_quantity IS NOT NULL
        RETURNING p.id
     )
     SELECT count(*)::int AS released_count FROM released`,
    [siteId, orderId, status]
  );
  return Number(result.rows[0]?.released_count || 0);
}

/** Mark reserved stock as committed once payment has been accepted. */
async function commitOrderStockReservations(client, { siteId, orderId }) {
  if (typeof siteId !== 'string' || typeof orderId !== 'string') throw new TypeError('siteId and orderId are required.');
  const result = await client.query(
    `UPDATE commerce_stock_reservations SET status='committed',updated_at=now()
      WHERE site_id=$1 AND order_id=$2 AND status='reserved' RETURNING id`,
    [siteId, orderId]
  );
  return result.rows.length;
}


module.exports = { releaseOrderStockReservations, commitOrderStockReservations };
