'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStripeRefund } = require('../packages/billing/src/stripe');
const { handlePlatformRoute } = require('../apps/api/src/platform-routes');

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const REFUND_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYMENT_INTENT_ID = 'pi_test123';
const REQUEST_KEY = 'refund-request-001';

function refundArgs(extra = {}) {
  return {
    secretKey: 'sk_test_fixture_not_a_real_key',
    paymentIntentId: PAYMENT_INTENT_ID,
    amountMinor: 2500,
    reason: 'requested_by_customer',
    idempotencyKey: 'sf_refund_333333333333',
    metadata: { site_id: SITE_ID, order_id: ORDER_ID, refund_id: REFUND_ID },
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      async text() {
        refundArgs.lastOptions = options;
        return JSON.stringify({
          id: 're_test123',
          payment_intent: PAYMENT_INTENT_ID,
          amount: 2500,
          currency: 'usd',
          reason: 'requested_by_customer',
          status: 'succeeded'
        });
      }
    }),
    ...extra
  };
}

function providerResponse({
  id = 're_test123',
  payment_intent = PAYMENT_INTENT_ID,
  amount = 2500,
  currency = 'usd',
  reason = 'requested_by_customer',
  status = 'succeeded'
} = {}) {
  return { id, payment_intent, amount, currency, reason, status };
}

function makeRefundContext({
  body = { amountMinor: 2500, reason: 'requested_by_customer', idempotencyKey: REQUEST_KEY },
  order = {
    id: ORDER_ID,
    site_id: SITE_ID,
    status: 'paid',
    currency: 'USD',
    total_minor: '10000',
    provider: 'stripe',
    provider_payment_id: PAYMENT_INTENT_ID
  },
  refunds = [],
  allowManage = true,
  headers = {}
} = {}) {
  const state = { order: { ...order }, refunds: refunds.map(row => ({ ...row })), calls: [] };
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          state.calls.push({ sql, params });
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };

          if (sql.includes('FROM commerce_orders') && sql.includes('FOR UPDATE')) {
            const [siteId, orderId, paymentIntentId] = params;
            const matches = state.order.site_id === siteId &&
              state.order.id === orderId &&
              (!paymentIntentId || (
                state.order.provider === 'stripe' &&
                state.order.provider_payment_id === paymentIntentId
              ));
            return { rows: matches ? [{ ...state.order }] : [] };
          }
          if (sql.includes('FROM commerce_refunds WHERE site_id=$1 AND order_id=$2 AND idempotency_key=$3')) {
            const row = state.refunds.find(item =>
              item.site_id === params[0] && item.order_id === params[1] && item.idempotency_key === params[2]
            );
            return { rows: row ? [{ ...row }] : [] };
          }
          if (sql.includes('SELECT COALESCE(SUM(amount_minor),0)::text AS reserved_minor')) {
            const reserved = state.refunds
              .filter(row => row.site_id === params[0] && row.order_id === params[1])
              .filter(row => ['requested', 'pending', 'succeeded'].includes(row.status))
              .reduce((sum, row) => sum + BigInt(row.amount_minor), 0n);
            return { rows: [{ reserved_minor: reserved.toString() }] };
          }
          if (sql.includes('INSERT INTO commerce_refunds')) {
            const row = {
              id: REFUND_ID,
              site_id: params[0],
              order_id: params[1],
              provider: 'stripe',
              amount_minor: String(params[2]),
              currency: params[3],
              reason: params[4],
              status: 'requested',
              created_by: params[5],
              idempotency_key: params[6],
              provider_refund_id: null
            };
            state.refunds.push(row);
            return { rows: [{ ...row }] };
          }
          if (sql.includes("UPDATE commerce_refunds SET status='failed'")) {
            const row = state.refunds.find(item => item.id === params[2]);
            if (row && ['requested', 'pending'].includes(row.status)) row.status = 'failed';
            return { rows: [] };
          }
          if (sql.includes('UPDATE commerce_refunds') && sql.includes('SET provider_refund_id=COALESCE')) {
            const row = state.refunds.find(item =>
              item.site_id === params[0] && item.order_id === params[1] && item.id === params[2]
            );
            if (!row || (row.provider_refund_id && row.provider_refund_id !== params[3])) return { rows: [] };
            row.provider_refund_id ||= params[3];
            if (!['succeeded', 'failed', 'cancelled'].includes(row.status)) row.status = params[4];
            return { rows: [{
              id: row.id,
              provider_refund_id: row.provider_refund_id,
              amount_minor: row.amount_minor,
              currency: row.currency,
              reason: row.reason,
              status: row.status
            }] };
          }
          if (sql.includes('UPDATE commerce_orders') && sql.includes("SET status='refunded'")) {
            const succeeded = state.refunds
              .filter(row => row.site_id === params[0] && row.order_id === params[1] && row.status === 'succeeded')
              .reduce((sum, row) => sum + BigInt(row.amount_minor), 0n);
            if (succeeded >= BigInt(state.order.total_minor) && ['paid', 'processing', 'fulfilled'].includes(state.order.status)) {
              state.order.status = 'refunded';
            }
            return { rows: [] };
          }
          throw new Error('Unexpected refund query: ' + sql);
        },
        release() {}
      };
    }
  };

  const ctx = {
    req: { method: 'POST', headers },
    res: {},
    url: new URL(`http://systemfabric.local/api/v1/sites/${SITE_ID}/commerce/orders/${ORDER_ID}/refunds`),
    actor: { user: { id: ACTOR_ID, email: 'operator@example.test' } },
    localPool: pool,
    async siteIdFor({ routeSiteId }) {
      assert.equal(routeSiteId, SITE_ID);
      return SITE_ID;
    },
    async requireCapability(_actor, siteId, capability) {
      assert.equal(siteId, SITE_ID);
      assert.equal(capability, 'commerce:manage');
      if (!allowManage) throw Object.assign(new Error('forbidden'), { statusCode: 403, code: 'ERR_SYSTEMFABRIC_FORBIDDEN' });
    },
    async readJson() { return body; },
    sendJson(_res, statusCode, payload) {
      ctx.res.statusCode = statusCode;
      ctx.res.payload = payload;
      return true;
    },
    fail(statusCode, code, message) {
      return Object.assign(new Error(message), { statusCode, code });
    },
    requestId: 'refund-test-request',
    maxBody: 150_000,
    env: { STRIPE_SECRET_KEY: 'sk_test_fixture_not_a_real_key' },
    identity: { async audit() {} }
  };
  return { ctx, state };
}

async function withFetch(fetchImpl, action) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  try {
    return await action();
  } finally {
    global.fetch = originalFetch;
  }
}

test('Stripe refund helper posts the exact PaymentIntent amount, metadata and stable idempotency key', async () => {
  const refund = await createStripeRefund(refundArgs());
  assert.deepEqual(refund, {
    id: 're_test123',
    paymentIntentId: PAYMENT_INTENT_ID,
    amount: 2500,
    currency: 'USD',
    reason: 'requested_by_customer',
    status: 'succeeded'
  });
  const options = refundArgs.lastOptions;
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.authorization, 'Bearer sk_test_fixture_not_a_real_key');
  assert.equal(options.headers['idempotency-key'], 'sf_refund_333333333333');
  const form = new URLSearchParams(options.body);
  assert.equal(form.get('payment_intent'), PAYMENT_INTENT_ID);
  assert.equal(form.get('amount'), '2500');
  assert.equal(form.get('reason'), 'requested_by_customer');
  assert.equal(form.get('metadata[site_id]'), SITE_ID);
  assert.equal(form.get('metadata[order_id]'), ORDER_ID);
  assert.equal(form.get('metadata[refund_id]'), REFUND_ID);
});

test('Stripe refund helper rejects invalid amounts, reasons, payment IDs and idempotency keys before network I/O', async () => {
  for (const patch of [
    { amountMinor: 0 },
    { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { paymentIntentId: 'ch_not_a_payment_intent' },
    { reason: 'other' },
    { idempotencyKey: 'bad' },
    { metadata: { 'invalid key': 'value' } },
    { metadata: { safe: 42 } }
  ]) {
    let called = false;
    await assert.rejects(
      createStripeRefund(refundArgs({ ...patch, fetchImpl: async () => { called = true; throw new Error('unexpected network call'); } })),
      error => error.code === 'ERR_SYSTEMFABRIC_BILLING_CONFIG'
    );
    assert.equal(called, false);
  }
});

test('Stripe refund helper preserves an unknown outcome after network, response-body, 429 and 5xx failures', async () => {
  const failures = [
    async () => { throw new TypeError('socket closed'); },
    async () => ({ ok: true, status: 200, async text() { throw new TypeError('stream interrupted'); } }),
    async () => ({ ok: false, status: 429, async text() { return '{"error":"rate limited"}'; } }),
    async () => ({ ok: false, status: 503, async text() { return '{"error":"temporary"}'; } })
  ];
  for (const fetchImpl of failures) {
    await assert.rejects(
      createStripeRefund(refundArgs({ fetchImpl })),
      error => error.code === 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN' && error.statusCode === 502
    );
  }
});

test('Stripe refund helper treats a definitive provider 4xx as rejected, not ambiguous', async () => {
  await assert.rejects(
    createStripeRefund(refundArgs({
      fetchImpl: async () => ({ ok: false, status: 400, async text() { return '{"error":"invalid"}'; } })
    })),
    error => error.code === 'ERR_SYSTEMFABRIC_BILLING_PROVIDER'
  );
});

test('Stripe refund helper preserves unknown state when a successful response does not match the request', async () => {
  await assert.rejects(
    createStripeRefund(refundArgs({
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return JSON.stringify(providerResponse({ amount: 1 })); } })
    })),
    error => error.code === 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN'
  );
});

test('admin refund route reserves amounts, calls Stripe once and keeps partial refunds from closing the order', async () => {
  const { ctx, state } = makeRefundContext();
  await withFetch(async (_url, options) => ({
    ok: true,
    status: 200,
    async text() {
      const form = new URLSearchParams(options.body);
      assert.equal(options.headers['idempotency-key'], `sf_refund_${REFUND_ID}`);
      assert.equal(form.get('payment_intent'), PAYMENT_INTENT_ID);
      assert.equal(form.get('amount'), '2500');
      return JSON.stringify(providerResponse());
    }
  }), async () => {
    assert.equal(await handlePlatformRoute(ctx), true);
  });
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.payload.refund.status, 'succeeded');
  assert.equal(ctx.res.payload.refund.amountMinor, 2500);
  assert.equal(state.refunds.length, 1);
  assert.equal(state.order.status, 'paid');
  assert.equal(state.refunds[0].provider_refund_id, 're_test123');
  const finalOrderLockIndex = state.calls.findLastIndex(call =>
    call.sql.includes('FROM commerce_orders') && call.sql.includes('FOR UPDATE')
  );
  const finalRefundWriteIndex = state.calls.findLastIndex(call =>
    call.sql.includes('UPDATE commerce_refunds') && call.sql.includes('SET provider_refund_id=COALESCE')
  );
  assert.ok(finalOrderLockIndex >= 0 && finalRefundWriteIndex > finalOrderLockIndex, 'API locks order before refund row when persisting provider response');
});

test('same refund request retries an ambiguous provider outcome with the identical provider idempotency key', async () => {
  const { ctx, state } = makeRefundContext();
  const keys = [];
  await withFetch(async (_url, options) => {
    keys.push(options.headers['idempotency-key']);
    throw new TypeError('connection reset after request');
  }, async () => {
    await assert.rejects(
      handlePlatformRoute(ctx),
      error => error.code === 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN' && error.statusCode === 502
    );
  });
  assert.equal(state.refunds.length, 1);
  assert.equal(state.refunds[0].status, 'requested');

  await withFetch(async (_url, options) => {
    keys.push(options.headers['idempotency-key']);
    return { ok: true, status: 200, async text() { return JSON.stringify(providerResponse()); } };
  }, async () => {
    await handlePlatformRoute(ctx);
  });
  assert.equal(keys.length, 2);
  assert.deepEqual(keys, [`sf_refund_${REFUND_ID}`, `sf_refund_${REFUND_ID}`]);
  assert.equal(state.refunds[0].status, 'succeeded');
  assert.equal(state.refunds.length, 1);
  assert.equal(ctx.res.payload.idempotentReplay, true);
});

test('refund idempotency key cannot be reused with different amount or reason', async () => {
  const existing = {
    id: REFUND_ID,
    site_id: SITE_ID,
    order_id: ORDER_ID,
    provider: 'stripe',
    provider_refund_id: 're_test123',
    amount_minor: '2500',
    currency: 'USD',
    reason: 'requested_by_customer',
    status: 'succeeded',
    idempotency_key: REQUEST_KEY
  };
  const { ctx } = makeRefundContext({ refunds: [existing], body: { amountMinor: 2501, reason: 'requested_by_customer', idempotencyKey: REQUEST_KEY } });
  let called = false;
  await withFetch(async () => { called = true; throw new Error('must not call provider'); }, async () => {
    await assert.rejects(
      handlePlatformRoute(ctx),
      error => error.code === 'ERR_SYSTEMFABRIC_REFUND_IDEMPOTENCY_CONFLICT' && error.statusCode === 409
    );
  });
  assert.equal(called, false);
});

test('pending and successful refunds both consume the refundable order balance', async () => {
  const pending = {
    id: REFUND_ID, site_id: SITE_ID, order_id: ORDER_ID, provider: 'stripe', provider_refund_id: null,
    amount_minor: '3000', currency: 'USD', reason: 'requested_by_customer', status: 'pending', idempotency_key: 'old-refund-0001'
  };
  const succeeded = {
    id: '44444444-4444-4444-8444-444444444444', site_id: SITE_ID, order_id: ORDER_ID, provider: 'stripe', provider_refund_id: 're_old123',
    amount_minor: '2000', currency: 'USD', reason: 'requested_by_customer', status: 'succeeded', idempotency_key: 'old-refund-0002'
  };
  const { ctx, state } = makeRefundContext({ refunds: [pending, succeeded], body: { amountMinor: 6000, reason: 'requested_by_customer', idempotencyKey: REQUEST_KEY } });
  let called = false;
  await withFetch(async () => { called = true; throw new Error('balance must be rejected before provider call'); }, async () => {
    await assert.rejects(
      handlePlatformRoute(ctx),
      error => error.code === 'ERR_SYSTEMFABRIC_REFUND_EXCEEDS_BALANCE' && error.statusCode === 409
    );
  });
  assert.equal(called, false);
  assert.equal(state.refunds.length, 2);
});

test('refunds require a confirmed Stripe payment and the commerce management capability', async () => {
  const noPayment = makeRefundContext({ order: { id: ORDER_ID, site_id: SITE_ID, status: 'pending_payment', currency: 'USD', total_minor: '10000', provider: 'stripe', provider_payment_id: null } });
  await assert.rejects(handlePlatformRoute(noPayment.ctx), error => error.code === 'ERR_SYSTEMFABRIC_REFUND_PAYMENT_UNAVAILABLE');

  const denied = makeRefundContext({ allowManage: false });
  await assert.rejects(handlePlatformRoute(denied.ctx), error => error.code === 'ERR_SYSTEMFABRIC_FORBIDDEN');
});

test('refund route accepts the standard Idempotency-Key header without duplicating it in the body', async () => {
  const { ctx, state } = makeRefundContext({
    body: { amountMinor: 2500 },
    headers: { 'idempotency-key': REQUEST_KEY }
  });
  await withFetch(async () => ({
    ok: true,
    status: 200,
    async text() { return JSON.stringify(providerResponse()); }
  }), async () => {
    await handlePlatformRoute(ctx);
  });
  assert.equal(state.refunds[0].idempotency_key, REQUEST_KEY);
  assert.equal(ctx.res.payload.refund.status, 'succeeded');
});

test('refund route rejects conflicting body and header idempotency keys before database access', async () => {
  const { ctx, state } = makeRefundContext({
    body: { amountMinor: 2500, idempotencyKey: REQUEST_KEY },
    headers: { 'idempotency-key': 'refund-request-002' }
  });
  await assert.rejects(
    handlePlatformRoute(ctx),
    error => error.code === 'ERR_SYSTEMFABRIC_REFUND_IDEMPOTENCY' && error.statusCode === 400
  );
  assert.equal(state.calls.length, 0);
});

test('Stripe refund helper treats valid JSON with a non-object shape as an unknown outcome', async () => {
  for (const body of ['null', '[]', 'false', '"unexpected"']) {
    await assert.rejects(
      createStripeRefund(refundArgs({
        fetchImpl: async () => ({ ok: true, status: 200, async text() { return body; } })
      })),
      error => error.code === 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN' && error.statusCode === 502
    );
  }
});
