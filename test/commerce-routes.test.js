'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleCommerceRoute } = require('../apps/api/src/commerce-routes');

const siteId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const requestId = 'req-commerce-test-01';

function fail(statusCode, code, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function createContext({ path = '/api/v1/unmatched', method = 'GET', body = {}, pool, events = [] } = {}) {
  const res = { statusCode: 0, payload: null };
  return {
    req: { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    res,
    url: new URL(`http://localhost${path}`),
    actor: { user: { id: '33333333-3333-4333-8333-333333333333', email: 'buyer@example.test' } },
    requestId,
    localPool: pool || {
      async query(sql, values) {
        events.push({ type: 'query', sql, values });
        return { rows: [] };
      },
      async connect() { throw new Error('Unexpected pool.connect()'); }
    },
    env: {},
    identity: null,
    maxBody: 1_000_000,
    async siteIdFor(input) {
      events.push({ type: 'site', siteId: input.routeSiteId || input.body?.siteId || null });
      return input.routeSiteId;
    },
    async requireCapability(_actor, targetSiteId, capability) {
      events.push({ type: 'capability', siteId: targetSiteId, capability });
    },
    async readJson() {
      events.push({ type: 'readJson' });
      return body;
    },
    sendJson(response, statusCode, payload) {
      response.statusCode = statusCode;
      response.payload = payload;
      events.push({ type: 'sendJson', statusCode });
      return true;
    },
    fail
  };
}

test('commerce router declines paths outside its route family without touching dependencies', async () => {
  const events = [];
  const ctx = createContext({ events });

  assert.equal(await handleCommerceRoute(ctx), false);
  assert.deepEqual(events, []);
  assert.equal(ctx.res.statusCode, 0);
});

test('product listing establishes site and capability scope before a site-filtered read', async () => {
  const events = [];
  const product = { id: productId, site_id: siteId, slug: 'starter', status: 'published' };
  const pool = {
    async query(sql, values) {
      events.push({ type: 'query', sql, values });
      return { rows: [product] };
    },
    async connect() { throw new Error('Unexpected pool.connect()'); }
  };
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/products?status=published&limit=20`,
    method: 'GET',
    pool,
    events
  });

  assert.equal(await handleCommerceRoute(ctx), true);
  assert.equal(ctx.res.statusCode, 200);
  assert.deepEqual(ctx.res.payload.products, [product]);
  assert.equal(ctx.res.payload.requestId, requestId);
  assert.deepEqual(events.map(event => event.type), ['site', 'capability', 'query', 'sendJson']);
  assert.equal(events[0].siteId, siteId);
  assert.equal(events[1].capability, 'commerce:read');
  assert.match(events[2].sql, /FROM commerce_products WHERE site_id=\$1/);
  assert.equal(events[2].values[0], siteId);
});

test('invalid product writes are rejected before any database mutation', async () => {
  const events = [];
  const pool = {
    async query(sql, values) {
      events.push({ type: 'query', sql, values });
      throw new Error('Invalid product must not reach PostgreSQL');
    },
    async connect() { throw new Error('Invalid product must not acquire a client'); }
  };
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/products`,
    method: 'POST',
    body: { slug: 'bad slug', name: '', currency: 'USD', priceMinor: -1 },
    pool,
    events
  });

  await assert.rejects(
    handleCommerceRoute(ctx),
    error => error.statusCode === 422 && error.code === 'ERR_VIRGOSCORPIO_HUB_PRODUCT_INVALID'
  );
  assert.deepEqual(events.map(event => event.type), ['readJson', 'site', 'capability']);
  assert.equal(events.some(event => event.type === 'query'), false);
});

test('cross-site rejection happens before commerce capabilities or database access', async () => {
  const events = [];
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/commerce/orders`,
    method: 'GET',
    events
  });
  ctx.siteIdFor = async input => {
    events.push({ type: 'site-reject', siteId: input.routeSiteId });
    throw fail(403, 'ERR_VIRGOSCORPIO_HUB_SITE_SCOPE_MISMATCH', 'Site scope mismatch.');
  };

  await assert.rejects(
    handleCommerceRoute(ctx),
    error => error.statusCode === 403 && error.code === 'ERR_VIRGOSCORPIO_HUB_SITE_SCOPE_MISMATCH'
  );
  assert.deepEqual(events.map(event => event.type), ['site-reject']);
});

test('platform route module preserves its productInput export after commerce extraction', () => {
  const { productInput: platformProductInput } = require('../apps/api/src/platform-routes');
  const { productInput: commerceProductInput } = require('../apps/api/src/commerce-routes');
  const body = { slug: 'starter', name: 'Starter', priceMinor: 500, currency: 'USD' };

  assert.equal(platformProductInput, commerceProductInput);
  assert.deepEqual(platformProductInput(body), {
    slug: 'starter',
    name: 'Starter',
    description: '',
    productType: 'simple',
    status: 'draft',
    currency: 'USD',
    priceMinor: 500,
    compareAtPriceMinor: null,
    sku: null,
    inventoryQuantity: null,
    stockStatus: 'in_stock',
    requiresShipping: false,
    weightGrams: null,
    images: [],
    attributes: {},
    metadata: {}
  });
});
