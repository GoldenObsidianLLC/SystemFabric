'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconcileExpiredStripeCheckouts,
  validateBatchSize
} = require('../packages/billing/src/checkout-reconciliation');

const candidate = { order_id: 'order-1', site_id: 'site-1', provider_session_id: 'cs_test_123' };

function response(session, { ok = true, status = 200, raw } = {}) {
  return { ok, status, async text() { return raw ?? JSON.stringify(session); } };
}

function fakePool({ candidateRows = [candidate], orderRow = { ...candidate, status: 'pending_payment' } } = {}) {
  const state = { calls: [], connects: 0, commits: 0, rollbacks: 0, releases: 0, reservationsCommitted: 0 };
  const pool = {
    state,
    async query(sql, values) {
      state.calls.push({ surface: 'pool', sql, values });
      assert.match(sql, /FROM commerce_orders/);
      return { rows: candidateRows };
    },
    async connect() {
      state.connects += 1;
      return {
        async query(sql, values) {
          state.calls.push({ surface: 'client', sql, values });
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'COMMIT') { state.commits += 1; return { rows: [] }; }
          if (sql === 'ROLLBACK') { state.rollbacks += 1; return { rows: [] }; }
          if (/SELECT id,site_id,status,provider_session_id/.test(sql)) return { rows: [orderRow] };
          if (/UPDATE commerce_orders SET status='failed'/.test(sql)) return { rows: [{ id: candidate.order_id }] };
          if (/UPDATE commerce_orders SET status='paid'/.test(sql)) return { rows: [{ id: candidate.order_id }] };
          if (/WITH released AS/.test(sql)) { state.releases += 1; return { rows: [{ released_count: 1 }] }; }
          if (/UPDATE commerce_stock_reservations SET status='committed'/.test(sql)) {
            state.reservationsCommitted += 1;
            return { rows: [{ id: 'reservation-1' }] };
          }
          throw new Error(`Unexpected SQL in test double: ${sql}`);
        },
        release() { state.releaseClient = true; }
      };
    }
  };
  return pool;
}

function fetchSession(session, optionsSeen = []) {
  return async (url, options) => {
    optionsSeen.push({ url, options });
    return response(session);
  };
}

test('reconciliation batch size is bounded', () => {
  assert.equal(validateBatchSize(1), 1);
  assert.equal(validateBatchSize(1_000), 1_000);
  for (const value of [0, -1, 1.5, 1_001, '10', NaN]) {
    assert.throws(() => validateBatchSize(value), error => error.code === 'ERR_SYSTEMFABRIC_CHECKOUT_RECONCILIATION_BATCH');
  }
});

test('expired Stripe session transitions pending order to failed and releases the stock exactly once', async () => {
  const pool = fakePool();
  const requests = [];
  const result = await reconcileExpiredStripeCheckouts(pool, {
    secretKey: 'sk_fixture_not_a_real_credential', fetchImpl: fetchSession({ id: candidate.provider_session_id, status: 'expired', payment_status: 'unpaid' }, requests)
  });
  assert.deepEqual(result, { skipped: false, checked: 1, expired: 1, paid: 0, held: 0, errors: 0, unlinked: 0 });
  assert.equal(pool.state.releases, 1);
  assert.equal(pool.state.reservationsCommitted, 0);
  assert.equal(pool.state.commits, 1);
  assert.equal(requests[0].url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_123');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer sk_fixture_not_a_real_credential');
});

test('complete paid Stripe session reconciles pending order and commits the reservation', async () => {
  const pool = fakePool();
  const result = await reconcileExpiredStripeCheckouts(pool, {
    secretKey: 'sk_fixture_not_a_real_credential', fetchImpl: fetchSession({ id: candidate.provider_session_id, status: 'complete', payment_status: 'paid', payment_intent: 'pi_test_123' })
  });
  assert.equal(result.paid, 1);
  assert.equal(result.expired, 0);
  assert.equal(pool.state.reservationsCommitted, 1);
  assert.equal(pool.state.releases, 0);
});

test('open or unpaid-complete sessions retain reservations', async () => {
  for (const session of [
    { id: candidate.provider_session_id, status: 'open', payment_status: 'unpaid' },
    { id: candidate.provider_session_id, status: 'complete', payment_status: 'unpaid' }
  ]) {
    const pool = fakePool();
    const result = await reconcileExpiredStripeCheckouts(pool, { secretKey: 'sk_fixture_not_a_real_credential', fetchImpl: fetchSession(session) });
    assert.equal(result.held, 1);
    assert.equal(pool.state.connects, 0);
    assert.equal(pool.state.releases, 0);
  }
});

test('provider transport and response errors retain inventory and are reported', async () => {
  const cases = [
    async () => { throw new TypeError('socket reset'); },
    async () => ({ ok: false, status: 503, async text() { return 'temporarily unavailable'; } }),
    async () => ({ ok: true, status: 200, async text() { return '{bad json'; } }),
    async () => response({ id: 'cs_other', status: 'expired', payment_status: 'unpaid' }),
    async () => response({ id: candidate.provider_session_id, status: 'expired' })
  ];
  for (const fetchImpl of cases) {
    const pool = fakePool();
    const result = await reconcileExpiredStripeCheckouts(pool, { secretKey: 'sk_fixture_not_a_real_credential', fetchImpl });
    assert.equal(result.errors, 1);
    assert.equal(result.held, 1);
    assert.equal(pool.state.releases, 0);
    assert.equal(pool.state.connects, 0);
  }
});

test('missing provider credentials skip reconciliation without releasing holds', async () => {
  const pool = fakePool();
  const result = await reconcileExpiredStripeCheckouts(pool, { secretKey: '', fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(result.skipped, true);
  assert.equal(pool.state.connects, 0);
  assert.equal(pool.state.releases, 0);
});

test('orders without a Stripe session ID are retained for manual or idempotent recovery', async () => {
  const pool = fakePool({ candidateRows: [{ order_id: 'order-2', site_id: 'site-1', provider_session_id: null }] });
  const result = await reconcileExpiredStripeCheckouts(pool, { secretKey: 'sk_fixture_not_a_real_credential' });
  assert.equal(result.unlinked, 1);
  assert.equal(result.held, 1);
  assert.equal(pool.state.connects, 0);
});

test('reconciliation validates the database pool before querying', async () => {
  await assert.rejects(reconcileExpiredStripeCheckouts(null), /PostgreSQL-compatible pool/);
  await assert.rejects(reconcileExpiredStripeCheckouts(fakePool(), { batchSize: 0 }), error => error.code === 'ERR_SYSTEMFABRIC_CHECKOUT_RECONCILIATION_BATCH');
});
