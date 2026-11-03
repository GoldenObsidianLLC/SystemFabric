'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPostgresPool } = require('../../packages/db/src/postgres-store');
const { createIdentityService, hashPassword } = require('../../packages/auth/src/service');
const { createApiServer } = require('../../apps/api/src/server');

const enabled = Boolean(
  process.env.DATABASE_URL &&
  process.env.VIRGOSCORPIO_HUB_RUN_POSTGRES_INTEGRATION === 'true'
);

async function orderState(pool, siteId, orderId) {
  const [order, items, reservations] = await Promise.all([
    pool.query(
      `SELECT id,site_id,customer_id,email,status,currency,subtotal_minor,total_minor,
              provider,provider_session_id,idempotency_key,metadata,updated_at
         FROM commerce_orders WHERE site_id=$1 AND id=$2`,
      [siteId, orderId]
    ),
    pool.query(
      `SELECT id,order_id,product_id,name_snapshot,quantity,unit_price_minor,line_total_minor,metadata
         FROM commerce_order_items WHERE order_id=$1 ORDER BY id`,
      [orderId]
    ),
    pool.query(
      `SELECT site_id,order_id,product_id,quantity,status,expires_at
         FROM commerce_stock_reservations WHERE site_id=$1 AND order_id=$2 ORDER BY product_id`,
      [siteId, orderId]
    ),
  ]);
  return { order: order.rows, items: items.rows, reservations: reservations.rows };
}

test(
  'tenant isolation: checkout idempotency replay and product IDs remain site-scoped',
  { skip: !enabled },
  async t => {
    const pool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_POOL_MAX: '8',
    });
    const siteIds = [];
    const userIds = [];
    let server = null;
    const originalFetch = global.fetch;
    const providerCalls = [];

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
      REQUIRE_VERIFIED_EMAIL: 'false',
      STRIPE_SECRET_KEY: 'sk_test_virgoscorpio_hub_fixture_not_real',
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://shop.example.test/checkout/success',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://shop.example.test/checkout/cancel',
    };
    delete env.VIRGOSCORPIO_HUB_API_TOKEN;

    global.fetch = async (input, options = {}) => {
      if (String(input) === 'https://api.stripe.com/v1/checkout/sessions') {
        const form = new URLSearchParams(options.body || '');
        const call = {
          headers: { ...(options.headers || {}) },
          form,
        };
        providerCalls.push(call);
        const index = providerCalls.length;
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              id: `cs_test_tenant_scoped_${index}`,
              url: `https://checkout.example.test/tenant-scoped-${index}`,
              mode: 'payment',
              status: 'open',
              payment_status: 'unpaid',
            });
          },
        };
      }
      return originalFetch(input, options);
    };

    const identity = createIdentityService({ pool, env });

    t.after(async () => {
      global.fetch = originalFetch;
      if (server) {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await server.virgoScorpioHub.close().catch(() => {});
      }
      if (siteIds.length) {
        await pool.query('DELETE FROM sites WHERE id=ANY($1::uuid[])', [siteIds]).catch(() => {});
      }
      if (userIds.length) {
        await pool.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [userIds]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]).catch(() => {});
      }
      await pool.end();
    });

    const siteAResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      [`tenant-checkout-a-${randomUUID().slice(0, 8)}`, 'Tenant Checkout Site A']
    );
    const siteA = siteAResult.rows[0].id;
    siteIds.push(siteA);

    const siteBResult = await pool.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id',
      [`tenant-checkout-b-${randomUUID().slice(0, 8)}`, 'Tenant Checkout Site B']
    );
    const siteB = siteBResult.rows[0].id;
    siteIds.push(siteB);

    const roleResult = await pool.query(
      "SELECT id FROM roles WHERE slug='site-owner' LIMIT 1"
    );
    assert.ok(roleResult.rows[0], 'the site-owner seed role must exist');

    const actorResult = await pool.query(
      `INSERT INTO users(email,display_name,password_hash,status)
       VALUES($1,$2,$3,'active') RETURNING id,email`,
      [
        `tenant-checkout-actor-${randomUUID()}@example.test`,
        'Site B Checkout Customer',
        await hashPassword('Isolation-Password-2026'),
      ]
    );
    const actor = actorResult.rows[0];
    userIds.push(actor.id);

    // This account has a historical order in A but is currently a member only of B.
    await pool.query(
      'INSERT INTO site_memberships(site_id,user_id,role_id) VALUES($1,$2,$3)',
      [siteB, actor.id, roleResult.rows[0].id]
    );

    const productAResult = await pool.query(
      `INSERT INTO commerce_products(
         site_id,slug,name,status,currency,price_minor,inventory_quantity,stock_status
       ) VALUES($1,$2,'Private A Inventory','published','USD',1100,10,'in_stock') RETURNING id`,
      [siteA, `private-a-${randomUUID().slice(0, 8)}`]
    );
    const productA = productAResult.rows[0];

    const productBResult = await pool.query(
      `INSERT INTO commerce_products(
         site_id,slug,name,status,currency,price_minor,inventory_quantity,stock_status
       ) VALUES($1,$2,'Site B Checkout Product','published','USD',2400,5,'in_stock') RETURNING id`,
      [siteB, `site-b-${randomUUID().slice(0, 8)}`]
    );
    const productB = productBResult.rows[0];

    const sharedIdempotencyKey = `tenant-scoped-checkout-${randomUUID().replace(/-/g, '')}`;
    const privateCheckoutUrl = 'https://checkout.example.test/site-a-private-session';
    const checkoutExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    const orderAResult = await pool.query(
      `INSERT INTO commerce_orders(
         site_id,customer_id,email,status,currency,subtotal_minor,total_minor,
         provider,provider_session_id,idempotency_key,metadata
       ) VALUES($1,$2,$3,'pending_payment','USD',1100,1100,'stripe',$4,$5,$6::jsonb)
       RETURNING id`,
      [
        siteA,
        actor.id,
        actor.email,
        `cs_test_site_a_${randomUUID().replace(/-/g, '')}`,
        sharedIdempotencyKey,
        JSON.stringify({
          checkoutUrl: privateCheckoutUrl,
          checkoutExpiresAt,
          checkoutLineItems: [{
            currency: 'USD',
            unitAmount: 1100,
            quantity: 1,
            name: 'Private A Inventory',
          }],
        }),
      ]
    );
    const orderAId = orderAResult.rows[0].id;
    await pool.query(
      `INSERT INTO commerce_order_items(
         order_id,product_id,name_snapshot,quantity,unit_price_minor,line_total_minor
       ) VALUES($1,$2,'Private A Inventory',1,1100,1100)`,
      [orderAId, productA.id]
    );

    const beforeA = await orderState(pool, siteA, orderAId);
    const beforeAInventory = await pool.query(
      'SELECT inventory_quantity,stock_status,version FROM commerce_products WHERE site_id=$1 AND id=$2',
      [siteA, productA.id]
    );

    const session = await identity.login({
      email: actor.email,
      password: 'Isolation-Password-2026',
      ip: '127.0.0.1',
      userAgent: 'tenant-checkout-isolation-test',
    });
    assert.equal(session.mfaRequired, false);

    server = createApiServer({
      env,
      pool,
      identityService: identity,
      logger: { error() {} },
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    };

    await t.test('site B replay of site A idempotency key creates a B-scoped checkout, never returns the A order or URL', async () => {
      const response = await fetch(`${base}/api/v1/sites/${siteB}/commerce/checkout`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: [{ productId: productB.id, quantity: 1 }],
          email: actor.email,
          idempotencyKey: sharedIdempotencyKey,
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 201);
      assert.notEqual(payload.order.id, orderAId);
      assert.equal(payload.order.status, 'pending_payment');
      assert.equal(payload.idempotentReplay, undefined);
      assert.equal(payload.checkoutUrl, 'https://checkout.example.test/tenant-scoped-1');
      assert.notEqual(payload.checkoutUrl, privateCheckoutUrl);
      assert.doesNotMatch(JSON.stringify(payload), /site-a-private-session|Private A Inventory/);

      const created = await pool.query(
        'SELECT id,site_id,customer_id,email,status,total_minor,provider_session_id,idempotency_key FROM commerce_orders WHERE site_id=$1 AND id=$2',
        [siteB, payload.order.id]
      );
      assert.equal(created.rows.length, 1);
      assert.equal(created.rows[0].site_id, siteB);
      assert.equal(created.rows[0].customer_id, actor.id);
      assert.equal(created.rows[0].idempotency_key, sharedIdempotencyKey);
      assert.equal(Number(created.rows[0].total_minor), 2400);

      assert.equal(providerCalls.length, 1);
      assert.equal(providerCalls[0].headers['idempotency-key'], `vsh_${payload.order.id}`);
      assert.equal(providerCalls[0].form.get('metadata[site_id]'), siteB);
      assert.equal(providerCalls[0].form.get('metadata[order_id]'), payload.order.id);
      assert.equal(providerCalls[0].form.get('line_items[0][price_data][unit_amount]'), '2400');

      const bInventory = await pool.query(
        'SELECT inventory_quantity,stock_status FROM commerce_products WHERE site_id=$1 AND id=$2',
        [siteB, productB.id]
      );
      assert.equal(bInventory.rows[0].inventory_quantity, 4);
      const bReservations = await pool.query(
        "SELECT site_id,order_id,product_id,quantity,status FROM commerce_stock_reservations WHERE site_id=$1 AND order_id=$2",
        [siteB, payload.order.id]
      );
      assert.equal(bReservations.rows.length, 1);
      assert.equal(bReservations.rows[0].site_id, siteB);
      assert.equal(bReservations.rows[0].status, 'reserved');

      assert.deepEqual(await orderState(pool, siteA, orderAId), beforeA);
      assert.deepEqual(
        (await pool.query(
          'SELECT inventory_quantity,stock_status,version FROM commerce_products WHERE site_id=$1 AND id=$2',
          [siteA, productA.id]
        )).rows,
        beforeAInventory.rows
      );
      const aOrderIds = await pool.query(
        'SELECT id FROM commerce_orders WHERE site_id=$1 AND idempotency_key=$2',
        [siteA, sharedIdempotencyKey]
      );
      assert.deepEqual(aOrderIds.rows.map(row => row.id), [orderAId]);
    });

    await t.test('a site A product UUID in a site B cart is rejected before inventory or Stripe changes', async () => {
      const bBefore = await pool.query(
        'SELECT inventory_quantity,stock_status,version FROM commerce_products WHERE site_id=$1 AND id=$2',
        [siteB, productB.id]
      );
      const orderCountBefore = await pool.query(
        'SELECT count(*)::int AS count FROM commerce_orders WHERE site_id=$1',
        [siteB]
      );
      const response = await fetch(`${base}/api/v1/sites/${siteB}/commerce/checkout`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: [{ productId: productA.id, quantity: 1 }],
          email: actor.email,
          idempotencyKey: `foreign-product-${randomUUID().replace(/-/g, '')}`,
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 422);
      assert.equal(payload.code, 'ERR_VIRGOSCORPIO_HUB_CART_PRODUCT');
      assert.equal(providerCalls.length, 1, 'invalid cross-site cart must not invoke Stripe');

      assert.deepEqual(
        (await pool.query(
          'SELECT inventory_quantity,stock_status,version FROM commerce_products WHERE site_id=$1 AND id=$2',
          [siteB, productB.id]
        )).rows,
        bBefore.rows
      );
      assert.equal(
        Number((await pool.query(
          'SELECT count(*)::int AS count FROM commerce_orders WHERE site_id=$1',
          [siteB]
        )).rows[0].count),
        orderCountBefore.rows[0].count
      );
      assert.deepEqual(await orderState(pool, siteA, orderAId), beforeA);
      assert.deepEqual(
        (await pool.query(
          'SELECT inventory_quantity,stock_status,version FROM commerce_products WHERE site_id=$1 AND id=$2',
          [siteA, productA.id]
        )).rows,
        beforeAInventory.rows
      );
    });
  }
);
