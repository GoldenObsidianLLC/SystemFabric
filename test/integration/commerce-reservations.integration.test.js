"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createPostgresPool } = require("../../packages/db/src/postgres-store");
const {
  releaseOrderStockReservations,
  commitOrderStockReservations,
} = require("../../packages/commerce/src/stock-reservations");
const {
  reconcileExpiredStripeCheckouts,
} = require("../../packages/billing/src/checkout-reconciliation");
const TEST_STRIPE_SECRET_KEY = ["sk", "test", "fixture_not_real"].join("_");
const enabled = Boolean(
  process.env.DATABASE_URL &&
  process.env.SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION === "true",
);

test(
  "checkout reservations expire once, aggregate same-product restores, and never restock committed/paid orders",
  { skip: !enabled },
  async (t) => {
    const pool = createPostgresPool({ ...process.env, DATABASE_POOL_MAX: "8" });
    const siteSlug = `stock-it-${randomUUID().slice(0, 10)}`;
    const site = await pool.query(
      "INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id",
      [siteSlug, "Stock Reservation Integration"],
    );
    const siteId = site.rows[0].id;
    t.after(async () => {
      await pool
        .query("DELETE FROM sites WHERE id=$1", [siteId])
        .catch(() => {});
      await pool.end();
    });

    const products = [];
    for (let index = 0; index < 1; index++) {
      const product = await pool.query(
        `INSERT INTO commerce_products(site_id,slug,name,status,currency,price_minor,inventory_quantity,stock_status)
       VALUES($1,$2,'Reserved Product','published','USD',1250,1,'in_stock') RETURNING id`,
        [siteId, `reserved-product-${index}-${randomUUID().slice(0, 6)}`],
      );
      products.push(product.rows[0].id);
    }

    async function makeOrder({
      quantity,
      status = "pending_payment",
      expiresInSeconds = -60,
    }) {
      const sessionId = `cs_test_${randomUUID().replace(/-/g, "")}`;
      const order = await pool.query(
        `INSERT INTO commerce_orders(site_id,email,status,currency,subtotal_minor,total_minor,provider,provider_session_id,idempotency_key)
       VALUES($1,'buyer@example.test',$2,'USD',$3,$3,'stripe',$5,$4) RETURNING id`,
        [siteId, status, quantity * 1250, randomUUID(), sessionId],
      );
      await pool.query(
        `INSERT INTO commerce_order_items(order_id,product_id,name_snapshot,quantity,unit_price_minor,line_total_minor,metadata)
       VALUES($1,$2,'Reserved Product',$3,1250,$4,'{"stockReserved":true}'::jsonb)`,
        [order.rows[0].id, products[0], quantity, quantity * 1250],
      );
      await pool.query(
        `INSERT INTO commerce_stock_reservations(site_id,order_id,product_id,quantity,status,expires_at)
       VALUES($1,$2,$3,$4,'reserved',now()+($5::text||' seconds')::interval)`,
        [siteId, order.rows[0].id, products[0], quantity, expiresInSeconds],
      );
      return { id: order.rows[0].id, sessionId };
    }

    // Simulate inventory already decreased by the original checkout transaction.
    const expiredOrderA = await makeOrder({ quantity: 2 });
    const expiredOrderB = await makeOrder({ quantity: 3 });
    const paidOrder = await makeOrder({ quantity: 4, status: "paid" });
    await pool.query(
      "UPDATE commerce_products SET inventory_quantity=0,stock_status=$2 WHERE site_id=$1 AND id=$3",
      [siteId, "out_of_stock", products[0]],
    );

    const count = await reconcileExpiredStripeCheckouts(pool, {
      secretKey: TEST_STRIPE_SECRET_KEY,
      batchSize: 50,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            id: decodeURIComponent(url.split("/").pop()),
            status: "expired",
            payment_status: "unpaid",
          });
        },
      }),
    });
    assert.equal(count.expired, 2);
    assert.equal(count.errors, 0);
    const product = await pool.query(
      "SELECT inventory_quantity,stock_status FROM commerce_products WHERE site_id=$1 AND id=$2",
      [siteId, products[0]],
    );
    // 2 + 3 units are returned together; a single UPDATE must restore the sum.
    assert.equal(product.rows[0].inventory_quantity, 5);
    assert.equal(product.rows[0].stock_status, "in_stock");

    const statuses = await pool.query(
      "SELECT order_id,status FROM commerce_stock_reservations WHERE site_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY order_id",
      [siteId, [expiredOrderA.id, expiredOrderB.id, paidOrder.id]],
    );
    assert.deepEqual(statuses.rows.map((row) => row.status).sort(), [
      "expired",
      "expired",
      "reserved",
    ]);
    const orderStatus = await pool.query(
      "SELECT id,status FROM commerce_orders WHERE site_id=$1 AND id=ANY($2::uuid[])",
      [siteId, [expiredOrderA.id, expiredOrderB.id, paidOrder.id]],
    );
    assert.equal(
      orderStatus.rows.filter((row) => row.status === "failed").length,
      2,
    );
    assert.equal(
      orderStatus.rows.filter((row) => row.status === "paid").length,
      1,
    );
    assert.equal(
      (
        await reconcileExpiredStripeCheckouts(pool, {
          secretKey: TEST_STRIPE_SECRET_KEY,
          batchSize: 50,
          fetchImpl: async () => {
            throw new Error("no candidate should be fetched");
          },
        })
      ).expired,
      0,
    );

    // Committing a paid order preserves its hold as committed; a later release is a no-op.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      assert.equal(
        await commitOrderStockReservations(client, {
          siteId,
          orderId: paidOrder.id,
        }),
        1,
      );
      await client.query("COMMIT");
      await client.query("BEGIN");
      assert.equal(
        await releaseOrderStockReservations(client, {
          siteId,
          orderId: paidOrder.id,
        }),
        0,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
);
