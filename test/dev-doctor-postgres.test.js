'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPostgresConnection, describePostgresFailure, parsePostgresEndpoint } = require('../scripts/dev-doctor-postgres');

function fakePool({ queryResult = { rows: [{ ready: 1 }] }, queryError = null, endError = null } = {}) {
  const state = { options: null, statements: [], ended: false };
  class FakePool {
    constructor(options) { state.options = options; }
    async query(statement) {
      state.statements.push(statement);
      if (queryError) throw queryError;
      return queryResult;
    }
    async end() {
      state.ended = true;
      if (endError) throw endError;
    }
  }
  return { PoolClass: FakePool, state };
}

test('PostgreSQL preflight authenticates with a bounded read-only SELECT and closes its pool', async () => {
  const fake = fakePool();
  const result = await checkPostgresConnection('postgres://user:secret@127.0.0.1:5432/hub_test', {
    PoolClass: fake.PoolClass
  });

  assert.deepEqual(result, { ok: true, host: '127.0.0.1', port: 5432 });
  assert.deepEqual(fake.state.statements, ['SELECT 1 AS ready']);
  assert.equal(fake.state.ended, true);
  assert.equal(fake.state.options.max, 1);
  assert.equal(fake.state.options.connectionTimeoutMillis, 2500);
  assert.equal(fake.state.options.query_timeout, 2500);
  assert.equal(fake.state.options.statement_timeout, 2500);
});

test('PostgreSQL preflight reports authentication failures without exposing connection secrets', async () => {
  const fake = fakePool({ queryError: Object.assign(new Error('password authentication failed for user secret-user'), { code: '28P01' }) });
  const result = await checkPostgresConnection('postgres://secret-user:secret-password@127.0.0.1:5432/hub_test', {
    PoolClass: fake.PoolClass
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, '28P01');
  assert.match(result.reason, /authentication failed/);
  assert.doesNotMatch(JSON.stringify(result), /secret-user|secret-password|password authentication failed/);
  assert.equal(fake.state.ended, true);
});

test('PostgreSQL preflight turns refused connections into actionable sanitized failures', async () => {
  const fake = fakePool({ queryError: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }) });
  const result = await checkPostgresConnection('postgres://user:password@127.0.0.1:5432/hub_test', {
    PoolClass: fake.PoolClass
  });

  assert.equal(result.code, 'ECONNREFUSED');
  assert.match(result.reason, /start the local PostgreSQL service/);
  assert.equal(fake.state.ended, true);
});

test('PostgreSQL preflight reports bounded timeout failures', async () => {
  const fake = fakePool({ queryError: Object.assign(new Error('query timeout'), { code: 'ETIMEDOUT' }) });
  const result = await checkPostgresConnection('postgres://user:password@localhost/hub_test', {
    PoolClass: fake.PoolClass,
    timeoutMs: 1500
  });

  assert.equal(result.code, 'ETIMEDOUT');
  assert.match(result.reason, /timed out/);
  assert.equal(fake.state.options.connectionTimeoutMillis, 1500);
  assert.equal(fake.state.ended, true);
});

test('PostgreSQL preflight rejects malformed and non-PostgreSQL URLs before opening a pool', async () => {
  let constructed = false;
  class UnexpectedPool {
    constructor() { constructed = true; }
  }

  for (const connectionString of [undefined, '', 'not-a-url', 'http://127.0.0.1:5432/hub_test']) {
    const result = await checkPostgresConnection(connectionString, { PoolClass: UnexpectedPool });
    assert.equal(result.ok, false);
    assert.match(result.reason, /invalid/);
  }

  assert.equal(parsePostgresEndpoint('postgres://user:password@127.0.0.1:5432/hub_test').port, 5432);
  assert.equal(parsePostgresEndpoint('redis://127.0.0.1:6379'), null);
  assert.equal(constructed, false);
});


test('TEST_DATABASE_URL must target a test-suffixed database before any connection is opened', async () => {
  let constructed = false;
  class UnexpectedPool { constructor() { constructed = true; } }

  const result = await checkPostgresConnection('postgres://user:password@127.0.0.1:5432/production', {
    PoolClass: UnexpectedPool,
    requireTestDatabase: true
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /must end in test/);
  assert.equal(constructed, false);
});
test('PostgreSQL preflight rejects an unexpected readiness result and still closes the pool', async () => {
  const fake = fakePool({ queryResult: { rows: [{ ready: 0 }] } });
  const result = await checkPostgresConnection('postgres://user:password@127.0.0.1:5432/hub_test', {
    PoolClass: fake.PoolClass
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected result/);
  assert.equal(fake.state.ended, true);
});

test('PostgreSQL pool cleanup errors do not expose or override readiness results', async () => {
  const fake = fakePool({ endError: new Error('connection secret cleanup detail') });
  const result = await checkPostgresConnection('postgres://user:password@127.0.0.1:5432/hub_test', {
    PoolClass: fake.PoolClass
  });

  assert.equal(result.ok, true);
  assert.equal(fake.state.ended, true);
});

test('PostgreSQL diagnostic descriptions never return arbitrary provider error text', () => {
  assert.equal(describePostgresFailure('28P01').includes('secret'), false);
  assert.match(describePostgresFailure('UNTRUSTED_SECRET_FIELD'), /unknown error/);
});