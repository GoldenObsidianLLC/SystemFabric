'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTransaction, TRANSACTION_MODES } = require('../packages/db/src/transaction');

function fakePool({ failAt = null, rollbackFails = false } = {}) {
  const calls = [];
  let releases = 0;
  const client = {
    async query(statement) {
      calls.push(statement);
      if (statement === failAt || (statement === 'ROLLBACK' && rollbackFails)) {
        throw new Error('database ' + statement.toLowerCase() + ' failed');
      }
      return { rows: [] };
    },
    release() { releases += 1; }
  };
  return {
    calls,
    get releases() { return releases; },
    async connect() { return client; }
  };
}

test('withTransaction commits once, releases the dedicated client and returns the work result', async () => {
  const pool = fakePool();
  const result = await withTransaction(pool, async client => {
    await client.query('SELECT 1');
    return { saved: true };
  });
  assert.deepEqual(result, { saved: true });
  assert.deepEqual(pool.calls, ['BEGIN', 'SELECT 1', 'COMMIT']);
  assert.equal(pool.releases, 1);
});

test('withTransaction rolls back failed work and preserves its original error if rollback also fails', async () => {
  const pool = fakePool({ rollbackFails: true });
  const failure = new Error('work failed');
  await assert.rejects(withTransaction(pool, async () => { throw failure; }), error => error === failure);
  assert.deepEqual(pool.calls, ['BEGIN', 'ROLLBACK']);
  assert.equal(pool.releases, 1);
});

test('withTransaction rolls back and releases when commit fails', async () => {
  const pool = fakePool({ failAt: 'COMMIT' });
  await assert.rejects(withTransaction(pool, async () => 'result'), /database commit failed/);
  assert.deepEqual(pool.calls, ['BEGIN', 'COMMIT', 'ROLLBACK']);
  assert.equal(pool.releases, 1);
});

test('withTransaction uses only the explicit read-only repeatable-read mode when requested', async () => {
  const pool = fakePool();
  await withTransaction(pool, async client => client.query('SELECT 1'), {
    mode: 'readOnlyRepeatableRead'
  });
  assert.equal(pool.calls[0], TRANSACTION_MODES.readOnlyRepeatableRead);
  assert.equal(pool.calls.at(-1), 'COMMIT');
  assert.equal(pool.releases, 1);
});

test('withTransaction validates the pool, operation and transaction mode before acquiring a client', async () => {
  let connects = 0;
  const pool = { async connect() { connects += 1; return fakePool(); } };
  await assert.rejects(withTransaction({}, async () => {}), /pool with connect/);
  await assert.rejects(withTransaction(pool, null), /work must be a function/);
  await assert.rejects(withTransaction(pool, async () => {}, { mode: 'readOnly' }), /Unsupported/);
  await assert.rejects(withTransaction(pool, async () => {}, { mode: 'toString' }), /Unsupported/);
  assert.equal(connects, 0);
});
