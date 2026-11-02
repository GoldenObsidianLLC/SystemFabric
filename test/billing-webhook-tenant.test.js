'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createApiServer } = require('../apps/api/src/server');

const WEBHOOK_SECRET = 'whsec_systemfabric_tenant_test';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAN_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUBSCRIPTION_ID = 'sub_shared_provider_identifier';

function signedPayload(event) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(String(timestamp) + '.')
    .update(rawBody)
    .digest('hex');
  return {
    rawBody,
    signature: 't=' + timestamp + ',v1=' + signature
  };
}

test('Stripe subscription updates require and apply the full site/user/plan provider binding', async t => {
  const clientQueries = [];
  const poolQueries = [];
  const client = {
    async query(sql, params = []) {
      clientQueries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO billing_webhook_events')) return { rows: [{ provider_event_id: params[0] }], rowCount: 1 };
      if (sql.includes('UPDATE paid_memberships')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE billing_webhook_events')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected transaction query: ' + sql);
    },
    release() {}
  };
  const pool = {
    async query(sql, params = []) {
      poolQueries.push({ sql, params });
      if (sql.includes('FROM firewall_rules WHERE enabled=true')) return { rows: [] };
      throw new Error('Unexpected non-transaction query: ' + sql);
    },
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await server.systemfabric.close();
  });

  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/health')).status, 200);
  const firewallQueriesAfterWarmup = poolQueries.length;

  const validEvent = {
    id: 'evt_subscription_tenant_a',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: SUBSCRIPTION_ID,
        status: 'past_due',
        cancel_at_period_end: true,
        current_period_start: 1_800_000_000,
        current_period_end: 1_802_592_000,
        metadata: {
          purchase_type: 'membership',
          site_id: SITE_A,
          user_id: USER_A,
          membership_plan_id: PLAN_A
        }
      }
    }
  };
  const valid = signedPayload(validEvent);
  const accepted = await fetch(base + '/api/v1/billing/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': valid.signature },
    body: valid.rawBody
  });
  assert.equal(accepted.status, 200);

  const scopedUpdate = clientQueries.find(query => query.sql.includes('UPDATE paid_memberships'));
  assert.ok(scopedUpdate, 'valid membership metadata must allow a subscription status update');
  assert.match(scopedUpdate.sql, /WHERE site_id=\$1 AND provider='stripe' AND provider_subscription_id=\$2 AND user_id=\$3 AND plan_id=\$4/);
  assert.deepEqual(scopedUpdate.params, [
    SITE_A, SUBSCRIPTION_ID, USER_A, PLAN_A, 'past_due', true, 1_800_000_000, 1_802_592_000
  ]);

  const beforeUnboundEvent = clientQueries.length;
  const unboundEvent = {
    id: 'evt_subscription_without_tenant_binding',
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: SUBSCRIPTION_ID,
        status: 'canceled',
        cancel_at_period_end: false,
        current_period_start: 0,
        current_period_end: 0
      }
    }
  };
  const unbound = signedPayload(unboundEvent);
  const ignored = await fetch(base + '/api/v1/billing/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': unbound.signature },
    body: unbound.rawBody
  });
  assert.equal(ignored.status, 200);
  assert.equal(
    clientQueries.slice(beforeUnboundEvent).some(query => query.sql.includes('UPDATE paid_memberships')),
    false,
    'a signed subscription event without tenant binding must not update any tenant membership'
  );
  assert.equal(poolQueries.length, firewallQueriesAfterWarmup, 'subscription processing must not perform tenant reads outside the transaction');
});

const ORDER_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION_A = 'cs_test_expected_session';

function createOrderWebhookHarness(t, { providerSessionId = SESSION_A } = {}) {
  const state = {
    order: {
      id: ORDER_A, site_id: SITE_A, provider: 'stripe',
      provider_session_id: providerSessionId, status: 'pending_payment'
    },
    seenEvents: new Set(),
    paidQueries: [],
    failedQueries: [],
    paidUpdates: 0,
    failedUpdates: 0,
    stockCommits: 0,
    stockReleases: 0
  };

  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

      if (sql.includes('INSERT INTO billing_webhook_events')) {
        const eventId = params[0];
        if (state.seenEvents.has(eventId)) return { rows: [] };
        state.seenEvents.add(eventId);
        return { rows: [{ provider_event_id: eventId }] };
      }

      if (sql.includes('UPDATE commerce_orders') && sql.includes("SET status='paid'")) {
        state.paidQueries.push({ sql, params });
        const [siteId, orderId, sessionId] = params;
        const sessionMatches = state.order.provider_session_id === sessionId;
        const unlinkedMetadataMatches = state.order.provider_session_id === null &&
          state.order.site_id === siteId && state.order.id === orderId;
        const eligible = state.order.provider === 'stripe' &&
          ['pending_payment', 'processing'].includes(state.order.status) &&
          (sessionMatches || unlinkedMetadataMatches);
        if (!eligible) return { rows: [] };
        state.order.status = 'paid';
        state.order.provider_session_id = sessionId;
        state.paidUpdates += 1;
        return { rows: [{ id: state.order.id, site_id: state.order.site_id }] };
      }

      if (sql.includes('UPDATE commerce_orders') && sql.includes("SET status='failed'")) {
        state.failedQueries.push({ sql, params });
        const [sessionId, siteId, orderId] = params;
        const sessionMatches = state.order.provider_session_id === sessionId;
        const unlinkedMetadataMatches = state.order.provider_session_id === null &&
          state.order.site_id === siteId && state.order.id === orderId;
        const eligible = state.order.provider === 'stripe' &&
          state.order.status === 'pending_payment' &&
          (sessionMatches || unlinkedMetadataMatches);
        if (!eligible) return { rows: [] };
        state.order.status = 'failed';
        state.order.provider_session_id = state.order.provider_session_id || sessionId;
        state.failedUpdates += 1;
        return { rows: [{ id: state.order.id, site_id: state.order.site_id }] };
      }

      if (sql.includes("UPDATE commerce_stock_reservations SET status='committed'")) {
        state.stockCommits += 1;
        return { rows: [{ id: 'reservation-1' }] };
      }
      if (sql.includes('WITH released AS')) {
        state.stockReleases += 1;
        return { rows: [{ released_count: 1 }] };
      }
      if (sql.includes('UPDATE billing_webhook_events')) return { rows: [] };
      throw new Error('Unexpected webhook transaction query: ' + sql);
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
      NODE_ENV: 'test', AI_PROVIDER: 'mock',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, RATE_LIMIT_MAX_REQUESTS: '100'
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

async function sendWebhook(base, event) {
  const signed = signedPayload(event);
  return fetch(base + '/api/v1/billing/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signed.signature },
    body: signed.rawBody
  });
}

test('Stripe checkout webhooks cannot pay or release an order through a mismatched session ID', async t => {
  const { state, base } = await createOrderWebhookHarness(t);
  const metadata = { site_id: SITE_A, order_id: ORDER_A };

  const expired = await sendWebhook(base, {
    id: 'evt_expired_wrong_session',
    type: 'checkout.session.expired',
    data: { object: { id: 'cs_test_wrong_session', status: 'expired', payment_status: 'unpaid', metadata } }
  });
  assert.equal(expired.status, 200);

  const paid = await sendWebhook(base, {
    id: 'evt_paid_wrong_session',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_wrong_session', status: 'complete', payment_status: 'paid', metadata } }
  });
  assert.equal(paid.status, 200);

  assert.equal(state.order.status, 'pending_payment');
  assert.equal(state.paidUpdates, 0);
  assert.equal(state.failedUpdates, 0);
  assert.equal(state.stockCommits, 0);
  assert.equal(state.stockReleases, 0);
  assert.match(state.paidQueries[0].sql, /provider='stripe'.*provider_session_id=\$3/s);
  assert.match(state.failedQueries[0].sql, /provider='stripe'.*provider_session_id=\$1/s);
});

test('Stripe async payment success supports the unlinked-session race and duplicate delivery', async t => {
  const { state, base } = await createOrderWebhookHarness(t, { providerSessionId: null });
  const completed = await sendWebhook(base, {
    id: 'evt_checkout_completed_unpaid',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: SESSION_A, status: 'complete', payment_status: 'unpaid',
        metadata: { site_id: SITE_A, order_id: ORDER_A }
      }
    }
  });
  assert.equal(completed.status, 200);
  assert.equal(state.order.status, 'pending_payment');
  assert.equal(state.stockCommits, 0);

  const event = {
    id: 'evt_checkout_async_paid',
    type: 'checkout.session.async_payment_succeeded',
    data: {
      object: {
        id: SESSION_A, status: 'complete', payment_status: 'paid',
        payment_intent: 'pi_test_paid',
        metadata: { site_id: SITE_A, order_id: ORDER_A }
      }
    }
  };
  const accepted = await sendWebhook(base, event);
  assert.equal(accepted.status, 200);
  assert.equal(state.order.status, 'paid');
  assert.equal(state.order.provider_session_id, SESSION_A);
  assert.equal(state.paidUpdates, 1);
  assert.equal(state.stockCommits, 1);

  const duplicate = await sendWebhook(base, event);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(state.paidUpdates, 1);
  assert.equal(state.stockCommits, 1);
});

test('Stripe expiry event matches the persisted provider session and releases a reservation once', async t => {
  const { state, base } = await createOrderWebhookHarness(t);
  const event = {
    id: 'evt_checkout_expired',
    type: 'checkout.session.expired',
    data: { object: { id: SESSION_A, status: 'expired', payment_status: 'unpaid' } }
  };

  const accepted = await sendWebhook(base, event);
  assert.equal(accepted.status, 200);
  assert.equal(state.order.status, 'failed');
  assert.equal(state.failedUpdates, 1);
  assert.equal(state.stockReleases, 1);

  const duplicate = await sendWebhook(base, event);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(state.failedUpdates, 1);
  assert.equal(state.stockReleases, 1);
});
