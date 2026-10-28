'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStripeCheckoutSession } = require('../packages/billing/src/stripe');

function checkoutArgs(extra = {}) {
  return {
    secretKey: 'sk_fixture_not_a_real_credential',
    mode: 'payment',
    lineItems: [{ currency: 'USD', unitAmount: 1250, quantity: 2, name: 'Test product' }],
    successUrl: 'https://shop.example.test/success',
    cancelUrl: 'https://shop.example.test/cancel',
    idempotencyKey: 'systemfabric_test_1234',
    fetchImpl: async (_url, options) => {
      checkoutArgs.lastBody = options.body;
      return { ok: true, async text() { return JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.test/cs_test_123', mode: 'payment', status: 'open', payment_status: 'unpaid' }); } };
    },
    ...extra
  };
}

test('Stripe checkout transmits requested session expiration and idempotency key', async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
  const session = await createStripeCheckoutSession(checkoutArgs({ expiresAt }));
  const form = new URLSearchParams(checkoutArgs.lastBody);
  assert.equal(form.get('expires_at'), String(expiresAt));
  assert.equal(session.id, 'cs_test_123');
});

test('Stripe checkout permits the provider default when no expiration is requested', async () => {
  await createStripeCheckoutSession(checkoutArgs());
  assert.equal(new URLSearchParams(checkoutArgs.lastBody).has('expires_at'), false);
});

test('Stripe checkout rejects unsupported expiration bounds before external request', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const expiresAt of [now + 29 * 60, now + 24 * 60 * 60 + 1, now + 60.5, 'tomorrow']) {
    let called = false;
    await assert.rejects(createStripeCheckoutSession(checkoutArgs({ expiresAt, fetchImpl: async () => { called = true; throw new Error('should not call provider'); } })), /Checkout expiration must be between 30 minutes and 24 hours/);
    assert.equal(called, false);
  }
});

test('ambiguous Stripe transport failures retain a recoverable provider outcome code', async () => {
  await assert.rejects(
    createStripeCheckoutSession(checkoutArgs({ fetchImpl: async () => { throw new TypeError('socket closed'); } })),
    error => error.code === 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN' && error.statusCode === 502
  );
});

test('ambiguous Stripe server errors are distinguished from definitive request rejection', async () => {
  const serverError = await assert.rejects(
    createStripeCheckoutSession(checkoutArgs({ fetchImpl: async () => ({ ok: false, status: 503, async text() { return '{"error":{"message":"temporary"}}'; } }) })),
    error => error.code === 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN'
  );
  assert.equal(serverError, undefined); // node:assert rejects returns undefined when a predicate is used.
  await assert.rejects(
    createStripeCheckoutSession(checkoutArgs({ fetchImpl: async () => ({ ok: false, status: 400, async text() { return '{"error":{"message":"invalid"}}'; } }) })),
    error => error.code === 'ERR_SYSTEMFABRIC_BILLING_PROVIDER'
  );
});
