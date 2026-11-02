'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createApiServer } = require('../apps/api/src/server');

const WEBHOOK_SECRET = 'whsec_systemfabric_tenant_test';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAN_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUBSCRIPTION_ID = 'sub_sharedprovideridentifier';

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

function membershipMetadata(overrides = {}) {
  return {
    purchase_type: 'membership',
    site_id: SITE_A,
    user_id: USER_A,
    membership_plan_id: PLAN_A,
    ...overrides
  };
}

function createSubscriptionWebhookHarness(t, {
  currentSubscription = {
    id: SUBSCRIPTION_ID,
    status: 'active',
    cancel_at_period_end: true,
    current_period_start: 1_800_000_000,
    current_period_end: 1_802_592_000,
    metadata: membershipMetadata()
  },
  membershipRows = [{ id: 'membership-row-1', provider_subscription_id: SUBSCRIPTION_ID }],
  providerError = null
} = {}) {
  const state = {
    currentSubscription,
    membershipRows,
    providerCalls: [],
    queries: [],
    commits: 0,
    rollbacks: 0,
    updates: []
  };
  const client = {
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      if (sql === 'BEGIN') return { rows: [] };
      if (sql === 'COMMIT') { state.commits += 1; return { rows: [] }; }
      if (sql === 'ROLLBACK') { state.rollbacks += 1; return { rows: [] }; }
      if (sql.includes('INSERT INTO billing_webhook_events')) return { rows: [{ provider_event_id: params[0] }], rowCount: 1 };
      if (sql.includes('FROM paid_memberships') && sql.includes('FOR UPDATE')) {
        return { rows: state.membershipRows.map(row => ({ ...row })) };
      }
      if (sql.includes('UPDATE paid_memberships')) {
        state.updates.push({ sql, params });
        return { rows: [{ id: 'membership-row-1' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE billing_webhook_events')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected transaction query: ' + sql);
    },
    release() {}
  };
  const pool = {
    async query(sql) {
      if (sql.includes('FROM firewall_rules WHERE enabled=true')) return { rows: [] };
      throw new Error('Unexpected non-transaction query: ' + sql);
    },
    async connect() { return client; },
    async end() {}
  };
  const stripeFetch = async (url, options) => {
    state.providerCalls.push({ url: String(url), options });
    if (providerError) throw providerError;
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify(state.currentSubscription); }
    };
  };
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_SECRET_KEY: 'sk_test_systemfabric_fixture',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    pool,
    stripeFetch,
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

async function sendSubscriptionWebhook(base, event) {
  const signed = signedPayload(event);
  return fetch(base + '/api/v1/billing/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signed.signature },
    body: signed.rawBody
  });
}

test('Stripe subscription webhooks reconcile the current provider state, not stale event snapshots', async t => {
  const { state, base } = await createSubscriptionWebhookHarness(t);
  const accepted = await sendSubscriptionWebhook(base, {
    id: 'evt_subscription_tenant_a',
    created: 1,
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: SUBSCRIPTION_ID,
        status: 'past_due',
        cancel_at_period_end: false,
        metadata: membershipMetadata()
      }
    }
  });
  assert.equal(accepted.status, 200);
  assert.equal(state.providerCalls.length, 1);
  assert.equal(state.providerCalls[0].url, 'https://api.stripe.com/v1/subscriptions/' + SUBSCRIPTION_ID);
  assert.equal(state.providerCalls[0].options.method, 'GET');
  assert.equal(state.providerCalls[0].options.headers.authorization, 'Bearer sk_test_systemfabric_fixture');

  const scopedUpdate = state.updates[0];
  assert.ok(scopedUpdate, 'a tenant-bound membership must be updated');
  assert.match(scopedUpdate.sql, /WHERE id=\$1 AND site_id=\$2 AND user_id=\$3 AND plan_id=\$9/);
  assert.deepEqual(scopedUpdate.params, [
    'membership-row-1', SITE_A, USER_A, SUBSCRIPTION_ID, 'active', true,
    1_800_000_000, 1_802_592_000, PLAN_A
  ]);
});

test('Basil and legacy invoice subscription metadata both trigger canonical state reconciliation', async t => {
  const { state, base } = await createSubscriptionWebhookHarness(t, {
    currentSubscription: {
      id: SUBSCRIPTION_ID,
      status: 'paused',
      cancel_at_period_end: false,
      items: {
        data: [
          { id: 'si_monthly', current_period_start: 1_800_000_000, current_period_end: 1_802_592_000 },
          { id: 'si_annual', current_period_start: 1_800_300_000, current_period_end: 1_900_000_000 }
        ]
      },
      metadata: membershipMetadata()
    }
  });
  for (const [eventId, details] of [
    ['evt_invoice_basil', { parent: { subscription_details: { subscription: SUBSCRIPTION_ID, metadata: membershipMetadata() } } }],
    ['evt_invoice_legacy', { subscription_details: { metadata: membershipMetadata() }, subscription: SUBSCRIPTION_ID }]
  ]) {
    const response = await sendSubscriptionWebhook(base, {
      id: eventId,
      type: 'invoice.payment_failed',
      created: 2,
      data: { object: { id: 'in_fixture', ...details } }
    });
    assert.equal(response.status, 200);
    assert.equal(state.updates.at(-1).params[4], 'paused', 'the current Stripe subscription state is authoritative');
    assert.equal(state.updates.at(-1).params[6], 1_800_300_000, 'Basil item periods use the latest item start');
    assert.equal(state.updates.at(-1).params[7], 1_802_592_000, 'Basil item periods use the earliest item end');
  }
  assert.equal(state.providerCalls.length, 2);
});

test('unbound subscription events are ignored without provider reads or tenant mutations', async t => {
  const { state, base } = await createSubscriptionWebhookHarness(t);
  const ignored = await sendSubscriptionWebhook(base, {
    id: 'evt_subscription_without_tenant_binding',
    type: 'customer.subscription.deleted',
    data: { object: { id: SUBSCRIPTION_ID, status: 'canceled' } }
  });
  assert.equal(ignored.status, 200);
  assert.equal(state.providerCalls.length, 0);
  assert.equal(state.updates.length, 0);
});

test('provider read failures roll back the webhook receipt so delivery can be retried', async t => {
  const { state, base } = await createSubscriptionWebhookHarness(t, {
    providerError: new Error('test provider unavailable')
  });
  const response = await sendSubscriptionWebhook(base, {
    id: 'evt_subscription_provider_unavailable',
    type: 'customer.subscription.updated',
    data: { object: { id: SUBSCRIPTION_ID, metadata: membershipMetadata() } }
  });
  assert.equal(response.status, 503);
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.updates.length, 0);
});

test('subscription events received before the local membership row are retried, not acknowledged', async t => {
  const { state, base } = await createSubscriptionWebhookHarness(t, { membershipRows: [] });
  const response = await sendSubscriptionWebhook(base, {
    id: 'evt_subscription_before_membership_insert',
    type: 'customer.subscription.created',
    data: { object: { id: SUBSCRIPTION_ID, metadata: membershipMetadata() } }
  });
  assert.equal(response.status, 503);
  assert.equal(state.providerCalls.length, 0);
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.updates.length, 0);
});

test('mismatched current provider metadata cannot be rebound through an older signed event', async t => {
  const { state, base } = await createSubscriptionWebhookHarness(t, {
    currentSubscription: {
      id: SUBSCRIPTION_ID,
      status: 'active',
      metadata: membershipMetadata({ user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
    }
  });
  const response = await sendSubscriptionWebhook(base, {
    id: 'evt_subscription_mismatched_current_metadata',
    type: 'customer.subscription.updated',
    data: { object: { id: SUBSCRIPTION_ID, metadata: membershipMetadata() } }
  });
  assert.equal(response.status, 200);
  assert.equal(state.providerCalls.length, 1);
  assert.equal(state.updates.length, 0);
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
