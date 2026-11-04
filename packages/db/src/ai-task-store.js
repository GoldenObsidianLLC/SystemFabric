'use strict';

const { UUID_RE } = require('../../domain/src/identifiers');
const TASK_TYPES = new Set(['page_draft', 'content_assist', 'seo', 'translate']);
const TASK_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);

function invalid(message, code = 'ERR_VIRGOSCORPIO_HUB_AI_TASK_INVALID') {
  return Object.assign(new TypeError(message), { code, statusCode: 400 });
}

function conflict(message) {
  return Object.assign(new Error(message), {
    code: 'ERR_VIRGOSCORPIO_HUB_AI_TASK_CONFLICT',
    statusCode: 409
  });
}

function requireUuid(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw invalid(name + ' must be a UUID' + (nullable ? ' or null.' : '.'));
  }
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(name + ' must be a non-negative safe integer.');
  return value;
}

function safeErrorCode(value) {
  if (value === null || value === undefined) return null;
  const code = String(value);
  return /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'ERR_VIRGOSCORPIO_HUB_AI_FAILURE';
}

function toTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    siteId: row.site_id,
    requestId: row.request_id,
    taskType: row.task_type,
    status: row.status,
    provider: row.provider,
    model: row.model,
    inputChars: row.input_chars,
    outputChars: row.output_chars,
    latencyMs: row.latency_ms,
    errorCode: row.error_code,
    version: row.task_version,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

function createAITaskStore({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL-compatible pool is required.');

  async function findTask({ taskId, siteId }) {
    const result = await pool.query(
      `SELECT id,site_id,request_id,task_type,status,provider,model,
              input_chars,output_chars,latency_ms,error_code,task_version,
              created_at,started_at,completed_at,updated_at
         FROM ai_tasks
        WHERE id=$1 AND site_id=$2`,
      [taskId, siteId]
    );
    return result.rows[0] || null;
  }

  return Object.freeze({
    async isAvailable() {
      const result = await pool.query("SELECT to_regclass('ai_tasks') AS table_name");
      return Boolean(result.rows[0]?.table_name);
    },

    async create({ siteId, actorId = null, requestId, taskType, inputChars = 0 }) {
      requireUuid(siteId, 'siteId');
      requireUuid(actorId, 'actorId', true);
      if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 128) {
        throw invalid('requestId must contain between 1 and 128 characters.');
      }
      if (!TASK_TYPES.has(taskType)) throw invalid('taskType is not supported.');
      requireNonNegativeInteger(inputChars, 'inputChars');

      const result = await pool.query(
        `INSERT INTO ai_tasks(site_id,actor_id,request_id,task_type,input_chars)
         VALUES($1,$2,$3,$4,$5)
         RETURNING id,site_id,request_id,task_type,status,provider,model,
                   input_chars,output_chars,latency_ms,error_code,task_version,
                   created_at,started_at,completed_at,updated_at`,
        [siteId, actorId, requestId, taskType, inputChars]
      );
      return toTask(result.rows[0]);
    },

    async start({ taskId, siteId, provider, model }) {
      requireUuid(taskId, 'taskId');
      requireUuid(siteId, 'siteId');
      if (typeof provider !== 'string' || provider.length < 1 || provider.length > 80 ||
          typeof model !== 'string' || model.length < 1 || model.length > 180) {
        throw invalid('provider and model must be non-empty bounded strings.');
      }
      const result = await pool.query(
        `UPDATE ai_tasks
            SET status='running',provider=$3,model=$4,started_at=now(),
                updated_at=now(),task_version=task_version+1
          WHERE id=$1 AND site_id=$2 AND status='queued'
          RETURNING id,site_id,request_id,task_type,status,provider,model,
                    input_chars,output_chars,latency_ms,error_code,task_version,
                    created_at,started_at,completed_at,updated_at`,
        [taskId, siteId, provider, model]
      );
      if (result.rows[0]) return toTask(result.rows[0]);

      const existing = await findTask({ taskId, siteId });
      if (existing?.status === 'running' && existing.provider === provider && existing.model === model) {
        return toTask(existing);
      }
      if (!existing) throw Object.assign(new Error('AI task not found.'), {
        code: 'ERR_VIRGOSCORPIO_HUB_AI_TASK_NOT_FOUND',
        statusCode: 404
      });
      throw conflict('AI task cannot transition to running from its current state.');
    },

    async finish({ taskId, siteId, status, outputChars = 0, latencyMs = 0, errorCode = null }) {
      requireUuid(taskId, 'taskId');
      requireUuid(siteId, 'siteId');
      if (!TERMINAL_STATUSES.has(status)) throw invalid('status must be a terminal AI task status.');
      requireNonNegativeInteger(outputChars, 'outputChars');
      requireNonNegativeInteger(latencyMs, 'latencyMs');
      const normalizedErrorCode = safeErrorCode(errorCode);
      if (status === 'succeeded' && normalizedErrorCode) throw invalid('Successful tasks cannot have an error code.');

      const result = await pool.query(
        `UPDATE ai_tasks
            SET status=$3,output_chars=$4,latency_ms=$5,error_code=$6,
                completed_at=now(),updated_at=now(),task_version=task_version+1
          WHERE id=$1 AND site_id=$2 AND status IN ('queued','running')
            AND ($3 <> 'succeeded' OR status='running')
          RETURNING id,site_id,request_id,task_type,status,provider,model,
                    input_chars,output_chars,latency_ms,error_code,task_version,
                    created_at,started_at,completed_at,updated_at`,
        [taskId, siteId, status, outputChars, latencyMs, normalizedErrorCode]
      );
      if (result.rows[0]) return toTask(result.rows[0]);

      const existing = await findTask({ taskId, siteId });
      if (!existing) throw Object.assign(new Error('AI task not found.'), {
        code: 'ERR_VIRGOSCORPIO_HUB_AI_TASK_NOT_FOUND',
        statusCode: 404
      });
      if (existing.status === status) return toTask(existing);
      throw conflict('AI task is already terminal or cannot transition to the requested state.');
    },

    async list({ siteId, actorId = null, status = null, taskType = null, limit = 20, before = null }) {
      requireUuid(siteId, 'siteId');
      requireUuid(actorId, 'actorId', true);
      if (status !== null && !TASK_STATUSES.has(status)) {
        throw invalid('status is not a supported AI task status.');
      }
      if (taskType !== null && !TASK_TYPES.has(taskType)) throw invalid('taskType is not supported.');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw invalid('limit must be an integer between 1 and 50.');
      }

      let beforeCreatedAt = null;
      let beforeId = null;
      if (before !== null) {
        if (!before || typeof before !== 'object' || Array.isArray(before) ||
            typeof before.createdAt !== 'string' || !Number.isFinite(Date.parse(before.createdAt)) ||
            new Date(before.createdAt).toISOString() !== before.createdAt) {
          throw invalid('before must contain a canonical createdAt timestamp and task UUID.');
        }
        beforeCreatedAt = before.createdAt;
        beforeId = requireUuid(before.id, 'before.id');
      }

      const result = await pool.query(
        `SELECT id,site_id,request_id,task_type,status,provider,model,
                input_chars,output_chars,latency_ms,error_code,task_version,
                created_at,started_at,completed_at,updated_at
           FROM ai_tasks
          WHERE site_id=$1
            AND actor_id IS NOT DISTINCT FROM $2::uuid
            AND ($3::text IS NULL OR status=$3)
            AND ($4::text IS NULL OR task_type=$4)
            AND ($5::timestamptz IS NULL OR (created_at,id) < ($5::timestamptz,$6::uuid))
          ORDER BY created_at DESC,id DESC
          LIMIT $7`,
        [siteId, actorId, status, taskType, beforeCreatedAt, beforeId, limit + 1]
      );
      const rows = Array.isArray(result.rows) ? result.rows : [];
      return {
        tasks: rows.slice(0, limit).map(toTask),
        hasMore: rows.length > limit
      };
    },

    async get({ taskId, siteId, actorId = null }) {
      requireUuid(taskId, 'taskId');
      requireUuid(siteId, 'siteId');
      requireUuid(actorId, 'actorId', true);
      const result = await pool.query(
        `SELECT id,site_id,request_id,task_type,status,provider,model,
                input_chars,output_chars,latency_ms,error_code,task_version,
                created_at,started_at,completed_at,updated_at
           FROM ai_tasks
          WHERE id=$1 AND site_id=$2 AND actor_id IS NOT DISTINCT FROM $3::uuid`,
        [taskId, siteId, actorId]
      );
      return toTask(result.rows[0]);
    }
  });
}

module.exports = { createAITaskStore, TASK_TYPES, TERMINAL_STATUSES };
