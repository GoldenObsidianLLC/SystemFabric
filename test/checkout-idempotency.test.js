'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handlePlatformRoute } = require('../apps/api/src/platform-routes');

const siteId = 'cb289662-2ea5-4b43-92a9-cd2dce8f9310';
const ownerId = '82c36ec0-4fd4-4c85-bb7d-dde7e6a61098';
const otherId = '385ef0ad-d7d6-4ec1-a1f4-1f9230551ea7';
const key = 'checkout-idempotency-1234';

function context({ actorId = ownerId, existingStatus = 'pending_payment', metadata = { checkoutUrl: 'https://checkout.example.test/cs_123', checkoutExpiresAt: 1_798_000_000, checkoutLineItems: [{ name: 'secret-ish snapshot', unitAmount: 123 }] }, customerId = ownerId, providerSessionId = 'cs_123', queryImpl = null, env = {} } = {}) {
  const calls = [];
  const existing = {
    id: '1d69eb5b-e8c7-48d7-a041-b67438983f6a', order_number: 17,
    status: existingStatus, customer_id: customerId, email: 'owner@example.test', currency: 'USD',
    total_minor: '123', metadata, provider_session_id: providerSessionId, created_at: new Date('2026-10-01T00:00:00Z')
  };
  const ctx = {
    req: { method: 'POST', headers: {} },
    res: {},
    url: new URL(`http://systemfabric.local/api/v1/sites/${siteId}/commerce/checkout`),
    actor: { user: { id: actorId, email: actorId === ownerId ? 'owner@example.test' : 'other@example.test' } },
    localPool: {
      async query(sql, values) {
        calls.push({ sql, values });
        if (queryImpl) return queryImpl(sql, values, existing);
        if (sql.includes('FROM commerce_orders WHERE site_id=$1 AND idempotency_key=$2')) return { rows: [existing] };
        throw new Error(`unexpected query: ${sql}`);
      },
      async connect() { throw new Error('connect should not be called for existing-order branches'); }
    },
    async siteIdFor({ body, routeSiteId }) { assert.equal(routeSiteId, siteId); assert.equal(Object.hasOwn(body, 'siteId'), false); return siteId; },
    async requireCapability() {},
    async readJson() { return { items: [{ productId: 'a34c0d1a-0b9d-4f56-a3ec-0b2b97224632', quantity: 1 }], email: 'owner@example.test', idempotencyKey: key }; },
    sendJson(_res, statusCode, payload) { ctx.res.statusCode = statusCode; ctx.res.payload = payload; return true; },
    fail(statusCode, code, message, details) { return Object.assign(new Error(message), { statusCode, code, details }); },
    requestId: 'test-request', maxBody: 150_000, env: { STRIPE_SECRET_KEY: 'sk_fixture_not_a_real_credential', STRIPE_CHECKOUT_SUCCESS_URL: 'https://shop.example.test/success', STRIPE_CHECKOUT_CANCEL_URL: 'https://shop.example.test/cancel', ...env },
    async store() {}
  };
  return { ctx, calls };
}

test('checkout idempotency replay returns a sanitized order view and saved checkout URL', async () => {
  const { ctx } = context();
  const handled = await handlePlatformRoute(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.payload.checkoutUrl, 'https://checkout.example.test/cs_123');
  assert.equal(ctx.res.payload.order.id, '1d69eb5b-e8c7-48d7-a041-b67438983f6a');
  assert.deepEqual(Object.keys(ctx.res.payload.order.metadata).sort(), ['checkoutExpiresAt', 'checkoutUrl']);
  assert.equal('email' in ctx.res.payload.order, false);
  assert.equal('customer_id' in ctx.res.payload.order, false);
  assert.equal('checkoutLineItems' in ctx.res.payload.order.metadata, false);
});

test('checkout idempotency keys cannot disclose another customer order', async () => {
  const { ctx, calls } = context({ actorId: otherId });
  await assert.rejects(handlePlatformRoute(ctx), error => error.statusCode === 404 && error.code === 'ERR_SYSTEMFABRIC_CHECKOUT_ORDER_NOT_FOUND');
  assert.equal(calls.length, 1);
});

test('closed checkout idempotency keys return a conflict instead of a null checkout link', async () => {
  const { ctx } = context({ existingStatus: 'failed', metadata: {} });
  await assert.rejects(handlePlatformRoute(ctx), error => error.statusCode === 409 && error.code === 'ERR_SYSTEMFABRIC_CHECKOUT_KEY_CLOSED');
});

test('recovered paid-order replay does not return embedded customer or internal snapshot data', async () => {
  const { ctx } = context({ existingStatus: 'paid' });
  const handled = await handlePlatformRoute(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.payload.paymentComplete, true);
  assert.equal(ctx.res.payload.order.status, 'paid');
  assert.equal(ctx.res.payload.order.metadata.checkoutUrl, 'https://checkout.example.test/cs_123');
  assert.equal('email' in ctx.res.payload.order, false);
});


test('pending checkout recovery replays the saved Stripe request with the same idempotency key', async () => {
  const checkoutExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
  const metadata = {
    checkoutExpiresAt,
    checkoutLineItems: [{ currency: 'USD', unitAmount: 123, quantity: 1, name: 'Reserved product', description: 'SKU RES-1', stockReserved: true }],
    customerEmail: 'owner@example.test'
  };
  const { ctx, calls } = context({
    metadata,
    providerSessionId: null,
    queryImpl: async (sql) => {
      if (sql.includes('FROM commerce_orders WHERE site_id=$1 AND idempotency_key=$2')) return { rows: [{
        id: '1d69eb5b-e8c7-48d7-a041-b67438983f6a', order_number: 17, status: 'pending_payment', customer_id: ownerId,
        email: 'owner@example.test', currency: 'USD', total_minor: '123', metadata, provider_session_id: null,
        created_at: new Date('2026-10-01T00:00:00Z')
      }] };
      if (sql.includes('FROM commerce_stock_reservations')) return { rows: [{ count: 1 }] };
      if (sql.includes('UPDATE commerce_orders')) return { rows: [{
        id: '1d69eb5b-e8c7-48d7-a041-b67438983f6a', order_number: 17, status: 'pending_payment', currency: 'USD', total_minor: '123',
        provider_session_id: 'cs_recovered', metadata: { ...metadata, checkoutUrl: 'https://checkout.example.test/cs_recovered' },
        created_at: new Date('2026-10-01T00:00:00Z')
      }] };
      throw new Error(`unexpected query: ${sql}`);
    }
  });
  const originalFetch = global.fetch;
  let providerHeaders; let providerForm;
  global.fetch = async (_url, options) => {
    providerHeaders = options.headers;
    providerForm = new URLSearchParams(options.body);
    return { ok: true, status: 200, async text() { return JSON.stringify({ id: 'cs_recovered', url: 'https://checkout.example.test/cs_recovered', mode: 'payment', status: 'open', payment_status: 'unpaid' }); } };
  };
  try {
    const handled = await handlePlatformRoute(ctx);
    assert.equal(handled, true);
    assert.equal(ctx.res.statusCode, 200);
    assert.equal(ctx.res.payload.checkoutUrl, 'https://checkout.example.test/cs_recovered');
    assert.equal(providerHeaders['idempotency-key'], 'sf_1d69eb5b-e8c7-48d7-a041-b67438983f6a');
    assert.equal(providerForm.get('expires_at'), String(checkoutExpiresAt));
    assert.equal(providerForm.get('line_items[0][price_data][unit_amount]'), '123');
    assert.equal(providerForm.get('line_items[0][price_data][product_data][description]'), 'SKU RES-1');
    assert.equal(providerForm.get('metadata[site_id]'), siteId);
    assert.equal(providerForm.get('metadata[order_id]'), '1d69eb5b-e8c7-48d7-a041-b67438983f6a');
    assert.equal('checkoutLineItems' in ctx.res.payload.order.metadata, false);
    assert.equal(calls.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('pending checkout recovery refuses to recreate a Stripe session after stock holds were lost', async () => {
  const checkoutExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
  const metadata = { checkoutExpiresAt, checkoutLineItems: [{ currency: 'USD', unitAmount: 123, quantity: 1, name: 'Reserved product', stockReserved: true }] };
  const { ctx } = context({ metadata, providerSessionId: null, queryImpl: async (sql) => {
    if (sql.includes('FROM commerce_orders WHERE site_id=$1 AND idempotency_key=$2')) return { rows: [{
      id: '1d69eb5b-e8c7-48d7-a041-b67438983f6a', order_number: 17, status: 'pending_payment', customer_id: ownerId,
      email: 'owner@example.test', currency: 'USD', total_minor: '123', metadata, provider_session_id: null,
      created_at: new Date('2026-10-01T00:00:00Z')
    }] };
    if (sql.includes('FROM commerce_stock_reservations')) return { rows: [{ count: 0 }] };
    throw new Error(`unexpected query: ${sql}`);
  } });
  await assert.rejects(handlePlatformRoute(ctx), error => error.statusCode === 409 && error.code === 'ERR_SYSTEMFABRIC_CHECKOUT_STOCK_HOLD');
});
