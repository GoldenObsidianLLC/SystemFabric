'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAITaskStore } = require('../packages/db/src/ai-task-store');

const siteId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';

function createMemoryPool() {
  const records = new Map();
  const queries = [];
  const timestamp = () => new Date('2026-11-02T20:00:00.000Z');

  function row(record) {
    return {
      id: record.id,
      site_id: record.siteId,
      request_id: record.requestId,
      task_type: record.taskType,
      status: record.status,
      provider: record.provider,
      model: record.model,
      input_chars: record.inputChars,
      output_chars: record.outputChars,
      latency_ms: record.latencyMs,
      error_code: record.errorCode,
      task_version: record.version,
      created_at: record.createdAt,
      started_at: record.startedAt,
      completed_at: record.completedAt,
      updated_at: record.updatedAt
    };
  }

  return {
    records,
    queries,
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO ai_tasks')) {
        const record = {
          id: taskId,
          siteId: values[0],
          actorId: values[1],
          requestId: values[2],
          taskType: values[3],
          status: 'queued',
          provider: null,
          model: null,
          inputChars: values[4],
          outputChars: 0,
          latencyMs: 0,
          errorCode: null,
          version: 1,
          createdAt: timestamp(),
          startedAt: null,
          completedAt: null,
          updatedAt: timestamp()
        };
        records.set(taskId, record);
        return { rows: [row(record)] };
      }

      if (sql.includes('UPDATE ai_tasks')) {
        const record = records.get(values[0]);
        if (!record || record.siteId !== values[1]) return { rows: [] };
        if (sql.includes("SET status='running'")) {
          if (record.status !== 'queued') return { rows: [] };
          record.status = 'running';
          record.provider = values[2];
          record.model = values[3];
          record.startedAt = timestamp();
          record.updatedAt = timestamp();
          record.version += 1;
          return { rows: [row(record)] };
        }
        if (['queued', 'running'].includes(record.status) &&
            (values[2] !== 'succeeded' || record.status === 'running')) {
          record.status = values[2];
          record.outputChars = values[3];
          record.latencyMs = values[4];
          record.errorCode = values[5];
          record.completedAt = timestamp();
          record.updatedAt = timestamp();
          record.version += 1;
          return { rows: [row(record)] };
        }
        return { rows: [] };
      }

      if (sql.includes('FROM ai_tasks')) {
        const record = records.get(values[0]);
        if (!record || record.siteId !== values[1]) return { rows: [] };
        if (sql.includes('actor_id IS NOT DISTINCT FROM') && record.actorId !== values[2]) return { rows: [] };
        return { rows: [row(record)] };
      }
      throw new Error('Unexpected AI task SQL in test fixture.');
    }
  };
}

test('AI task store persists a metadata-only lifecycle with monotonic state transitions', async () => {
  const pool = createMemoryPool();
  const store = createAITaskStore({ pool });

  const queued = await store.create({
    siteId,
    actorId,
    requestId: 'request-123',
    taskType: 'page_draft',
    inputChars: 87
  });
  assert.equal(queued.id, taskId);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.inputChars, 87);
  assert.equal(queued.outputChars, 0);
  assert.equal(queued.version, 1);
  assert.equal(Object.hasOwn(queued, 'prompt'), false);
  assert.equal(Object.hasOwn(queued, 'output'), false);

  const running = await store.start({
    taskId,
    siteId,
    provider: 'mock',
    model: 'mock-v1'
  });
  assert.equal(running.status, 'running');
  assert.ok(running.startedAt);
  assert.equal(running.version, 2);

  const complete = await store.finish({
    taskId,
    siteId,
    status: 'succeeded',
    outputChars: 143,
    latencyMs: 321
  });
  assert.equal(complete.status, 'succeeded');
  assert.equal(complete.outputChars, 143);
  assert.equal(complete.latencyMs, 321);
  assert.equal(complete.errorCode, null);
  assert.ok(complete.completedAt);
  assert.equal(complete.version, 3);

  assert.equal((await store.get({ taskId, siteId, actorId })).status, 'succeeded');
  assert.equal(await store.get({ taskId, siteId: '44444444-4444-4444-8444-444444444444', actorId }), null);
  assert.equal(await store.get({ taskId, siteId, actorId: '55555555-5555-4555-8555-555555555555' }), null);
  assert.ok(pool.queries.every(({ sql }) => !/prompt|output_payload|response_body/i.test(sql)));
  assert.ok(pool.queries.every(({ sql }) => /\$[1-9]/.test(sql)), 'database values are parameterized');
});

test('AI task store blocks invalid and backwards transitions', async () => {
  const pool = createMemoryPool();
  const store = createAITaskStore({ pool });

  await assert.rejects(
    store.create({ siteId, actorId, requestId: 'bad', taskType: 'shell', inputChars: 0 }),
    { code: 'ERR_SYSTEMFABRIC_AI_TASK_INVALID', statusCode: 400 }
  );
  await assert.rejects(
    store.create({ siteId, actorId, requestId: 'bad', taskType: 'translate', inputChars: -1 }),
    { code: 'ERR_SYSTEMFABRIC_AI_TASK_INVALID', statusCode: 400 }
  );
  assert.equal(pool.queries.length, 0);

  await store.create({ siteId, actorId, requestId: 'request-124', taskType: 'translate', inputChars: 5 });
  await assert.rejects(
    store.finish({ taskId, siteId, status: 'succeeded', outputChars: 1, latencyMs: 1 }),
    { code: 'ERR_SYSTEMFABRIC_AI_TASK_CONFLICT', statusCode: 409 }
  );
  await store.finish({
    taskId,
    siteId,
    status: 'blocked',
    errorCode: 'ERR_SYSTEMFABRIC_AI_DISABLED'
  });
  const blocked = await store.get({ taskId, siteId, actorId });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.errorCode, 'ERR_SYSTEMFABRIC_AI_DISABLED');
  await assert.rejects(
    store.finish({ taskId, siteId, status: 'failed', errorCode: 'ERR_TEST' }),
    { code: 'ERR_SYSTEMFABRIC_AI_TASK_CONFLICT', statusCode: 409 }
  );
});

test('AI task store sanitizes unknown provider error codes before persistence', async () => {
  const pool = createMemoryPool();
  const store = createAITaskStore({ pool });
  await store.create({ siteId, actorId: null, requestId: 'request-125', taskType: 'seo', inputChars: 12 });
  await store.finish({
    taskId,
    siteId,
    status: 'failed',
    errorCode: 'provider-secret\nwith-sensitive-details'
  });
  assert.equal(pool.records.get(taskId).errorCode, 'ERR_SYSTEMFABRIC_AI_FAILURE');
});

test('AI task store detects whether the lifecycle migration is installed', async () => {
  const readyStore = createAITaskStore({
    pool: {
      async query(sql) {
        assert.match(sql, /to_regclass\('ai_tasks'\)/);
        return { rows: [{ table_name: 'ai_tasks' }] };
      }
    }
  });
  const missingStore = createAITaskStore({
    pool: { async query() { return { rows: [{ table_name: null }] }; } }
  });

  assert.equal(await readyStore.isAvailable(), true);
  assert.equal(await missingStore.isAvailable(), false);
});
