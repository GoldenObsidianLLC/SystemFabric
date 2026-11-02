'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHmac } = require('node:crypto');
const { createApiServer } = require('../apps/api/src/server');

const WEBHOOK_SECRET = 'whsec_systemfabric_refund_test';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SITE_ID = '99999999-9999-4999-8999-999999999999';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ORDER_ID = '88888888-8888-4888-8888-888888888888';
const REFUND_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_REFUND_ID = '77777777-7777-4777-8777-777777777777';
const PAYMENT_INTENT_ID = 'pi_test123';
const OTHER_PAYMENT_INTENT_ID = 'pi_other123';
const PROVIDER_REFUND_ID = 're_test123';

function signedPayload(event) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(String(timestamp) + '.')
    .update(rawBody)
    .digest('hex');
  return { rawBody, signature: `t=${timestamp},v1=${signature}` };
}

function makeRefundWebhookHarness(t, {
  totalMinor = '4000',
  refundStatus = 'requested',
  providerRefundId = null
} = {}) {
  const state = {
    seenEvents: new Set(),
    refund: {
      id: REFUND_ID,
      site_id: SITE_ID,
      order_id: ORDER_ID,
      provider: 'stripe',
      provider_refund_id: providerRefundId,
      amount_minor: '4000',
      currency: 'USD',
      status: refundStatus
    },
    order: {
      id: ORDER_ID,
      site_id: SITE_ID,
      provider: 'stripe',
      provider_payment_id: PAYMENT_INTENT_ID,
      total_minor: totalMinor,
      status: 'paid'
    },
    refundUpdates: 0,
    orderRefundTransitions: 0,
    queries: []
  };

  const client = {
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };

      if (sql.includes('INSERT INTO billing_webhook_events')) {
        const eventId = params[0];
        if (state.seenEvents.has(eventId)) return { rows: [] };
        state.seenEvents.add(eventId);
        return { rows: [{ provider_event_id: eventId }] };
      }

      if (sql.includes('FROM commerce_orders') && sql.includes('FOR UPDATE')) {
        const [siteId, orderId, paymentIntentId] = params;
        return {
          rows: state.order.site_id === siteId && state.order.id === orderId &&
            state.order.provider === 'stripe' && state.order.provider_payment_id === paymentIntentId
            ? [{ ...state.order }]
            : []
        };
      }

      if (sql.includes('UPDATE commerce_refunds') && sql.includes('SET provider_refund_id=COALESCE')) {
        const [providerRefundIdValue, siteId, orderId, amountMinor, currency, refundId, status] = params;
        const row = state.refund;
        const matches = row.site_id === siteId &&
          row.order_id === orderId &&
          row.provider === 'stripe' &&
          BigInt(row.amount_minor) === BigInt(amountMinor) &&
          row.currency.toUpperCase() === currency &&
          (row.provider_refund_id === providerRefundIdValue ||
            (row.provider_refund_id === null && row.id === refundId)) &&
          state.order.site_id === row.site_id &&
          state.order.id === row.order_id &&
          state.order.provider === 'stripe';
        if (!matches) return { rows: [] };
        row.provider_refund_id ||= providerRefundIdValue;
        if (!['succeeded', 'failed', 'cancelled'].includes(row.status)) row.status = status;
        state.refundUpdates += 1;
        return { rows: [{ id: row.id, site_id: row.site_id, order_id: row.order_id, status: row.status }] };
      }

      if (sql.includes('UPDATE commerce_orders') && sql.includes("SET status='refunded'")) {
        if (
          state.order.site_id === params[0] &&
          state.order.id === params[1] &&
          state.refund.status === 'succeeded' &&
          BigInt(state.refund.amount_minor) >= BigInt(state.order.total_minor) &&
          ['paid', 'processing', 'fulfilled'].includes(state.order.status)
        ) {
          state.order.status = 'refunded';
          state.orderRefundTransitions += 1;
        }
        return { rows: [] };
      }

      if (sql.includes('UPDATE billing_webhook_events')) return { rows: [] };
      throw new Error('Unexpected refund webhook query: ' + sql);
    },
    release() {}
  };

  const pool = {
    async query() { return { rows: [] }; },
    async connect() { return client; },
    async end() {}
  };
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    pool,
    logger: { error() {} }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(async () => {
        await new Promise(done => server.close(done));
        await server.systemfabric.close();
      });
      resolve({ state, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

async function sendEvent(base, event) {
  const signed = signedPayload(event);
  const target = new URL(base + '/api/v1/billing/stripe/webhook');
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': signed.rawBody.length,
        'stripe-signature': signed.signature
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          async json() { return JSON.parse(body); }
        });
      });
    });
    request.on('error', reject);
    request.end(signed.rawBody);
  });
}

function refundEvent({
  eventId = 'evt_refund_update_1',
  type = 'refund.updated',
  siteId = SITE_ID,
  orderId = ORDER_ID,
  refundId = REFUND_ID,
  paymentIntentId = PAYMENT_INTENT_ID,
  providerRefundId = PROVIDER_REFUND_ID,
  amount = 4000,
  currency = 'usd',
  status = 'succeeded'
} = {}) {
  return {
    id: eventId,
    type,
    data: {
      object: {
        id: providerRefundId,
        object: 'refund',
        payment_intent: paymentIntentId,
        amount,
        currency,
        status,
        metadata: { site_id: siteId, order_id: orderId, refund_id: refundId }
      }
    }
  };
}

test('Stripe refund webhooks bind exact tenant, order, refund and PaymentIntent, then close a fully refunded order', async t => {
  const { state, base } = await makeRefundWebhookHarness(t);

  const accepted = await sendEvent(base, refundEvent());
  assert.equal(accepted.status, 200);
  assert.equal(state.refund.provider_refund_id, PROVIDER_REFUND_ID);
  assert.equal(state.refund.status, 'succeeded');
  assert.equal(state.order.status, 'refunded');
  assert.equal(state.orderRefundTransitions, 1);

  const orderLockIndex = state.queries.findIndex(query =>
    query.sql.includes('FROM commerce_orders') && query.sql.includes('FOR UPDATE')
  );
  const refundUpdateIndex = state.queries.findIndex(query =>
    query.sql.includes('UPDATE commerce_refunds') && query.sql.includes('SET provider_refund_id=COALESCE')
  );
  assert.ok(orderLockIndex >= 0 && refundUpdateIndex > orderLockIndex, 'webhook locks order before refund row');

  const duplicate = await sendEvent(base, refundEvent());
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(state.refundUpdates, 1);
  assert.equal(state.orderRefundTransitions, 1);
});

test('out-of-order refund.created or pending updates cannot downgrade a succeeded refund', async t => {
  const { state, base } = await makeRefundWebhookHarness(t);

  const succeeded = await sendEvent(base, refundEvent({ eventId: 'evt_refund_succeeded', status: 'succeeded' }));
  assert.equal(succeeded.status, 200);
  assert.equal(state.refund.status, 'succeeded');

  const lateCreated = await sendEvent(base, refundEvent({
    eventId: 'evt_refund_created_late',
    type: 'refund.created',
    status: 'pending'
  }));
  assert.equal(lateCreated.status, 200);
  assert.equal(state.refund.status, 'succeeded');
  assert.equal(state.order.status, 'refunded');
  assert.equal(state.orderRefundTransitions, 1);
});

test('refund webhooks with mismatched tenant, order, refund, PaymentIntent or amount cannot mutate state', async t => {
  const { state, base } = await makeRefundWebhookHarness(t);
  const invalidEvents = [
    refundEvent({ eventId: 'evt_bad_site', siteId: OTHER_SITE_ID }),
    refundEvent({ eventId: 'evt_bad_order', orderId: OTHER_ORDER_ID }),
    refundEvent({ eventId: 'evt_bad_refund', refundId: OTHER_REFUND_ID }),
    refundEvent({ eventId: 'evt_bad_payment', paymentIntentId: OTHER_PAYMENT_INTENT_ID }),
    refundEvent({ eventId: 'evt_bad_amount', amount: 3999 }),
    refundEvent({ eventId: 'evt_bad_currency', currency: 'eur' })
  ];

  for (const event of invalidEvents) {
    const response = await sendEvent(base, event);
    assert.equal(response.status, 200);
  }
  assert.equal(state.refund.provider_refund_id, null);
  assert.equal(state.refund.status, 'requested');
  assert.equal(state.refundUpdates, 0);
  assert.equal(state.order.status, 'paid');
});

test('refund.failed is recorded and terminal outcomes are not replaced by stale success events', async t => {
  const { state, base } = await makeRefundWebhookHarness(t);

  const failed = await sendEvent(base, refundEvent({
    eventId: 'evt_refund_failed',
    type: 'refund.failed',
    status: 'failed'
  }));
  assert.equal(failed.status, 200);
  assert.equal(state.refund.status, 'failed');

  const lateSuccess = await sendEvent(base, refundEvent({
    eventId: 'evt_refund_late_success',
    status: 'succeeded'
  }));
  assert.equal(lateSuccess.status, 200);
  assert.equal(state.refund.status, 'failed');
  assert.equal(state.order.status, 'paid');
});

test('refund webhook may bind a PaymentIntent represented as an expanded Stripe object', async t => {
  const { state, base } = await makeRefundWebhookHarness(t);
  const event = refundEvent({ eventId: 'evt_refund_expanded_payment_intent' });
  event.data.object.payment_intent = { id: PAYMENT_INTENT_ID };

  const response = await sendEvent(base, event);
  assert.equal(response.status, 200);
  assert.equal(state.refund.provider_refund_id, PROVIDER_REFUND_ID);
  assert.equal(state.refund.status, 'succeeded');
});

test('refund.created may bind the provider refund ID before the API response is persisted', async t => {
  const { state, base } = await makeRefundWebhookHarness(t);
  const created = await sendEvent(base, refundEvent({
    eventId: 'evt_refund_created_first',
    type: 'refund.created',
    status: 'pending'
  }));
  assert.equal(created.status, 200);
  assert.equal(state.refund.provider_refund_id, PROVIDER_REFUND_ID);
  assert.equal(state.refund.status, 'pending');
  assert.equal(state.order.status, 'paid');

  const succeeded = await sendEvent(base, refundEvent({
    eventId: 'evt_refund_success_after_created',
    type: 'refund.updated',
    status: 'succeeded'
  }));
  assert.equal(succeeded.status, 200);
  assert.equal(state.refund.status, 'succeeded');
  assert.equal(state.order.status, 'refunded');
});

test('partial refund webhook records the refund without marking the entire order refunded', async t => {
  const { state, base } = await makeRefundWebhookHarness(t, { totalMinor: '10000' });
  const response = await sendEvent(base, refundEvent());
  assert.equal(response.status, 200);
  assert.equal(state.refund.status, 'succeeded');
  assert.equal(state.order.status, 'paid');
  assert.equal(state.orderRefundTransitions, 0);
});

test('a refund already linked to a different provider refund ID cannot be rebound by metadata', async t => {
  const { state, base } = await makeRefundWebhookHarness(t, { providerRefundId: 're_other123' });
  const response = await sendEvent(base, refundEvent());
  assert.equal(response.status, 200);
  assert.equal(state.refund.provider_refund_id, 're_other123');
  assert.equal(state.refund.status, 'requested');
  assert.equal(state.refundUpdates, 0);
  assert.equal(state.order.status, 'paid');
});
