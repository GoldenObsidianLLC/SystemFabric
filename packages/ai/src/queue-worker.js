'use strict';

const { randomUUID } = require('node:crypto');

function safeErrorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'ERR_VIRGOSCORPIO_HUB_AI_FAILURE';
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
]);

function defaultRetryable(error) {
  const status = Number(error?.statusCode);
  if (Number.isFinite(status)) return status === 429 || status >= 500;
  return RETRYABLE_NETWORK_CODES.has(String(error?.code || ''));
}

function retryDelayMs(attempt, { baseMs = 1000, maxMs = 300_000 } = {}) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer.');
  return Math.min(maxMs, baseMs * (2 ** Math.min(attempt - 1, 20)));
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Worker stopped.'));
    let timer;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason || new Error('Worker stopped.'));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function createAITaskQueueWorker({
  queueStore,
  resolveProvider,
  handler,
  workerId = 'vsh-ai-' + randomUUID(),
  batchSize = 5,
  leaseMs = 30_000,
  pollMs = 1000,
  retryBaseMs = 1000,
  retryMaxMs = 300_000,
  isRetryable = defaultRetryable,
  onError = () => {}
} = {}) {
  if (!queueStore || typeof queueStore.claimBatch !== 'function' ||
      typeof queueStore.startClaim !== 'function' ||
      typeof queueStore.renewLease !== 'function' ||
      typeof queueStore.completeClaim !== 'function' ||
      typeof queueStore.failClaim !== 'function') {
    throw new TypeError('queueStore must implement the durable AI task queue contract.');
  }
  if (typeof resolveProvider !== 'function' || typeof handler !== 'function') {
    throw new TypeError('resolveProvider and handler are required.');
  }
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) {
    throw new TypeError('workerId must be a safe 1-100 character identifier.');
  }
  for (const [name, value, max] of [
    ['batchSize', batchSize, 50], ['leaseMs', leaseMs, 300_000],
    ['pollMs', pollMs, 60_000], ['retryBaseMs', retryBaseMs, 60_000],
    ['retryMaxMs', retryMaxMs, 3_600_000]
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(name + ' is outside its allowed range.');
  }
  if (typeof isRetryable !== 'function' || typeof onError !== 'function') {
    throw new TypeError('isRetryable and onError must be functions.');
  }

  async function processOne(job, { signal: workerSignal } = {}) {
    const { task } = job;
    if (workerSignal?.aborted) return { taskId: task.id, ok: false, aborted: true };
    const controller = new AbortController();
    const abortOnShutdown = () => {
      if (!controller.signal.aborted) {
        controller.abort(workerSignal?.reason || new Error('AI task worker is shutting down.'));
      }
    };
    if (workerSignal?.aborted) abortOnShutdown();
    else workerSignal?.addEventListener('abort', abortOnShutdown, { once: true });
    const startedAt = Date.now();
    let timer = null;
    let renewing = false;
    let leaseLost = false;
    const heartbeatMs = Math.max(10, Math.floor(leaseMs / 3));

    const heartbeat = async () => {
      if (controller.signal.aborted || renewing) return;
      renewing = true;
      try {
        const renewed = await queueStore.renewLease({
          taskId: task.id, workerId, claimToken: job.claimToken, leaseMs
        });
        if (!renewed) {
          leaseLost = true;
          controller.abort(Object.assign(new Error('AI task lease was lost.'), {
            code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_LEASE_LOST'
          }));
          return;
        }
      } catch {
        leaseLost = true;
        controller.abort(Object.assign(new Error('AI task lease renewal failed.'), {
          code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_LEASE_LOST'
        }));
        return;
      } finally {
        renewing = false;
      }
      if (!controller.signal.aborted) timer = setTimeout(heartbeat, heartbeatMs);
    };

    timer = setTimeout(heartbeat, heartbeatMs);
    try {
      const provider = await resolveProvider({ task, payload: job.payload });
      if (!provider || typeof provider.provider !== 'string' || typeof provider.model !== 'string') {
        throw Object.assign(new Error('AI worker provider selection is invalid.'), {
          code: 'ERR_VIRGOSCORPIO_HUB_AI_PROVIDER_INVALID', statusCode: 503
        });
      }
      await queueStore.startClaim({
        taskId: task.id, siteId: task.siteId, workerId,
        claimToken: job.claimToken, provider: provider.provider, model: provider.model
      });
      const output = await handler({
        task, payload: job.payload, provider, attempt: job.attempt,
        signal: controller.signal
      });
      if (workerSignal?.aborted) return { taskId: task.id, ok: false, aborted: true };
      if (controller.signal.aborted || leaseLost) return { taskId: task.id, ok: false, leaseLost: true };
      const completed = await queueStore.completeClaim({
        taskId: task.id, siteId: task.siteId, workerId,
        claimToken: job.claimToken, result: output, latencyMs: Date.now() - startedAt
      });
      return { taskId: task.id, ok: true, result: completed };
    } catch (error) {
      if (workerSignal?.aborted) {
        return { taskId: task.id, ok: false, aborted: true };
      }
      if (controller.signal.aborted || leaseLost ||
          error?.code === 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_LEASE_LOST') {
        return { taskId: task.id, ok: false, leaseLost: true };
      }
      const errorCode = safeErrorCode(error);
      let retry = false;
      try { retry = isRetryable(error) === true; } catch {}
      try {
        const outcome = await queueStore.failClaim({
          taskId: task.id,
          siteId: task.siteId,
          workerId,
          claimToken: job.claimToken,
          errorCode,
          retryable: retry,
          retryDelayMs: retryDelayMs(job.attempt, { baseMs: retryBaseMs, maxMs: retryMaxMs }),
          latencyMs: Date.now() - startedAt
        });
        try { onError({ taskId: task.id, errorCode, retried: outcome.retried, attempts: outcome.attempts }); } catch {}
        return { taskId: task.id, ok: false, ...outcome };
      } catch (persistenceError) {
        try {
          onError({
            taskId: task.id,
            errorCode: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_STATE_FAILED',
            leaseLost: persistenceError?.code === 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_LEASE_LOST'
          });
        } catch {}
        return { taskId: task.id, ok: false, leaseLost: persistenceError?.code === 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_LEASE_LOST' };
      }
    } finally {
      if (timer) clearTimeout(timer);
      workerSignal?.removeEventListener('abort', abortOnShutdown);
    }
  }

  return Object.freeze({
    async runOnce({ signal } = {}) {
      const exhausted = typeof queueStore.reapExhaustedLeases === 'function'
        ? await queueStore.reapExhaustedLeases({ limit: batchSize * 10 })
        : 0;
      const jobs = await queueStore.claimBatch({ workerId, batchSize, leaseMs });
      const outcomes = await Promise.all(jobs.map(job => processOne(job, { signal })));
      return { claimed: jobs.length, exhausted, outcomes };
    },

    async run({ signal } = {}) {
      while (!signal?.aborted) {
        const batch = await this.runOnce({ signal });
        if (signal?.aborted) break;
        if (batch.claimed === 0 && batch.exhausted === 0) {
          try { await delay(pollMs, signal); }
          catch { break; }
        }
      }
    },

    processOne
  });
}

module.exports = { createAITaskQueueWorker, retryDelayMs };
