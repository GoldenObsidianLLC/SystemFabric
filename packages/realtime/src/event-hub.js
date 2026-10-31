'use strict';

const { randomUUID } = require('node:crypto');

const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOPIC_RE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;

function realtimeError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function createAsyncQueue(maxItems) {
  let items = [];
  let waiter = null;
  let closed = false;
  let closeError = null;

  function close(error = null) {
    if (closed) return;
    closed = true;
    closeError = error;
    if (waiter) {
      const pending = waiter;
      waiter = null;
      if (closeError) pending.reject(closeError);
      else pending.resolve({ value: undefined, done: true });
    }
  }

  function push(value) {
    if (closed) return false;
    if (waiter) {
      const pending = waiter;
      waiter = null;
      pending.resolve({ value, done: false });
      return true;
    }
    if (items.length >= maxItems) return false;
    items.push(value);
    return true;
  }

  const iterator = {
    next() {
      if (items.length) return Promise.resolve({ value: items.shift(), done: false });
      if (closed) return closeError ? Promise.reject(closeError) : Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    return() {
      close();
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() { return this; }
  };

  return { push, close, iterator };
}

/**
 * A bounded, process-local event hub for developer preview and tests.
 *
 * Production deployments must replace this adapter with shared fan-out and
 * distributed presence infrastructure before enabling multiple API replicas.
 */
function createRealtimeHub({
  authorizeSubscribe,
  maxSubscriptionsPerPrincipal = 4,
  maxQueueSize = 64,
  maxEventBytes = 16_384,
  now = Date.now,
  metrics = null
} = {}) {
  if (typeof authorizeSubscribe !== 'function') {
    throw new TypeError('authorizeSubscribe is required; subscriptions must fail closed.');
  }
  if (!Number.isInteger(maxSubscriptionsPerPrincipal) || maxSubscriptionsPerPrincipal < 1 || maxSubscriptionsPerPrincipal > 100) {
    throw new RangeError('maxSubscriptionsPerPrincipal must be between 1 and 100.');
  }
  if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1 || maxQueueSize > 10_000) {
    throw new RangeError('maxQueueSize must be between 1 and 10000.');
  }
  if (!Number.isInteger(maxEventBytes) || maxEventBytes < 256 || maxEventBytes > 1_048_576) {
    throw new RangeError('maxEventBytes must be between 256 bytes and 1 MiB.');
  }

  const subscriptions = new Map();
  const principalCounts = new Map();
  let closed = false;

  function incrementMetric(name, amount = 1) {
    try { metrics?.increment?.(name, amount); } catch {}
  }
  function setGauge(name, value) {
    try { metrics?.setGauge?.(name, value); } catch {}
  }

  function validateScope({ principal, siteId, topic }) {
    const principalId = typeof principal?.id === 'string' ? principal.id.trim() : '';
    if (!principalId || principalId.length > 128) {
      throw realtimeError(401, 'ERR_SYSTEMFABRIC_REALTIME_PRINCIPAL_REQUIRED', 'An authenticated principal is required.');
    }
    if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_SITE_INVALID', 'A valid siteId is required.');
    }
    if (typeof topic !== 'string' || !TOPIC_RE.test(topic) || topic.length > 64) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_TOPIC_INVALID', 'A valid event topic is required.');
    }
    return { principalId, siteId: siteId.toLowerCase(), topic };
  }

  async function subscribe({ principal, siteId, topic, sessionId = null, expiresAt = null }) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_CLOSED', 'The real-time hub is shutting down.');
    const scope = validateScope({ principal, siteId, topic });
    if (sessionId !== null && (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId))) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_SESSION_INVALID', 'sessionId must be a safe identifier.');
    }
    const expiresAtMs = expiresAt === null ? null : new Date(expiresAt).getTime();
    if (expiresAt !== null && !Number.isFinite(expiresAtMs)) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_SESSION_EXPIRY_INVALID', 'expiresAt must be a valid timestamp.');
    }
    if (expiresAtMs !== null && expiresAtMs <= now()) {
      throw realtimeError(401, 'ERR_SYSTEMFABRIC_REALTIME_SESSION_EXPIRED', 'The authenticated session has expired.');
    }
    const safePrincipal = Object.freeze({ id: scope.principalId, isDeveloper: principal.isDeveloper === true });
    let authorized = false;
    try {
      authorized = await authorizeSubscribe({ principal: safePrincipal, sessionId, expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(), siteId: scope.siteId, topic: scope.topic });
    } catch {
      authorized = false;
    }
    if (!authorized) {
      incrementMetric('authorization_denials_total');
      throw realtimeError(403, 'ERR_SYSTEMFABRIC_REALTIME_FORBIDDEN', 'The principal cannot subscribe to this site topic.');
    }

    const count = principalCounts.get(scope.principalId) || 0;
    if (count >= maxSubscriptionsPerPrincipal) {
      incrementMetric('connection_limit_rejections_total');
      throw realtimeError(429, 'ERR_SYSTEMFABRIC_REALTIME_CONNECTION_LIMIT', 'The principal has reached the real-time subscription limit.');
    }

    const id = randomUUID();
    const queue = createAsyncQueue(maxQueueSize);
    let active = true;
    const subscription = {
      id,
      principal: safePrincipal,
      sessionId,
      expiresAtMs,
      siteId: scope.siteId,
      topic: scope.topic,
      enqueue: event => queue.push(event),
      close(error = null) {
        if (!active) return;
        active = false;
        queue.close(error);
        subscriptions.delete(id);
        const remaining = (principalCounts.get(scope.principalId) || 1) - 1;
        if (remaining > 0) principalCounts.set(scope.principalId, remaining);
        else principalCounts.delete(scope.principalId);
        incrementMetric('subscriptions_closed_total');
        setGauge('active_subscriptions', subscriptions.size);
      },
      events: {
        [Symbol.asyncIterator]() {
          return {
            next: () => queue.iterator.next(),
            return: () => {
              subscription.close();
              return queue.iterator.return();
            }
          };
        }
      }
    };

    subscriptions.set(id, subscription);
    principalCounts.set(scope.principalId, count + 1);
    incrementMetric('subscriptions_opened_total');
    setGauge('active_subscriptions', subscriptions.size);
    return subscription;
  }

  async function reauthorize(subscription) {
    if (closed || !subscription || !subscriptions.has(subscription.id)) return false;
    if (subscription.expiresAtMs !== null && subscription.expiresAtMs <= now()) {
      incrementMetric('session_expirations_total');
      incrementMetric('authorization_revocations_total');
      subscription.close();
      return false;
    }
    let authorized = false;
    try {
      authorized = await authorizeSubscribe({
        principal: subscription.principal,
        sessionId: subscription.sessionId,
        expiresAt: subscription.expiresAtMs === null ? null : new Date(subscription.expiresAtMs).toISOString(),
        siteId: subscription.siteId,
        topic: subscription.topic
      });
    } catch {
      authorized = false;
    }
    if (!authorized) {
      incrementMetric('authorization_denials_total');
      incrementMetric('authorization_revocations_total');
      subscription.close();
      return false;
    }
    return subscriptions.has(subscription.id);
  }

  function invalidateAuthorization({ siteId = null, principalId = null, sessionId = null } = {}) {
    if (closed) return { revoked: 0 };
    if (siteId !== null && (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId))) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_INVALIDATION_SCOPE', 'siteId must be a valid UUID.');
    }
    for (const [label, value] of [['principalId', principalId], ['sessionId', sessionId]]) {
      if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))) {
        throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_INVALIDATION_SCOPE', `${label} must be a safe identifier.`);
      }
    }
    if (siteId === null && principalId === null && sessionId === null) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_INVALIDATION_SCOPE', 'At least one authorization invalidation selector is required.');
    }
    const normalizedSiteId = siteId === null ? null : siteId.toLowerCase();
    const normalizedPrincipalId = principalId !== null && SITE_ID_RE.test(principalId) ? principalId.toLowerCase() : principalId;
    const normalizedSessionId = sessionId !== null && SITE_ID_RE.test(sessionId) ? sessionId.toLowerCase() : sessionId;
    let revoked = 0;
    for (const subscription of [...subscriptions.values()]) {
      if (normalizedSiteId !== null && subscription.siteId !== normalizedSiteId) continue;
      if (normalizedPrincipalId !== null && subscription.principal.id !== normalizedPrincipalId) continue;
      if (normalizedSessionId !== null && subscription.sessionId !== normalizedSessionId) continue;
      subscription.close();
      revoked += 1;
    }
    incrementMetric('authorization_revocations_total', revoked);
    return { revoked };
  }

  async function publish({ siteId, topic, payload, eventId = randomUUID(), occurredAt = new Date(now()).toISOString() }) {
    if (closed) return { delivered: 0, revoked: 0, dropped: 0 };
    const scope = validateScope({ principal: { id: 'system' }, siteId, topic });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (Object.getPrototypeOf(payload) !== Object.prototype && Object.getPrototypeOf(payload) !== null)) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_PAYLOAD_INVALID', 'Event payload must be a plain JSON object.');
    }

    let serialized;
    try { serialized = JSON.stringify(payload); }
    catch { throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_PAYLOAD_INVALID', 'Event payload must be serializable JSON.'); }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > maxEventBytes) {
      throw realtimeError(413, 'ERR_SYSTEMFABRIC_REALTIME_EVENT_TOO_LARGE', 'Event payload exceeds the configured size limit.');
    }

    const event = Object.freeze({
      eventId: typeof eventId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(eventId) ? eventId : (() => { throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_EVENT_ID_INVALID', 'eventId must be a safe identifier.'); })(),
      schemaVersion: 1,
      topic: scope.topic,
      siteId: scope.siteId,
      occurredAt: (() => { const timestamp = new Date(occurredAt); if (!Number.isFinite(timestamp.getTime())) throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_TIMESTAMP_INVALID', 'occurredAt must be a valid timestamp.'); return timestamp.toISOString(); })(),
      payload: JSON.parse(serialized)
    });

    const fanoutStartedAt = now();
    let delivered = 0;
    let revoked = 0;
    let dropped = 0;
    const targets = [...subscriptions.values()].filter(item => item.siteId === scope.siteId && item.topic === scope.topic);
    incrementMetric('events_published_total');
    incrementMetric('fanout_targets_total', targets.length);
    try {
      metrics?.observe?.('fanout_targets_per_event', targets.length);
      metrics?.observe?.('event_lag_milliseconds', Math.max(0, now() - Date.parse(event.occurredAt)));
    } catch {}

    for (const subscription of targets) {
      if (!(await reauthorize(subscription))) {
        revoked += 1;
        continue;
      }
      if (!subscription.enqueue(event)) {
        subscription.close(realtimeError(429, 'ERR_SYSTEMFABRIC_REALTIME_SLOW_CONSUMER', 'The subscription fell behind and must reconnect.'));
        incrementMetric('queue_overflows_total');
        dropped += 1;
      } else {
        incrementMetric('events_delivered_total');
        delivered += 1;
      }
    }

    incrementMetric('events_revoked_total', revoked);
    try { metrics?.observe?.('fanout_duration_milliseconds', Math.max(0, now() - fanoutStartedAt)); } catch {}
    return { delivered, revoked, dropped, eventId: event.eventId };
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const subscription of [...subscriptions.values()]) subscription.close();
  }

  return Object.freeze({
    subscribe,
    publish,
    reauthorize,
    invalidateAuthorization,
    close,
    get subscriberCount() { return subscriptions.size; }
  });
}

module.exports = { createRealtimeHub, realtimeError, SITE_ID_RE };
