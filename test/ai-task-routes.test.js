'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAITaskRouteHandlers } = require('../apps/api/src/ai-task-routes');

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const ACTOR_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TASK_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function routeFailure(statusCode, code, message, details) {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function createHarness({ store = null, actorId = ACTOR_A, providerInfo = { provider: 'mock', model: 'test-model' } } = {}) {
  const state = { listCalls: [], getCalls: [], ensureCalls: [] };
  const handler = createAITaskRouteHandlers({
    getTaskStore: async () => store,
    getProviderInfo: () => providerInfo,
    ensureSiteCapability: async (actor, url) => {
      state.ensureCalls.push({ actorId: actor.user?.id || null, siteId: url.searchParams.get('siteId') });
      return url.searchParams.get('siteId');
    },
    sendJson(res, statusCode, payload) {
      res.statusCode = statusCode;
      res.payload = payload;
      return true;
    },
    fail: routeFailure
  });

  async function call(path, { method = 'GET', actor = { user: { id: actorId } }, requestId = 'request-1234' } = {}) {
    const req = { method };
    const res = {};
    const url = new URL(path, 'http://localhost');
    const handled = await handler.handle({ req, res, url, actor, requestId });
    return { handled, res };
  }

  return { call, state, handler };
}

test('AI task route module requires explicit dependencies', () => {
  assert.throws(() => createAITaskRouteHandlers(), /getTaskStore/);
  assert.throws(() => createAITaskRouteHandlers({
    getTaskStore() {}, getProviderInfo() {}, ensureSiteCapability() {}, sendJson() {}
  }), /fail/);
});

test('unrelated paths and unsupported methods remain available to the API dispatcher', async () => {
  const { call } = createHarness({ store: {} });
  assert.equal((await call('/api/v1/widgets')).handled, false);
  assert.equal((await call('/api/v1/ai/status', { method: 'POST' })).handled, false);
  assert.equal((await call('/api/v1/ai/tasks/not-a-uuid')).handled, false);
});

test('AI status advertises task capabilities only when the corresponding stores are available', async () => {
  const available = createHarness({ store: { list() {} } });
  const response = await available.call('/api/v1/ai/status');
  assert.equal(response.handled, true);
  assert.equal(response.res.statusCode, 200);
  assert.equal(response.res.payload.durableTaskStatus, true);
  assert.ok(response.res.payload.capabilities.includes('task-status'));
  assert.ok(response.res.payload.capabilities.includes('task-list'));
  assert.equal(response.res.payload.requestId, 'request-1234');

  const unavailable = createHarness({ store: null });
  const disabled = await unavailable.call('/api/v1/ai/status');
  assert.equal(disabled.res.payload.durableTaskStatus, false);
  assert.ok(!disabled.res.payload.capabilities.includes('task-status'));
  assert.ok(!disabled.res.payload.capabilities.includes('task-list'));
});

test('task collection reports unavailable storage without leaking implementation details', async () => {
  const { call } = createHarness({ store: null });
  const response = await call('/api/v1/ai/tasks?siteId=' + SITE_A);
  assert.equal(response.res.statusCode, 503);
  assert.equal(response.res.payload.code, 'ERR_VIRGOSCORPIO_HUB_AI_TASK_LIST_DISABLED');
});

test('task collection binds pagination cursors to site, actor, and active filters', async () => {
  const firstTask = { id: TASK_A, createdAt: '2026-11-04T18:00:00.000Z' };
  const lastTask = { id: TASK_B, createdAt: '2026-11-04T18:01:00.000Z' };
  const store = {
    async list(input) {
      state.listCalls.push(input);
      return state.listCalls.length === 1
        ? { tasks: [firstTask, lastTask], hasMore: true }
        : { tasks: [lastTask], hasMore: false };
    }
  };
  const { call, state } = createHarness({ store });
  const first = await call('/api/v1/ai/tasks?siteId=' + SITE_A + '&limit=2&status=succeeded&taskType=page_draft');
  assert.equal(first.res.statusCode, 200);
  assert.deepEqual(state.listCalls[0], {
    siteId: SITE_A,
    actorId: ACTOR_A,
    status: 'succeeded',
    taskType: 'page_draft',
    limit: 2,
    before: null
  });
  assert.ok(first.res.payload.nextCursor);

  const payload = JSON.parse(Buffer.from(first.res.payload.nextCursor, 'base64url').toString('utf8'));
  assert.deepEqual(payload, {
    v: 1,
    siteId: SITE_A,
    actorId: ACTOR_A,
    status: 'succeeded',
    taskType: 'page_draft',
    createdAt: lastTask.createdAt,
    id: TASK_B
  });

  const second = await call('/api/v1/ai/tasks?siteId=' + SITE_A + '&limit=2&status=succeeded&taskType=page_draft&cursor=' + first.res.payload.nextCursor);
  assert.equal(second.res.statusCode, 200);
  assert.deepEqual(state.listCalls[1].before, { createdAt: lastTask.createdAt, id: TASK_B });
  assert.equal(second.res.payload.nextCursor, null);
});

test('task collection rejects cursor reuse under a different site or filter', async () => {
  const store = {
    async list() {
      return {
        tasks: [{ id: TASK_A, createdAt: '2026-11-04T18:00:00.000Z' }],
        hasMore: true
      };
    }
  };
  const { call } = createHarness({ store });
  const first = await call('/api/v1/ai/tasks?siteId=' + SITE_A);
  const cursor = first.res.payload.nextCursor;

  await assert.rejects(
    call('/api/v1/ai/tasks?siteId=' + SITE_B + '&cursor=' + cursor),
    error => error.code === 'ERR_VIRGOSCORPIO_HUB_AI_TASK_CURSOR_INVALID' && error.statusCode === 400
  );
  await assert.rejects(
    call('/api/v1/ai/tasks?siteId=' + SITE_A + '&status=failed&cursor=' + cursor),
    error => error.code === 'ERR_VIRGOSCORPIO_HUB_AI_TASK_CURSOR_INVALID' && error.statusCode === 400
  );
  await assert.rejects(
    call('/api/v1/ai/tasks?siteId=' + SITE_A + '&cursor=' + cursor, { actor: { user: { id: ACTOR_B } } }),
    error => error.code === 'ERR_VIRGOSCORPIO_HUB_AI_TASK_CURSOR_INVALID' && error.statusCode === 400
  );
});

test('task collection rejects duplicate, malformed, and unsupported query values before listing', async t => {
  const store = { async list() { assert.fail('Invalid query must not reach persistence.'); } };
  const { call } = createHarness({ store });
  const cases = [
    ['?siteId=' + SITE_A + '&limit=2&limit=3', 'ERR_VIRGOSCORPIO_HUB_AI_TASK_QUERY_INVALID'],
    ['?siteId=' + SITE_A + '&limit=0', 'ERR_VIRGOSCORPIO_HUB_AI_TASK_LIMIT_INVALID'],
    ['?siteId=' + SITE_A + '&limit=51', 'ERR_VIRGOSCORPIO_HUB_AI_TASK_LIMIT_INVALID'],
    ['?siteId=' + SITE_A + '&limit=1.5', 'ERR_VIRGOSCORPIO_HUB_AI_TASK_LIMIT_INVALID'],
    ['?siteId=' + SITE_A + '&status=unknown', 'ERR_VIRGOSCORPIO_HUB_AI_TASK_STATUS_INVALID'],
    ['?siteId=' + SITE_A + '&taskType=unknown', 'ERR_VIRGOSCORPIO_HUB_AI_TASK_TYPE_INVALID']
  ];

  for (const [query, code] of cases) {
    await t.test(query, async () => {
      await assert.rejects(
        call('/api/v1/ai/tasks' + query),
        error => error.code === code && error.statusCode === 400
      );
    });
  }
});

test('task detail reads are scoped to the selected site and actor', async () => {
  const task = { id: TASK_A, status: 'succeeded' };
  const store = {
    async get(input) {
      state.getCalls.push(input);
      return task;
    }
  };
  const { call, state } = createHarness({ store });
  const response = await call('/api/v1/ai/tasks/' + TASK_A + '?siteId=' + SITE_A);
  assert.equal(response.res.statusCode, 200);
  assert.deepEqual(response.res.payload, { task, requestId: 'request-1234' });
  assert.deepEqual(state.getCalls, [{ taskId: TASK_A, siteId: SITE_A, actorId: ACTOR_A }]);
});

test('task detail hides missing tasks and handles unavailable task persistence', async () => {
  const missing = createHarness({ store: { async get() { return null; } } });
  const notFound = await missing.call('/api/v1/ai/tasks/' + TASK_A + '?siteId=' + SITE_A);
  assert.equal(notFound.res.statusCode, 404);
  assert.equal(notFound.res.payload.code, 'ERR_VIRGOSCORPIO_HUB_AI_TASK_NOT_FOUND');

  const unavailable = createHarness({ store: null });
  const disabled = await unavailable.call('/api/v1/ai/tasks/' + TASK_A + '?siteId=' + SITE_A);
  assert.equal(disabled.res.statusCode, 503);
  assert.equal(disabled.res.payload.code, 'ERR_VIRGOSCORPIO_HUB_AI_TASKS_DISABLED');
});

test('task list cursor creation fails closed for invalid persisted cursor sources', async () => {
  const store = {
    async list() {
      return { tasks: [{ id: 'not-a-uuid', createdAt: '2026-11-04T18:00:00.000Z' }], hasMore: true };
    }
  };
  const { call } = createHarness({ store });
  await assert.rejects(
    call('/api/v1/ai/tasks?siteId=' + SITE_A),
    error => error.code === 'ERR_VIRGOSCORPIO_HUB_AI_TASK_CURSOR_SOURCE_INVALID' && error.statusCode === 500
  );
});
