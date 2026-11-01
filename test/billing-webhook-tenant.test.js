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
