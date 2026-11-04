'use strict';

const { randomUUID } = require('node:crypto');
const { createAITaskPayloadCipher } = require('../../security/src/ai-task-payload');
const { withTransaction } = require('./transaction');

const { UUID_RE } = require('../../domain/src/identifiers');
const ERROR_CODE_RE = /^[A-Z0-9_]{1,100}$/;
const TASK_TYPES = new Set(['page_draft', 'content_assist', 'seo', 'translate']);
const MAX_POSTGRES_INTEGER = 2_147_483_647;

function queueError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function requireUuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw queueError(name + ' must be a UUID.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
  }
  return value.toLowerCase();
}

function requireInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw queueError(name + ' must be an integer between ' + min + ' and ' + max + '.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
  }
  return value;
}

function safeErrorCode(value) {
  return typeof value === 'string' && ERROR_CODE_RE.test(value)
    ? value
    : 'ERR_VIRGOSCORPIO_HUB_AI_FAILURE';
}

function leaseLost() {
  return queueError('The AI task lease is no longer owned by this worker.',
    'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_LEASE_LOST', 409);
}

function createAITaskQueueStore({ pool, encryptionKey, maxPayloadBytes } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with query() and connect() is required.');
  }
  const cipher = createAITaskPayloadCipher({ encryptionKey, maxBytes: maxPayloadBytes });

  function openPayload(row, purpose) {
    const columnPrefix = purpose === 'input' ? 'payload' : 'result';
    return cipher.open({
      taskId: row.task_id,
      siteId: row.site_id,
      purpose,
      envelope: {
        nonce: row[columnPrefix + '_nonce'],
        ciphertext: row[columnPrefix + '_ciphertext'],
        tag: row[columnPrefix + '_tag']
      }
    });
  }

  return Object.freeze({
    async isAvailable() {
      const result = await pool.query(
        "SELECT to_regclass('ai_task_queue') AS queue_table, to_regclass('ai_tasks') AS task_table"
      );
      return Boolean(result.rows[0]?.queue_table && result.rows[0]?.task_table);
    },


    async createAndEnqueue({
      siteId, actorId = null, requestId, taskType, inputChars = 0,
      payload, maxAttempts = 5, availableAt = null
    }) {
      const site = requireUuid(siteId, 'siteId');
      const actor = actorId === null ? null : requireUuid(actorId, 'actorId');
      if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 128) {
        throw queueError('requestId must contain between 1 and 128 characters.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      }
      if (!TASK_TYPES.has(taskType)) {
        throw queueError('taskType is not supported.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      }
      requireInteger(inputChars, 'inputChars', 0, MAX_POSTGRES_INTEGER);
      const attempts = requireInteger(maxAttempts, 'maxAttempts', 1, 20);
      if (availableAt !== null && (typeof availableAt !== 'string' || !Number.isFinite(Date.parse(availableAt)))) {
        throw queueError('availableAt must be a valid timestamp or null.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      }

      const taskId = randomUUID();
      const sealed = cipher.seal({ taskId, siteId: site, purpose: 'input', value: payload });
      return withTransaction(pool, async client => {
        const created = await client.query(
          'INSERT INTO ai_tasks(id,site_id,actor_id,request_id,task_type,input_chars) ' +
          'VALUES($1,$2,$3,$4,$5,$6) ' +
          'RETURNING id,site_id,actor_id,request_id,task_type,status,provider,model,input_chars,' +
          'output_chars,latency_ms,error_code,task_version,created_at,started_at,completed_at,updated_at',
          [taskId, site, actor, requestId, taskType, inputChars]
        );
        if (!created.rows[0]) {
          throw queueError('AI task metadata could not be created.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_CREATE_FAILED', 503);
        }

        const queued = await client.query(
          'INSERT INTO ai_task_queue(task_id,payload_nonce,payload_ciphertext,payload_tag,max_attempts,available_at) ' +
          'VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now())) ' +
          'RETURNING task_id,attempts,max_attempts,available_at,created_at',
          [taskId, sealed.nonce, sealed.ciphertext, sealed.tag, attempts, availableAt]
        );
        if (!queued.rows[0]) {
          throw queueError('AI task payload could not be queued.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_ENQUEUE_FAILED', 503);
        }

        const task = created.rows[0];
        const queue = queued.rows[0];
        return {
          task: {
            id: task.id, siteId: task.site_id, actorId: task.actor_id,
            requestId: task.request_id, taskType: task.task_type, status: task.status,
            provider: task.provider, model: task.model, inputChars: task.input_chars,
            outputChars: task.output_chars, latencyMs: task.latency_ms,
            errorCode: task.error_code, version: task.task_version,
            createdAt: task.created_at, startedAt: task.started_at,
            completedAt: task.completed_at, updatedAt: task.updated_at
          },
          queue: {
            taskId: queue.task_id, attempts: queue.attempts,
            maxAttempts: queue.max_attempts, availableAt: queue.available_at,
            createdAt: queue.created_at
          }
        };
      });
    },

    async enqueue({ taskId, siteId, payload, maxAttempts = 5, availableAt = null }) {
      const id = requireUuid(taskId, 'taskId');
      const site = requireUuid(siteId, 'siteId');
      const attempts = requireInteger(maxAttempts, 'maxAttempts', 1, 20);
      if (availableAt !== null && (typeof availableAt !== 'string' || !Number.isFinite(Date.parse(availableAt)))) {
        throw queueError('availableAt must be a valid timestamp or null.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      }
      const sealed = cipher.seal({ taskId: id, siteId: site, purpose: 'input', value: payload });
      const result = await pool.query(
        'INSERT INTO ai_task_queue(task_id,payload_nonce,payload_ciphertext,payload_tag,max_attempts,available_at) ' +
        "SELECT t.id,$3,$4,$5,$6,COALESCE($7::timestamptz,now()) FROM ai_tasks t " +
        "WHERE t.id=$1 AND t.site_id=$2 AND t.status='queued' " +
        'RETURNING task_id,attempts,max_attempts,available_at,created_at',
        [id, site, sealed.nonce, sealed.ciphertext, sealed.tag, attempts, availableAt]
      );
      if (!result.rows[0]) {
        throw queueError('The metadata task does not exist in the selected site or is not queueable.',
          'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_TASK_NOT_QUEUEABLE', 409);
      }
      const row = result.rows[0];
      return { taskId: row.task_id, attempts: row.attempts, maxAttempts: row.max_attempts,
        availableAt: row.available_at, createdAt: row.created_at };
    },

    async claimBatch({ workerId, batchSize = 5, leaseMs = 30_000 } = {}) {
      if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) {
        throw queueError('workerId must be a safe 1-100 character identifier.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      }
      requireInteger(batchSize, 'batchSize', 1, 50);
      requireInteger(leaseMs, 'leaseMs', 1, 300_000);
      const sql = [
        'WITH candidates AS (',
        '  SELECT q.task_id FROM ai_task_queue q JOIN ai_tasks t ON t.id=q.task_id',
        "  WHERE t.status IN ('queued','running') AND q.payload_ciphertext IS NOT NULL",
        '    AND q.attempts < q.max_attempts AND q.available_at <= now()',
        '    AND (q.claim_token IS NULL OR q.lease_expires_at <= now())',
        '  ORDER BY q.available_at,q.created_at,q.task_id',
        '  LIMIT $1 FOR UPDATE OF q,t SKIP LOCKED',
        '), claimed AS (',
        '  UPDATE ai_task_queue q SET locked_by=$2,claim_token=gen_random_uuid(),',
        "    lease_expires_at=now()+($3::text || ' milliseconds')::interval,",
        '    attempts=q.attempts+1,updated_at=now()',
        '  FROM candidates c WHERE q.task_id=c.task_id',
        '  RETURNING q.task_id,q.payload_nonce,q.payload_ciphertext,q.payload_tag,',
        '    q.attempts,q.max_attempts,q.claim_token,q.lease_expires_at',
        '), started AS (',
        "  UPDATE ai_tasks t SET status='running',started_at=COALESCE(t.started_at,now()),",
        '    updated_at=now(),task_version=t.task_version+1',
        "  FROM claimed c WHERE t.id=c.task_id AND t.status IN ('queued','running')",
        '  RETURNING t.id,t.site_id,t.actor_id,t.request_id,t.task_type,t.status,',
        '    t.provider,t.model,t.input_chars,t.task_version,t.created_at,t.started_at',
        ')',
        'SELECT s.id AS task_id,s.site_id,s.actor_id,s.request_id,s.task_type,s.status,',
        '  s.provider,s.model,s.input_chars,s.task_version,s.created_at,s.started_at,',
        '  c.payload_nonce,c.payload_ciphertext,c.payload_tag,c.attempts,c.max_attempts,',
        '  c.claim_token,c.lease_expires_at FROM claimed c JOIN started s ON s.id=c.task_id',
        'ORDER BY c.lease_expires_at,c.task_id'
      ].join('\n');
      const result = await pool.query(sql, [batchSize, workerId, leaseMs]);
      return result.rows.map(row => ({
        task: {
          id: row.task_id, siteId: row.site_id, actorId: row.actor_id,
          requestId: row.request_id, taskType: row.task_type, status: row.status,
          provider: row.provider, model: row.model, inputChars: row.input_chars,
          version: row.task_version, createdAt: row.created_at, startedAt: row.started_at
        },
        payload: openPayload(row, 'input'),
        workerId, claimToken: row.claim_token, leaseExpiresAt: row.lease_expires_at,
        attempt: row.attempts, maxAttempts: row.max_attempts
      }));
    },

    async renewLease({ taskId, workerId, claimToken, leaseMs = 30_000 }) {
      const id = requireUuid(taskId, 'taskId');
      requireUuid(claimToken, 'claimToken');
      requireInteger(leaseMs, 'leaseMs', 1, 300_000);
      if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) {
        throw queueError('workerId must be a safe 1-100 character identifier.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      }
      const result = await pool.query(
        "UPDATE ai_task_queue SET lease_expires_at=now()+($4::text || ' milliseconds')::interval,updated_at=now() " +
        'WHERE task_id=$1 AND locked_by=$2 AND claim_token=$3 AND lease_expires_at > now() RETURNING task_id',
        [id, workerId, claimToken, leaseMs]
      );
      return Boolean(result.rowCount);
    },

    async startClaim({ taskId, siteId, workerId, claimToken, provider, model }) {
      const id = requireUuid(taskId, 'taskId');
      const site = requireUuid(siteId, 'siteId');
      requireUuid(claimToken, 'claimToken');
      if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId) ||
          typeof provider !== 'string' || provider.length < 1 || provider.length > 80 ||
          typeof model !== 'string' || model.length < 1 || model.length > 180) {
        throw queueError('workerId, provider and model must be valid bounded strings.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      }
      return withTransaction(pool, async client => {
        const locked = await client.query(
          'SELECT t.status,t.provider,t.model FROM ai_task_queue q JOIN ai_tasks t ON t.id=q.task_id ' +
          'WHERE q.task_id=$1 AND t.site_id=$2 AND q.locked_by=$3 AND q.claim_token=$4 ' +
          'AND q.lease_expires_at > now() FOR UPDATE OF q',
          [id, site, workerId, claimToken]
        );
        const current = locked.rows[0];
        if (!current) throw leaseLost();
        if (current.status !== 'running' ||
            (current.provider && current.provider !== provider) ||
            (current.model && current.model !== model)) {
          throw queueError('The active AI task provider does not match the current lease selection.',
            'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PROVIDER_CONFLICT', 409);
        }
        const result = await client.query(
          "UPDATE ai_tasks SET provider=COALESCE(provider,$3),model=COALESCE(model,$4),updated_at=now()," +
          "task_version=task_version+1 WHERE id=$1 AND site_id=$2 AND status='running' RETURNING id",
          [id, site, provider, model]
        );
        if (!result.rows[0]) throw leaseLost();
        return { taskId: id, status: 'running', provider, model };
      });
    },

    async completeClaim({ taskId, siteId, workerId, claimToken, result: output, latencyMs = 0 }) {
      const id = requireUuid(taskId, 'taskId');
      const site = requireUuid(siteId, 'siteId');
      requireUuid(claimToken, 'claimToken');
      requireInteger(latencyMs, 'latencyMs', 0, MAX_POSTGRES_INTEGER);
      if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) {
        throw queueError('workerId must be a safe 1-100 character identifier.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      }
      let serialized;
      try { serialized = JSON.stringify(output); }
      catch { throw queueError('AI task result must be JSON-serializable.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID'); }
      if (typeof serialized !== 'string') throw queueError('AI task result must be JSON-serializable.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      const sealed = cipher.seal({ taskId: id, siteId: site, purpose: 'result', value: output });

      return withTransaction(pool, async client => {
        const locked = await client.query(
          "SELECT q.task_id FROM ai_task_queue q JOIN ai_tasks t ON t.id=q.task_id " +
          "WHERE q.task_id=$1 AND t.site_id=$2 AND t.status='running' " +
          'AND q.locked_by=$3 AND q.claim_token=$4 AND q.lease_expires_at > now() FOR UPDATE OF q',
          [id, site, workerId, claimToken]
        );
        if (!locked.rows[0]) throw leaseLost();
        const task = await client.query(
          "UPDATE ai_tasks SET status='succeeded',output_chars=$3,latency_ms=$4,error_code=NULL," +
          'completed_at=now(),updated_at=now(),task_version=task_version+1 ' +
          "WHERE id=$1 AND site_id=$2 AND status='running' RETURNING id",
          [id, site, serialized.length, latencyMs]
        );
        if (!task.rows[0]) throw leaseLost();
        await client.query(
          'UPDATE ai_task_queue SET payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,' +
          'result_nonce=$4,result_ciphertext=$5,result_tag=$6,locked_by=NULL,claim_token=NULL,' +
          'lease_expires_at=NULL,last_error_code=NULL,updated_at=now() ' +
          'WHERE task_id=$1 AND locked_by=$2 AND claim_token=$3',
          [id, workerId, claimToken, sealed.nonce, sealed.ciphertext, sealed.tag]
        );
        return { taskId: id, status: 'succeeded', outputChars: serialized.length, latencyMs };
      });
    },

    async failClaim({ taskId, siteId, workerId, claimToken, errorCode, retryable = false, retryDelayMs = 1000, latencyMs = 0 }) {
      const id = requireUuid(taskId, 'taskId');
      const site = requireUuid(siteId, 'siteId');
      requireUuid(claimToken, 'claimToken');
      requireInteger(latencyMs, 'latencyMs', 0, MAX_POSTGRES_INTEGER);
      requireInteger(retryDelayMs, 'retryDelayMs', 0, 3_600_000);
      if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) {
        throw queueError('workerId must be a safe 1-100 character identifier.', 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_INVALID');
      }
      const code = safeErrorCode(errorCode);

      return withTransaction(pool, async client => {
        const locked = await client.query(
          "SELECT q.attempts,q.max_attempts FROM ai_task_queue q JOIN ai_tasks t ON t.id=q.task_id " +
          "WHERE q.task_id=$1 AND t.site_id=$2 AND t.status='running' " +
          'AND q.locked_by=$3 AND q.claim_token=$4 AND q.lease_expires_at > now() FOR UPDATE OF q',
          [id, site, workerId, claimToken]
        );
        const row = locked.rows[0];
        if (!row) throw leaseLost();
        const retry = retryable === true && row.attempts < row.max_attempts;
        if (retry) {
          await client.query(
            "UPDATE ai_tasks SET status='queued',started_at=NULL,provider=NULL,model=NULL,updated_at=now(),task_version=task_version+1 " +
            "WHERE id=$1 AND site_id=$2 AND status='running'",
            [id, site]
          );
          await client.query(
            "UPDATE ai_task_queue SET available_at=now()+($4::text || ' milliseconds')::interval," +
            'locked_by=NULL,claim_token=NULL,lease_expires_at=NULL,last_error_code=$5,updated_at=now() ' +
            'WHERE task_id=$1 AND locked_by=$2 AND claim_token=$3',
            [id, workerId, claimToken, retryDelayMs, code]
          );
          return { taskId: id, retried: true, attempts: row.attempts, maxAttempts: row.max_attempts, errorCode: code };
        }

        const task = await client.query(
          "UPDATE ai_tasks SET status='failed',latency_ms=$3,error_code=$4," +
          'completed_at=now(),updated_at=now(),task_version=task_version+1 ' +
          "WHERE id=$1 AND site_id=$2 AND status='running' RETURNING id",
          [id, site, latencyMs, code]
        );
        if (!task.rows[0]) throw leaseLost();
        await client.query(
          'UPDATE ai_task_queue SET payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,' +
          'locked_by=NULL,claim_token=NULL,lease_expires_at=NULL,last_error_code=$4,updated_at=now() ' +
          'WHERE task_id=$1 AND locked_by=$2 AND claim_token=$3',
          [id, workerId, claimToken, code]
        );
        return { taskId: id, retried: false, attempts: row.attempts, maxAttempts: row.max_attempts, errorCode: code };
      });
    },

    async cancelQueued({ taskId, siteId, actorId = null }) {
      const id = requireUuid(taskId, 'taskId');
      const site = requireUuid(siteId, 'siteId');
      if (actorId !== null) requireUuid(actorId, 'actorId');
      return withTransaction(pool, async client => {
        const cancelled = await client.query(
          "UPDATE ai_tasks t SET status='cancelled',error_code='ERR_VIRGOSCORPIO_HUB_AI_CANCELLED'," +
          'completed_at=now(),updated_at=now(),task_version=task_version+1 ' +
          'FROM ai_task_queue q WHERE t.id=q.task_id AND t.id=$1 AND t.site_id=$2 ' +
          "AND t.actor_id IS NOT DISTINCT FROM $3::uuid AND t.status='queued' AND q.claim_token IS NULL RETURNING t.id",
          [id, site, actorId]
        );
        if (!cancelled.rows[0]) return false;
        await client.query(
          'UPDATE ai_task_queue SET payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=now() WHERE task_id=$1',
          [id]
        );
        return true;
      });
    },

    async reapExhaustedLeases({ limit = 50 } = {}) {
      requireInteger(limit, 'limit', 1, 500);
      const sql = [
        'WITH expired AS (',
        ' SELECT q.task_id FROM ai_task_queue q JOIN ai_tasks t ON t.id=q.task_id',
        " WHERE t.status='running' AND q.claim_token IS NOT NULL",
        '   AND q.lease_expires_at <= now() AND q.attempts >= q.max_attempts',
        ' ORDER BY q.lease_expires_at,q.task_id LIMIT $1 FOR UPDATE OF q SKIP LOCKED',
        '), failed AS (',
        " UPDATE ai_tasks t SET status='failed',error_code='ERR_VIRGOSCORPIO_HUB_AI_QUEUE_ATTEMPTS_EXHAUSTED',",
        ' completed_at=now(),updated_at=now(),task_version=t.task_version+1',
        ' FROM expired e WHERE t.id=e.task_id AND t.status=\'running\' RETURNING t.id',
        ')',
        'UPDATE ai_task_queue q SET payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,',
        ' locked_by=NULL,claim_token=NULL,lease_expires_at=NULL,',
        " last_error_code='ERR_VIRGOSCORPIO_HUB_AI_QUEUE_ATTEMPTS_EXHAUSTED',updated_at=now()",
        'FROM failed f WHERE q.task_id=f.id RETURNING q.task_id'
      ].join('\n');
      const result = await pool.query(sql, [limit]);
      return result.rowCount || 0;
    },

    async getResult({ taskId, siteId, actorId = null }) {
      const id = requireUuid(taskId, 'taskId');
      const site = requireUuid(siteId, 'siteId');
      if (actorId !== null) requireUuid(actorId, 'actorId');
      const result = await pool.query(
        "SELECT t.id AS task_id,t.site_id,q.result_nonce,q.result_ciphertext,q.result_tag," +
        't.output_chars,t.completed_at FROM ai_tasks t JOIN ai_task_queue q ON q.task_id=t.id ' +
        "WHERE t.id=$1 AND t.site_id=$2 AND t.actor_id IS NOT DISTINCT FROM $3::uuid " +
        "AND t.status='succeeded' AND q.result_ciphertext IS NOT NULL",
        [id, site, actorId]
      );
      const row = result.rows[0];
      if (!row) return null;
      return { result: openPayload(row, 'result'), outputChars: row.output_chars, completedAt: row.completed_at };
    }
  });
}

module.exports = { createAITaskQueueStore };
