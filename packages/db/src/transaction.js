'use strict';

const TRANSACTION_MODES = Object.freeze({
  readWrite: 'BEGIN',
  readOnlyRepeatableRead: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
});

/**
 * Run one PostgreSQL transaction on a dedicated pool client.
 *
 * The client is always released. A failed operation or commit triggers a
 * best-effort rollback, while the original error remains the rejection reason.
 * Callers should return values from work() and perform external side effects
 * only after this function resolves (the commit has completed).
 */
async function withTransaction(pool, work, { mode = 'readWrite' } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with connect() is required.');
  }
  if (typeof work !== 'function') {
    throw new TypeError('Transaction work must be a function.');
  }
  const beginStatement = Object.hasOwn(TRANSACTION_MODES, mode)
    ? TRANSACTION_MODES[mode]
    : null;
  if (!beginStatement) {
    throw new TypeError('Unsupported PostgreSQL transaction mode.');
  }

  const client = await pool.connect();
  let transactionOpen = true;
  try {
    await client.query(beginStatement);
    const result = await work(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction, TRANSACTION_MODES };
