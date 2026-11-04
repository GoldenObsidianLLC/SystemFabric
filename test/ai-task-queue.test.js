'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createAITaskPayloadCipher } = require('../packages/security/src/ai-task-payload');
const { createAITaskQueueStore } = require('../packages/db/src/ai-task-queue');

const siteId = '11111111-1111-4111-8111-111111111111';
const actorId = '33333333-3333-4333-8333-333333333333';
const taskId = '22222222-2222-4222-8222-222222222222';
const claimToken = '44444444-4444-4444-8444-444444444444';
const workerId = 'worker-test-01';
const encryptionKey = randomBytes(32).toString('base64url');

function createPool({ query, clientQuery } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ scope: 'client', sql, values });
      if (clientQuery) return clientQuery(sql, values);
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ scope: 'pool', sql, values });
      if (query) return query(sql, values);
      return { rows: [], rowCount: 1 };
    },
    async connect() { return client; }
  };
}

test('AI task queue enqueue encrypts payload and binds it to one queued task/site', async () => {
  const pool = createPool({
    query: async (sql, values) => {
      assert.match(sql, /INSERT INTO ai_task_queue/);
      assert.match(sql, /t\.id=\$1 AND t\.site_id=\$2 AND t\.status='queued'/);
      assert.equal(values[0], taskId);
      assert.equal(values[1], siteId);
      assert.equal(values[2].length, 12);
      assert.notEqual(values[3].toString('utf8'), JSON.stringify({ prompt: 'do not store plaintext' }));
      assert.equal(values[4].length, 16);
      assert.equal(values[5], 4);
      return { rows: [{ task_id: taskId, attempts: 0, max_attempts: 4, available_at: new Date(), created_at: new Date() }] };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  const queued = await store.enqueue({
    taskId, siteId, payload: { prompt: 'do not store plaintext' }, maxAttempts: 4
  });
  assert.equal(queued.taskId, taskId);
  assert.equal(queued.maxAttempts, 4);
});

test('AI task queue claim decrypts the payload and returns a unique lease token', async () => {
  const cipher = createAITaskPayloadCipher({ encryptionKey });
  const sealed = cipher.seal({ taskId, siteId, purpose: 'input', value: { prompt: 'queued privately' } });
  const pool = createPool({
    query: async (sql, values) => {
      assert.match(sql, /FOR UPDATE OF q,t SKIP LOCKED/);
      assert.match(sql, /gen_random_uuid\(\)/);
      assert.match(sql, /RETURNING t\.id,t\.site_id,t\.actor_id/);
      assert.match(sql, /SELECT s\.id AS task_id,s\.site_id/);
      assert.doesNotMatch(sql, /JOIN ai_tasks t ON t\.id=s\.id/);
      assert.equal(values[0], 3);
      assert.equal(values[1], workerId);
      return { rows: [{
        task_id: taskId, site_id: siteId, actor_id: actorId, request_id: 'request-1',
        task_type: 'page_draft', status: 'running', provider: null, model: null,
        input_chars: 12, task_version: 2, created_at: new Date(), started_at: new Date(),
        payload_nonce: sealed.nonce, payload_ciphertext: sealed.ciphertext, payload_tag: sealed.tag,
        attempts: 1, max_attempts: 4, claim_token: claimToken, lease_expires_at: new Date()
      }] };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  const jobs = await store.claimBatch({ workerId, batchSize: 3, leaseMs: 9000 });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].payload, { prompt: 'queued privately' });
  assert.equal(jobs[0].task.siteId, siteId);
  assert.equal(jobs[0].task.actorId, actorId);
  assert.equal(jobs[0].task.status, 'running');
  assert.equal(jobs[0].task.version, 2);
  assert.ok(jobs[0].task.startedAt instanceof Date);
  assert.equal(jobs[0].claimToken, claimToken);
  assert.equal(jobs[0].attempt, 1);
});

test('AI task queue renews only the current unexpired lease', async () => {
  const pool = createPool({
    query: async (sql, values) => {
      assert.match(sql, /locked_by=\$2 AND claim_token=\$3 AND lease_expires_at > now\(\)/);
      assert.deepEqual(values, [taskId, workerId, claimToken, 5000]);
      return { rowCount: 1, rows: [{ task_id: taskId }] };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  assert.equal(await store.renewLease({ taskId, workerId, claimToken, leaseMs: 5000 }), true);
});

test('AI task queue completes with an encrypted result and atomically clears the input payload', async () => {
  const calls = [];
  const pool = createPool({
    clientQuery: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT q.task_id')) return { rows: [{ task_id: taskId }] };
      if (sql.startsWith('UPDATE ai_tasks')) {
        assert.match(sql, /status='succeeded'/);
        return { rows: [{ id: taskId }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE ai_task_queue')) {
        assert.match(sql, /payload_ciphertext=NULL/);
        assert.match(sql, /result_ciphertext=\$5/);
        assert.equal(values[3].length, 12);
        assert.equal(values[4].length > 0, true);
        assert.equal(values[5].length, 16);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  const result = await store.completeClaim({
    taskId, siteId, workerId, claimToken, result: { proposal: 'draft' }, latencyMs: 321
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputChars, JSON.stringify({ proposal: 'draft' }).length);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls[calls.length - 1].sql, 'COMMIT');
});

test('AI task queue retries transient failure with bounded availability delay', async () => {
  const pool = createPool({
    clientQuery: async (sql, values) => {
      if (sql.startsWith('SELECT q.attempts')) return { rows: [{ attempts: 1, max_attempts: 4 }] };
      if (sql.startsWith('UPDATE ai_tasks')) {
        assert.match(sql, /status='queued'/);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE ai_task_queue')) {
        assert.match(sql, /available_at=now\(\)/);
        assert.equal(values[3], 1200);
        assert.equal(values[4], 'ERR_PROVIDER_BUSY');
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  const result = await store.failClaim({
    taskId, siteId, workerId, claimToken, errorCode: 'ERR_PROVIDER_BUSY',
    retryable: true, retryDelayMs: 1200
  });
  assert.equal(result.retried, true);
  assert.equal(result.attempts, 1);
});

test('AI task queue never retries exhausted failures and clears encrypted input', async () => {
  const pool = createPool({
    clientQuery: async (sql, values) => {
      if (sql.startsWith('SELECT q.attempts')) return { rows: [{ attempts: 4, max_attempts: 4 }] };
      if (sql.startsWith('UPDATE ai_tasks')) {
        assert.match(sql, /status='failed'/);
        assert.equal(values[3], 'ERR_PROVIDER_BUSY');
        return { rows: [{ id: taskId }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE ai_task_queue')) {
        assert.match(sql, /payload_ciphertext=NULL/);
        assert.equal(values[3], 'ERR_PROVIDER_BUSY');
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  const result = await store.failClaim({
    taskId, siteId, workerId, claimToken, errorCode: 'ERR_PROVIDER_BUSY', retryable: true
  });
  assert.equal(result.retried, false);
  assert.equal(result.attempts, 4);
});

test('AI task queue cancellation is actor/site scoped and removes queued ciphertext', async () => {
  const pool = createPool({
    clientQuery: async sql => {
      if (sql.startsWith('UPDATE ai_tasks')) return { rows: [{ id: taskId }], rowCount: 1 };
      if (sql.startsWith('UPDATE ai_task_queue')) {
        assert.match(sql, /payload_ciphertext=NULL/);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  assert.equal(await store.cancelQueued({ taskId, siteId, actorId }), true);
  assert.match(pool.calls[1].sql, /actor_id IS NOT DISTINCT FROM \$3::uuid/);
});

test('AI task queue refuses invalid limits before making database calls', async () => {
  const pool = createPool();
  const store = createAITaskQueueStore({ pool, encryptionKey });
  await assert.rejects(store.claimBatch({ workerId: 'worker', batchSize: 51 }), { statusCode: 400 });
  await assert.rejects(store.enqueue({ taskId, siteId, payload: {}, maxAttempts: 21 }), { statusCode: 400 });
  await assert.rejects(store.createAndEnqueue({
    siteId, actorId, requestId: 'request-large-integer', taskType: 'page_draft',
    inputChars: 2_147_483_648, payload: { prompt: 'x' }
  }), { statusCode: 400 });
  await assert.rejects(store.completeClaim({
    taskId, siteId, workerId, claimToken, result: { ok: true }, latencyMs: 2_147_483_648
  }), { statusCode: 400 });
  await assert.rejects(store.failClaim({
    taskId, siteId, workerId, claimToken, errorCode: 'ERR_PROVIDER_BUSY', latencyMs: 2_147_483_648
  }), { statusCode: 400 });
  assert.equal(pool.calls.length, 0);
});


test('AI task queue binds provider/model to the active lease and preserves provider consistency', async () => {
  const statements = [];
  const pool = createPool({
    clientQuery: async (sql, values) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT t.status')) {
        return { rows: [{ status: 'running', provider: null, model: null }] };
      }
      if (sql.startsWith('UPDATE ai_tasks')) {
        assert.match(sql, /provider=COALESCE\(provider,\$3\)/);
        assert.match(sql, /status='running'/);
        assert.deepEqual(values, [taskId, siteId, 'mock', 'mock-v1']);
        return { rows: [{ id: taskId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  const result = await store.startClaim({
    taskId, siteId, workerId, claimToken, provider: 'mock', model: 'mock-v1'
  });
  assert.deepEqual(result, { taskId, status: 'running', provider: 'mock', model: 'mock-v1' });
  assert.equal(statements.some(statement => statement.sql.startsWith('UPDATE ai_tasks')), true);
});

test('AI task queue reads only actor/site-scoped results and authenticates encrypted result payloads', async () => {
  const cipher = createAITaskPayloadCipher({ encryptionKey });
  const sealed = cipher.seal({
    taskId, siteId, purpose: 'result', value: { proposal: 'private draft result' }
  });
  const pool = createPool({
    query: async (sql, values) => {
      assert.match(sql, /t\.site_id=\$2/);
      assert.match(sql, /t\.actor_id IS NOT DISTINCT FROM \$3::uuid/);
      assert.match(sql, /t\.status='succeeded'/);
      assert.deepEqual(values, [taskId, siteId, actorId]);
      return { rows: [{
        task_id: taskId, site_id: siteId, result_nonce: sealed.nonce,
        result_ciphertext: sealed.ciphertext, result_tag: sealed.tag,
        output_chars: 32, completed_at: new Date()
      }] };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  const result = await store.getResult({ taskId, siteId, actorId });
  assert.deepEqual(result.result, { proposal: 'private draft result' });
  assert.equal(result.outputChars, 32);
});


test('AI task queue creates metadata and encrypted payload atomically in one transaction', async () => {
  const cipher = createAITaskPayloadCipher({ encryptionKey });
  const statements = [];
  const pool = createPool({
    clientQuery: async (sql, values) => {
      statements.push({ sql, values });
      if (sql.startsWith('INSERT INTO ai_tasks')) {
        const [id, site, actor, request, taskType, inputChars] = values;
        return { rows: [{
          id, site_id: site, actor_id: actor, request_id: request, task_type: taskType,
          status: 'queued', provider: null, model: null, input_chars: inputChars,
          output_chars: 0, latency_ms: 0, error_code: null, task_version: 1,
          created_at: new Date(), started_at: null, completed_at: null, updated_at: new Date()
        }] };
      }
      if (sql.startsWith('INSERT INTO ai_task_queue')) {
        const [id, nonce, ciphertext, tag, maxAttempts, availableAt] = values;
        assert.equal(ciphertext.toString('utf8').includes('secret prompt'), false);
        assert.deepEqual(cipher.open({
          taskId: id, siteId, purpose: 'input',
          envelope: { nonce, ciphertext, tag }
        }), { prompt: 'secret prompt' });
        assert.equal(maxAttempts, 3);
        return { rows: [{
          task_id: id, attempts: 0, max_attempts: maxAttempts,
          available_at: availableAt || new Date(), created_at: new Date()
        }] };
      }
      return { rows: [], rowCount: 1 };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  const created = await store.createAndEnqueue({
    siteId, actorId, requestId: 'request-atomic-1',
    taskType: 'page_draft', inputChars: 41,
    payload: { prompt: 'secret prompt' }, maxAttempts: 3
  });
  assert.equal(created.task.siteId, siteId);
  assert.equal(created.task.actorId, actorId);
  assert.equal(created.task.status, 'queued');
  assert.equal(created.queue.taskId, created.task.id);
  assert.equal(statements[0].sql, 'BEGIN');
  assert.equal(statements.at(-1).sql, 'COMMIT');
  assert.equal(statements.filter(item => item.sql.startsWith('INSERT INTO ai_tasks')).length, 1);
  assert.equal(statements.filter(item => item.sql.startsWith('INSERT INTO ai_task_queue')).length, 1);
});

test('AI task queue rolls back metadata creation when encrypted payload enqueue fails', async () => {
  const statements = [];
  const pool = createPool({
    clientQuery: async (sql, values) => {
      statements.push(sql);
      if (sql.startsWith('INSERT INTO ai_tasks')) {
        return { rows: [{
          id: values[0], site_id: values[1], actor_id: values[2], request_id: values[3],
          task_type: values[4], status: 'queued'
        }] };
      }
      if (sql.startsWith('INSERT INTO ai_task_queue')) throw new Error('queue insert failed');
      return { rows: [], rowCount: 1 };
    }
  });
  const store = createAITaskQueueStore({ pool, encryptionKey });
  await assert.rejects(store.createAndEnqueue({
    siteId, actorId, requestId: 'request-atomic-rollback',
    taskType: 'page_draft', inputChars: 8, payload: { prompt: 'draft' }
  }), /queue insert failed/);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.includes('COMMIT'), false);
});
