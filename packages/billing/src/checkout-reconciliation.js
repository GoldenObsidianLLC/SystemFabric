'use strict';

const {
  releaseOrderStockReservations,
  commitOrderStockReservations
} = require('../../commerce/src/stock-reservations');

const MAX_BATCH_SIZE = 1_000;
const DEFAULT_BATCH_SIZE = 100;
const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function validateBatchSize(batchSize) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    const error = new TypeError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}.`);
    error.code = 'ERR_SYSTEMFABRIC_CHECKOUT_RECONCILIATION_BATCH';
    throw error;
  }
  return batchSize;
}

async function getStripeSession({ secretKey, sessionId, fetchImpl }) {
  const response = await fetchImpl(`${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secretKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  let raw;
  try {
    raw = await response.text();
  } catch (cause) {
    const error = new Error('Could not read Stripe Checkout Session response.');
    error.cause = cause;
    throw error;
  }
  if (!response.ok) throw new Error(`Stripe Checkout Session lookup returned HTTP ${response.status}.`);
  let session;
  try { session = JSON.parse(raw); } catch (cause) {
    const error = new Error('Stripe Checkout Session response was not valid JSON.');
    error.cause = cause;
    throw error;
  }
  if (!session || session.id !== sessionId || !['open', 'complete', 'expired'].includes(session.status)
      || !['paid', 'unpaid', 'no_payment_required'].includes(session.payment_status)) {
    throw new Error('Stripe Checkout Session response did not match the requested session or status contract.');
  }
  return session;
}

/**
 * Reconcile expired local inventory holds against Stripe's current session state.
 * A local timer is never sufficient evidence to release stock: sessions without a
 * provider ID, provider errors, open sessions, and unpaid completed sessions keep
 * their holds until a definitive webhook or subsequent reconciliation resolves them.
 */
async function reconcileExpiredStripeCheckouts(pool, {
  secretKey = process.env.STRIPE_SECRET_KEY,
  fetchImpl = globalThis.fetch,
  batchSize = DEFAULT_BATCH_SIZE
} = {}) {
  validateBatchSize(batchSize);
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool with query and connect is required.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (typeof secretKey !== 'string' || !/^sk_(test|live)_/.test(secretKey)) {
    return { skipped: true, checked: 0, expired: 0, paid: 0, held: 0, errors: 0, unlinked: 0 };
  }

  const candidates = await pool.query(
    `SELECT o.id AS order_id,o.site_id,o.provider_session_id
       FROM commerce_orders o
      WHERE o.provider='stripe' AND o.status='pending_payment'
        AND EXISTS (
          SELECT 1 FROM commerce_stock_reservations r
           WHERE r.site_id=o.site_id AND r.order_id=o.id
             AND r.status='reserved' AND r.expires_at<=now()
        )
      ORDER BY o.created_at,o.id
      LIMIT $1`,
    [batchSize]
  );

  const summary = { skipped: false, checked: 0, expired: 0, paid: 0, held: 0, errors: 0, unlinked: 0 };
  for (const order of candidates.rows) {
    summary.checked += 1;
    if (typeof order.provider_session_id !== 'string' || !order.provider_session_id) {
      // An absent ID can represent an ambiguous provider outcome. Never guess that
      // Stripe failed; retain the reservation for same-key recovery/manual review.
      summary.unlinked += 1;
      summary.held += 1;
      continue;
    }

    let session;
    try {
      session = await getStripeSession({ secretKey, sessionId: order.provider_session_id, fetchImpl });
    } catch {
      summary.errors += 1;
      summary.held += 1;
      continue;
    }

    const isExpired = session.status === 'expired' && session.payment_status !== 'paid';
    const isPaid = session.status === 'complete' && ['paid', 'no_payment_required'].includes(session.payment_status);
    if (!isExpired && !isPaid) {
      summary.held += 1;
      continue;
    }

    const client = await pool.connect();
    let transitioned = false;
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT id,site_id,status,provider_session_id
           FROM commerce_orders
          WHERE site_id=$1 AND id=$2
          FOR UPDATE`,
        [order.site_id, order.order_id]
      );
      const row = current.rows[0];
      if (row && row.status === 'pending_payment' && row.provider_session_id === order.provider_session_id) {
        if (isExpired) {
          const update = await client.query(
            `UPDATE commerce_orders SET status='failed',updated_at=now()
              WHERE site_id=$1 AND id=$2 AND status='pending_payment'
                AND provider_session_id=$3 RETURNING id`,
            [order.site_id, order.order_id, order.provider_session_id]
          );
          if (update.rows[0]) {
            await releaseOrderStockReservations(client, { siteId: order.site_id, orderId: order.order_id, status: 'expired' });
            transitioned = true;
            summary.expired += 1;
          }
        } else {
          const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : null;
          const update = await client.query(
            `UPDATE commerce_orders SET status='paid',provider='stripe',provider_session_id=$3,
                    provider_payment_id=COALESCE($4,provider_payment_id),updated_at=now()
              WHERE site_id=$1 AND id=$2 AND status='pending_payment'
                AND provider_session_id=$3 RETURNING id`,
            [order.site_id, order.order_id, order.provider_session_id, paymentIntent]
          );
          if (update.rows[0]) {
            await commitOrderStockReservations(client, { siteId: order.site_id, orderId: order.order_id });
            transitioned = true;
            summary.paid += 1;
          }
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (!transitioned) summary.held += 1;
  }
  return summary;
}

module.exports = { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, validateBatchSize, reconcileExpiredStripeCheckouts };
