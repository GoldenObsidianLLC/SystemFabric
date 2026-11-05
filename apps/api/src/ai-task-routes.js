'use strict';

const { UUID_RE } = require('../../../packages/domain/src/identifiers');

const AI_TASK_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked']);
const AI_TASK_TYPES = new Set(['page_draft', 'content_assist', 'seo', 'translate']);
const TASK_ID_PATH_RE = /^[0-9a-f-]{36}$/i;
const TASK_COLLECTION_PATH = '/api/v1/ai/tasks';
const TASK_ITEM_PREFIX = TASK_COLLECTION_PATH + '/';

function encodeAITaskCursor({ task, siteId, actorId, status, taskType }, fail) {
  const createdAt = new Date(task?.createdAt);
  if (!UUID_RE.test(task?.id || '') || !Number.isFinite(createdAt.getTime())) {
    throw fail(500, 'ERR_VIRGOSCORPIO_HUB_AI_TASK_CURSOR_SOURCE_INVALID', 'The task list could not produce a valid pagination cursor.');
  }
  const payload = { v: 1, siteId, actorId, status, taskType, createdAt: createdAt.toISOString(), id: task.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeAITaskCursor(value, expected, fail) {
  const invalidCursor = () => fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_TASK_CURSOR_INVALID', 'cursor is invalid or does not match this actor, site, or filter set.');
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidCursor();
  }

  let payload;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('Non-canonical cursor encoding.');
    payload = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload).sort().join(',')
    : '';
  if (keys !== 'actorId,createdAt,id,siteId,status,taskType,v' ||
      payload.v !== 1 || payload.siteId !== expected.siteId ||
      payload.actorId !== expected.actorId || payload.status !== expected.status ||
      payload.taskType !== expected.taskType || typeof payload.createdAt !== 'string' ||
      !UUID_RE.test(payload.id)) {
    throw invalidCursor();
  }

  const createdAt = new Date(payload.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== payload.createdAt) {
    throw invalidCursor();
  }
  return { createdAt: payload.createdAt, id: payload.id };
}

/**
 * Compose the authenticated, read-only AI task API routes.
 *
 * The API server retains request authentication, site membership resolution,
 * and the ai:use capability decision. This module owns the task/status HTTP
 * contract and binds list cursors to the actor, site, and active filters.
 */
function createAITaskRouteHandlers(dependencies = {}) {
  const {
    getTaskStore,
    getProviderInfo,
    ensureSiteCapability,
    sendJson,
    fail
  } = dependencies;

  for (const [name, value] of Object.entries({
    getTaskStore,
    getProviderInfo,
    ensureSiteCapability,
    sendJson,
    fail
  })) {
    if (typeof value !== 'function') {
      throw new TypeError('AI task routes require ' + name + '().');
    }
  }

  async function handle({ req, res, url, actor, requestId }) {
    if (!req || !res || !url || !actor) {
      throw new TypeError('AI task routes require request, response, URL, and authenticated actor context.');
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/ai/status') {
      const taskStore = await getTaskStore();
      const taskStatusAvailable = Boolean(taskStore);
      const taskListAvailable = Boolean(taskStore && typeof taskStore.list === 'function');
      return sendJson(res, 200, {
        ...getProviderInfo(),
        capabilities: [
          'page-draft', 'content-assist', 'seo-suggestion', 'translation',
          'document-validation', 'preview', 'widget-suggestion',
          ...(taskStatusAvailable ? ['task-status'] : []),
          ...(taskListAvailable ? ['task-list'] : [])
        ],
        requiresHumanReviewForDraftPersistence: true,
        durableTaskStatus: taskStatusAvailable,
        requestId
      });
    }

    if (req.method === 'GET' && url.pathname === TASK_COLLECTION_PATH) {
      const taskStore = await getTaskStore();
      if (!taskStore || typeof taskStore.list !== 'function') {
        return sendJson(res, 503, {
          error: 'AI task history requires PostgreSQL and the AI task collection store.',
          code: 'ERR_VIRGOSCORPIO_HUB_AI_TASK_LIST_DISABLED',
          requestId
        });
      }

      for (const name of ['siteId', 'limit', 'status', 'taskType', 'cursor']) {
        if (url.searchParams.getAll(name).length > 1) {
          throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_TASK_QUERY_INVALID', name + ' must be provided at most once.');
        }
      }

      const siteId = await ensureSiteCapability(actor, url);
      if (!siteId) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_SITE_REQUIRED', 'Select a site using the siteId query parameter.');

      const limitValue = url.searchParams.get('limit');
      const limit = limitValue === null ? 20 : Number(limitValue);
      if (limitValue !== null && (!/^\d{1,2}$/.test(limitValue) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
        throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_TASK_LIMIT_INVALID', 'limit must be an integer between 1 and 50.');
      }

      const status = url.searchParams.get('status');
      const taskType = url.searchParams.get('taskType');
      if (status !== null && !AI_TASK_STATUSES.has(status)) {
        throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_TASK_STATUS_INVALID', 'status is not a supported AI task status.');
      }
      if (taskType !== null && !AI_TASK_TYPES.has(taskType)) {
        throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_TASK_TYPE_INVALID', 'taskType is not supported.');
      }

      const actorId = actor.user?.id || null;
      const cursorValue = url.searchParams.get('cursor');
      const before = cursorValue === null
        ? null
        : decodeAITaskCursor(cursorValue, { siteId, actorId, status, taskType }, fail);
      const result = await taskStore.list({ siteId, actorId, status, taskType, limit, before });
      const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
      const nextCursor = result?.hasMore && tasks.length
        ? encodeAITaskCursor({ task: tasks[tasks.length - 1], siteId, actorId, status, taskType }, fail)
        : null;
      return sendJson(res, 200, { tasks, nextCursor, requestId });
    }

    const taskId = url.pathname.startsWith(TASK_ITEM_PREFIX)
      ? url.pathname.slice(TASK_ITEM_PREFIX.length)
      : '';
    if (req.method === 'GET' && TASK_ID_PATH_RE.test(taskId)) {
      const taskStore = await getTaskStore();
      if (!taskStore) {
        return sendJson(res, 503, {
          error: 'AI task status requires PostgreSQL and the AI task migration.',
          code: 'ERR_VIRGOSCORPIO_HUB_AI_TASKS_DISABLED',
          requestId
        });
      }
      const siteId = await ensureSiteCapability(actor, url);
      if (!siteId) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_SITE_REQUIRED', 'Select a site using the siteId query parameter.');
      const task = await taskStore.get({ taskId, siteId, actorId: actor.user?.id || null });
      if (!task) {
        return sendJson(res, 404, {
          error: 'AI task not found.',
          code: 'ERR_VIRGOSCORPIO_HUB_AI_TASK_NOT_FOUND',
          requestId
        });
      }
      return sendJson(res, 200, { task, requestId });
    }

    return false;
  }

  return Object.freeze({ handle });
}

module.exports = { createAITaskRouteHandlers };
