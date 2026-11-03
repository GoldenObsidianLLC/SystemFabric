'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { retrieveStripeSubscription } = require('../packages/billing/src/stripe');

const SECRET_KEY = 'sk_test_virgoscorpio_hub_subscription_fixture';
const SUBSCRIPTION_ID = 'sub_virgoscorpiohubfixture123';
const metadata = {
  purchase_type: 'membership',
  site_id: '11111111-1111-4111-8111-111111111111',
  user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  membership_plan_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); }
  };
}

test('subscription retrieval uses authenticated GET and validates the returned provider identity', async () => {
  const calls = [];
  const expected = { id: SUBSCRIPTION_ID, status: 'active', metadata };
  const actual = await retrieveStripeSubscription({
    secretKey: SECRET_KEY,
    subscriptionId: SUBSCRIPTION_ID,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(expected);
    }
  });

  assert.deepEqual(actual, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/subscriptions/' + SUBSCRIPTION_ID);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.authorization, 'Bearer ' + SECRET_KEY);
  assert.equal(calls[0].options.headers.accept, 'application/json');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('subscription retrieval rejects unsafe configuration before provider I/O', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({}); };

  await assert.rejects(
    retrieveStripeSubscription({ secretKey: 'not-a-secret', subscriptionId: SUBSCRIPTION_ID, fetchImpl }),
    { code: 'ERR_VIRGOSCORPIO_HUB_BILLING_DISABLED', statusCode: 503 }
  );
  await assert.rejects(
    retrieveStripeSubscription({ secretKey: SECRET_KEY, subscriptionId: 'sub_invalid-id', fetchImpl }),
    { code: 'ERR_VIRGOSCORPIO_HUB_BILLING_WEBHOOK_INVALID', statusCode: 400 }
  );
  await assert.rejects(
    retrieveStripeSubscription({ secretKey: SECRET_KEY, subscriptionId: SUBSCRIPTION_ID, fetchImpl, timeoutMs: 10 }),
    { code: 'ERR_VIRGOSCORPIO_HUB_BILLING_CONFIG', statusCode: 503 }
  );
  assert.equal(calls, 0);
});

test('transient provider failures remain retryable but definitive resource errors do not', async () => {
  for (const status of [429, 500, 503]) {
    await assert.rejects(
      retrieveStripeSubscription({
        secretKey: SECRET_KEY,
        subscriptionId: SUBSCRIPTION_ID,
        fetchImpl: async () => jsonResponse({ error: 'provider unavailable' }, status)
      }),
      { code: 'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER_UNAVAILABLE', statusCode: 503 }
    );
  }

  await assert.rejects(
    retrieveStripeSubscription({
      secretKey: SECRET_KEY,
      subscriptionId: SUBSCRIPTION_ID,
      fetchImpl: async () => jsonResponse({ error: 'not found' }, 404)
    }),
    { code: 'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER', statusCode: 502 }
  );

  await assert.rejects(
    retrieveStripeSubscription({
      secretKey: SECRET_KEY,
      subscriptionId: SUBSCRIPTION_ID,
      fetchImpl: async () => { throw new Error('network unavailable'); }
    }),
    { code: 'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER_UNAVAILABLE', statusCode: 503 }
  );
});

test('subscription retrieval rejects malformed or mismatched provider responses', async () => {
  const invalidResponses = [
    { id: 'sub_another_subscription', status: 'active', metadata },
    { id: SUBSCRIPTION_ID, status: 1, metadata },
    { id: SUBSCRIPTION_ID, status: 'active', metadata: null },
    []
  ];
  for (const response of invalidResponses) {
    await assert.rejects(
      retrieveStripeSubscription({
        secretKey: SECRET_KEY,
        subscriptionId: SUBSCRIPTION_ID,
        fetchImpl: async () => jsonResponse(response)
      }),
      { code: 'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER', statusCode: 502 }
    );
  }

  await assert.rejects(
    retrieveStripeSubscription({
      secretKey: SECRET_KEY,
      subscriptionId: SUBSCRIPTION_ID,
      fetchImpl: async () => ({ ok: true, status: 200, async text() { throw new Error('interrupted'); } })
    }),
    { code: 'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER_UNAVAILABLE', statusCode: 503 }
  );
});
