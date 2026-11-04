'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAITaskQueueWorker, retryDelayMs } = require('../packages/ai/src/queue-worker');

const task = {
  id: '22222222-2222-4222-8222-222222222222',
  siteId: '11111111-1111-4111-8111-111111111111',
  taskType: 'page_draft',
  status: 'queued'
};
const job = {
  task,
  payload: { prompt: 'Create a draft' },
  workerId: 'worker-test',
  claimToken: '44444444-4444-4444-8444-444444444444',
  attempt: 1,
  maxAttempts: 4
};

function queueStore(overrides = {}) {
  const calls = [];
  return {
    calls,
    async reapExhaustedLeases() { calls.push('reap'); return 0; },
    async claimBatch() { calls.push('claim'); return [job]; },
    async renewLease() { calls.push('renew'); return true; },
    async startClaim(input) { calls.push({ start: input }); return { status: 'running' }; },
    async completeClaim(input) { calls.push({ complete: input }); return { status: 'succeeded' }; },
    async failClaim(input) { calls.push({ fail: input }); return { retried: input.retryable }; },
    ...overrides
  };
}

test('AI queue worker starts and completes a leased task with provider metadata', async () => {
  const store = queueStore();
  const worker = createAITaskQueueWorker({
    queueStore: store,
    workerId: 'worker-test',
    leaseMs: 300,
    resolveProvider: async () => ({ provider: 'mock', model: 'mock-v1' }),
    handler: async ({ payload, provider }) => ({ proposal: payload.prompt, provider: provider.provider })
  });
  const batch = await worker.runOnce();
  assert.equal(batch.claimed, 1);
  assert.equal(batch.outcomes[0].ok, true);
  assert.equal(store.calls.some(call => call.start?.provider === 'mock'), true);
  assert.equal(store.calls.some(call => call.complete?.result?.proposal === 'Create a draft'), true);
});

test('AI queue worker retries retryable provider failures using bounded exponential delay', async () => {
  const store = queueStore();
  const worker = createAITaskQueueWorker({
    queueStore: store,
    workerId: 'worker-test',
    leaseMs: 300,
    resolveProvider: async () => ({ provider: 'mock', model: 'mock-v1' }),
    handler: async () => { throw Object.assign(new Error('busy'), { code: 'ERR_PROVIDER_BUSY', statusCode: 503 }); }
  });
  const batch = await worker.runOnce();
  assert.equal(batch.outcomes[0].retried, true);
  const failure = store.calls.find(call => call.fail);
  assert.equal(failure.fail.retryable, true);
  assert.equal(failure.fail.retryDelayMs, 1000);
  assert.equal(failure.fail.errorCode, 'ERR_PROVIDER_BUSY');
});

test('AI queue worker does not mutate a job after its lease is lost', async () => {
  let renewalResolve;
  const store = queueStore({
    async renewLease() {
      return new Promise(resolve => { renewalResolve = resolve; });
    }
  });
  const worker = createAITaskQueueWorker({
    queueStore: store,
    workerId: 'worker-test',
    leaseMs: 60,
    resolveProvider: async () => ({ provider: 'mock', model: 'mock-v1' }),
    handler: async ({ signal }) => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    })
  });
  const pending = worker.processOne(job);
  await new Promise(resolve => setTimeout(resolve, 30));
  renewalResolve(false);
  const result = await pending;
  assert.equal(result.leaseLost, true);
  assert.equal(store.calls.some(call => call.fail), false);
  assert.equal(store.calls.some(call => call.complete), false);
});

test('AI queue worker records exhausted/non-retryable failure as terminal', async () => {
  const store = queueStore();
  const worker = createAITaskQueueWorker({
    queueStore: store,
    workerId: 'worker-test',
    leaseMs: 300,
    resolveProvider: async () => ({ provider: 'mock', model: 'mock-v1' }),
    handler: async () => { throw Object.assign(new Error('denied'), { code: 'ERR_POLICY_BLOCKED', statusCode: 403 }); }
  });
  const result = await worker.processOne(job);
  assert.equal(result.retried, false);
  const failure = store.calls.find(call => call.fail);
  assert.equal(failure.fail.retryable, false);
});

test('AI queue worker validates contracts and uses deterministic bounded backoff', () => {
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(3), 4000);
  assert.equal(retryDelayMs(20), 300000);
  assert.throws(() => createAITaskQueueWorker({}), /queueStore/);
});


test('AI queue worker aborts provider work on worker shutdown without marking the claim complete or failed', async () => {
  const store = queueStore();
  const worker = createAITaskQueueWorker({
    queueStore: store,
    workerId: 'worker-test',
    leaseMs: 300,
    resolveProvider: async () => ({ provider: 'mock', model: 'mock-v1' }),
    handler: async ({ signal }) => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    })
  });
  const controller = new AbortController();
  const pending = worker.processOne(job, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort(new Error('shutdown'));
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(store.calls.some(call => call.fail), false);
  assert.equal(store.calls.some(call => call.complete), false);
});

test('AI queue worker does not retry unknown programming errors by default', async () => {
  const store = queueStore();
  const worker = createAITaskQueueWorker({
    queueStore: store,
    workerId: 'worker-test',
    leaseMs: 300,
    resolveProvider: async () => ({ provider: 'mock', model: 'mock-v1' }),
    handler: async () => { throw new TypeError('unexpected shape'); }
  });
  const result = await worker.processOne(job);
  assert.equal(result.retried, false);
  const failure = store.calls.find(call => call.fail);
  assert.equal(failure.fail.retryable, false);
  assert.equal(failure.fail.errorCode, 'ERR_VIRGOSCORPIO_HUB_AI_FAILURE');
});
