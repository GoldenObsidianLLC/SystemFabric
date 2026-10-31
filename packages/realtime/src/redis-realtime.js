'use strict';

const { randomUUID } = require('node:crypto');
const { SITE_ID_RE, realtimeError } = require('./event-hub');
const { validateCollaborationOperation } = require('../../collaboration/src');

const DEFAULT_CHANNEL_PREFIX = 'systemfabric:realtime:v1';
const CHANNEL_PREFIX_RE = /^[A-Za-z0-9:_-]{1,96}$/;
const EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRESENCE_PAYLOAD = Object.freeze({ kind: 'presence.refresh' });
const DOCUMENT_ID_RE = SITE_ID_RE;
const DEFAULT_DOCUMENT_MESSAGE_BYTES = 16_384;
const DEFAULT_DOCUMENT_INBOUND_QUEUE = 1_024;

function safeErrorCode(error) {
  return String(error?.code || 'ERR_REDIS_CONNECTION').slice(0, 100);
}

function validateAuthorizationEnvelope(value, maxMessageBytes) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxMessageBytes) return null;
  let envelope;
  try { envelope = JSON.parse(value); } catch { return null; }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.schemaVersion !== 1 ||
      Object.keys(envelope).some(key => !['schemaVersion', 'publisherId', 'eventId', 'occurredAt', 'payload'].includes(key)) ||
      !EVENT_ID_RE.test(envelope.eventId || '') || !EVENT_ID_RE.test(envelope.publisherId || '') ||
      typeof envelope.occurredAt !== 'string' || !Number.isFinite(Date.parse(envelope.occurredAt))) return null;
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.kind !== 'authorization.invalidate') return null;
  if (Object.keys(payload).some(key => !['kind', 'siteId', 'principalId', 'sessionId'].includes(key))) return null;
  const siteId = payload.siteId === undefined ? null : payload.siteId;
  const principalId = payload.principalId === undefined ? null : payload.principalId;
  const sessionId = payload.sessionId === undefined ? null : payload.sessionId;
  if ((siteId !== null && (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId))) ||
      (principalId !== null && (typeof principalId !== 'string' || !SITE_ID_RE.test(principalId))) ||
      (sessionId !== null && (typeof sessionId !== 'string' || !SITE_ID_RE.test(sessionId))) ||
      (siteId === null && principalId === null && sessionId === null)) return null;
  return {
    eventId: envelope.eventId,
    occurredAt: new Date(envelope.occurredAt).toISOString(),
    payload: Object.freeze({ kind: 'authorization.invalidate', ...(siteId ? { siteId: siteId.toLowerCase() } : {}), ...(principalId ? { principalId: principalId.toLowerCase() } : {}), ...(sessionId ? { sessionId: sessionId.toLowerCase() } : {}) }),
    publisherId: envelope.publisherId
  };
}

function validateDocumentEnvelope(value, expectedSiteId, expectedContentId, maxMessageBytes) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxMessageBytes ||
      typeof expectedSiteId !== 'string' || !SITE_ID_RE.test(expectedSiteId) ||
      typeof expectedContentId !== 'string' || !DOCUMENT_ID_RE.test(expectedContentId)) return null;

  let envelope;
  try { envelope = JSON.parse(value); } catch { return null; }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).some(key => ![
        'schemaVersion', 'publisherId', 'eventId', 'siteId', 'contentId', 'topic', 'occurredAt', 'payload'
      ].includes(key)) ||
      envelope.schemaVersion !== 1 ||
      !EVENT_ID_RE.test(envelope.publisherId || '') ||
      !EVENT_ID_RE.test(envelope.eventId || '') ||
      typeof envelope.siteId !== 'string' || !SITE_ID_RE.test(envelope.siteId) ||
      envelope.siteId.toLowerCase() !== expectedSiteId.toLowerCase() ||
      typeof envelope.contentId !== 'string' || !DOCUMENT_ID_RE.test(envelope.contentId) ||
      envelope.contentId.toLowerCase() !== expectedContentId.toLowerCase() ||
      envelope.topic !== 'document' ||
      typeof envelope.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(envelope.occurredAt))) return null;

  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some(key => !['kind', 'sequence', 'originConnectionId', 'operation'].includes(key)) ||
      payload.kind !== 'document.operation' ||
      !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 ||
      !(payload.originConnectionId === null ||
        (typeof payload.originConnectionId === 'string' && EVENT_ID_RE.test(payload.originConnectionId)))) return null;

  const operationValidation = validateCollaborationOperation(payload.operation);
  if (!operationValidation.valid) return null;

  return {
    eventId: envelope.eventId.toLowerCase(),
    publisherId: envelope.publisherId.toLowerCase(),
    siteId: envelope.siteId.toLowerCase(),
    contentId: envelope.contentId.toLowerCase(),
    topic: 'document',
    occurredAt: new Date(envelope.occurredAt).toISOString(),
    payload: {
      kind: 'document.operation',
      sequence: payload.sequence,
      originConnectionId: payload.originConnectionId === null ? null : payload.originConnectionId.toLowerCase(),
      operation: payload.operation
    }
  };
}

function validatePresenceEnvelope(value, expectedSiteId, maxMessageBytes) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxMessageBytes) return null;
  let envelope;
  try { envelope = JSON.parse(value); } catch { return null; }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  if (envelope.schemaVersion !== 1 || !EVENT_ID_RE.test(envelope.eventId || '') ||
      !EVENT_ID_RE.test(envelope.publisherId || '') ||
      typeof envelope.siteId !== 'string' || !SITE_ID_RE.test(envelope.siteId) ||
      envelope.siteId.toLowerCase() !== expectedSiteId ||
      envelope.topic !== 'presence' ||
      typeof envelope.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(envelope.occurredAt)) ||
      !envelope.payload || typeof envelope.payload !== 'object' ||
      Array.isArray(envelope.payload) ||
      Object.keys(envelope.payload).length !== 1 ||
      envelope.payload.kind !== 'presence.refresh') return null;
  return {
    eventId: envelope.eventId,
    siteId: expectedSiteId,
    topic: 'presence',
    occurredAt: new Date(envelope.occurredAt).toISOString(),
    payload: PRESENCE_PAYLOAD,
    publisherId: envelope.publisherId
  };
}

/**
 * Redis Pub/Sub bridge for ephemeral presence/authorization hints and bounded
 * document-operation notifications. PostgreSQL remains the durable source of
 * collaboration state; this bridge carries no identity/session data or snapshots.
 */
async function createRedisRealtimeBridge({
  url,
  channelPrefix = DEFAULT_CHANNEL_PREFIX,
  maxMessageBytes = 4_096,
  maxInboundQueue = 1_024,
  maxDocumentMessageBytes = DEFAULT_DOCUMENT_MESSAGE_BYTES,
  maxDocumentInboundQueue = DEFAULT_DOCUMENT_INBOUND_QUEUE,
  onError = () => {},
  createClient: createClientOverride,
  now = Date.now,
  metrics = null
} = {}) {
  if (typeof url !== 'string' || !url) {
    throw new Error('SYSTEMFABRIC_PRESENCE_REDIS_URL is required for the Redis real-time bridge.');
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    throw new Error('SYSTEMFABRIC_PRESENCE_REDIS_URL must be a valid redis:// or rediss:// URL.');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('SYSTEMFABRIC_PRESENCE_REDIS_URL must use redis:// or rediss://.');
  }
  if (typeof channelPrefix !== 'string' || !CHANNEL_PREFIX_RE.test(channelPrefix)) {
    throw new TypeError('channelPrefix must be a 1-96 character Redis-safe prefix.');
  }
  if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 256 || maxMessageBytes > 65_536) {
    throw new RangeError('maxMessageBytes must be between 256 and 65536.');
  }
  if (!Number.isInteger(maxInboundQueue) || maxInboundQueue < 1 || maxInboundQueue > 10_000) {
    throw new RangeError('maxInboundQueue must be between 1 and 10000.');
  }
  if (!Number.isInteger(maxDocumentMessageBytes) || maxDocumentMessageBytes < 256 || maxDocumentMessageBytes > 65_536) {
    throw new RangeError('maxDocumentMessageBytes must be between 256 and 65536.');
  }
  if (!Number.isInteger(maxDocumentInboundQueue) || maxDocumentInboundQueue < 1 || maxDocumentInboundQueue > 10_000) {
    throw new RangeError('maxDocumentInboundQueue must be between 1 and 10000.');
  }
  if (typeof onError !== 'function' || typeof now !== 'function') {
    throw new TypeError('onError and now must be functions.');
  }

  const createClient = createClientOverride || require('redis').createClient;
  const clientOptions = {
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy(retries) {
        if (retries > 10) return new Error('Redis real-time reconnect limit reached.');
        incrementMetric('redis_reconnect_attempts_total');
        return Math.min(100 * retries, 2_000);
      }
    }
  };
  const publisher = createClient(clientOptions);
  const subscriber = createClient(clientOptions);
  const instanceId = randomUUID();
  const presencePattern = channelPrefix + ':*:presence';
  const authorizationPattern = channelPrefix + ':authorization';
  const documentPattern = channelPrefix + ':*:document:*';
  let hub = null;
  let attached = false;
  let closed = false;
  let draining = false;
  let drainingDocuments = false;
  const inbound = [];
  const documentInbound = [];

  function incrementMetric(name, amount = 1) {
    try { metrics?.increment?.(name, amount); } catch {}
  }
  function setQueueGauge() {
    try { metrics?.setGauge?.('redis_inbound_queue_size', inbound.length); } catch {}
  }
  function setDocumentQueueGauge() {
    try { metrics?.setGauge?.('redis_document_inbound_queue_size', documentInbound.length); } catch {}
  }
  function setRelayState(ready) {
    const clientsReady = Boolean(publisher.isReady ?? publisher.isOpen) && Boolean(subscriber.isReady ?? subscriber.isOpen);
    const isReady = ready === true && clientsReady;
    try {
      metrics?.setGauge?.('redis_bridge_ready', isReady ? 1 : 0);
      metrics?.setGauge?.('redis_bridge_degraded', isReady ? 0 : 1);
    } catch {}
  }
  function reportError(error) {
    incrementMetric('redis_errors_total');
    setRelayState(false);
    try { onError({ errorCode: safeErrorCode(error) }); } catch {}
  }

  setRelayState(false);
  publisher.on?.('error', reportError);
  subscriber.on?.('error', reportError);
  for (const client of [publisher, subscriber]) {
    client.on?.('ready', () => setRelayState(true));
    client.on?.('reconnecting', () => setRelayState(false));
    client.on?.('end', () => setRelayState(false));
  }

  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    setRelayState(true);
  } catch (error) {
    for (const client of [publisher, subscriber]) {
      try {
        if (client.isOpen && typeof client.quit === 'function') await client.quit();
        else client.destroy?.();
      } catch { client.destroy?.(); }
    }
    throw new Error('Could not connect to the configured Redis real-time bridge (' + safeErrorCode(error) + ').');
  }

  function channelFor(siteId) {
    return channelPrefix + ':' + siteId.toLowerCase() + ':presence';
  }
  function channelForDocument(siteId, contentId) {
    return channelPrefix + ':' + siteId.toLowerCase() + ':document:' + contentId.toLowerCase();
  }

  async function drainInbound() {
    if (draining || closed) return;
    draining = true;
    try {
      while (inbound.length && !closed) {
        const message = inbound.shift();
        setQueueGauge();
        if (message.kind === 'authorization') {
          const event = validateAuthorizationEnvelope(message.message, maxMessageBytes);
          if (!event) { incrementMetric('redis_invalid_messages_total'); continue; }
          if (event.publisherId === instanceId) continue;
          try { hub.invalidateAuthorization(event.payload); } catch (error) { reportError(error); }
          continue;
        }
        const event = validatePresenceEnvelope(message.message, message.siteId, maxMessageBytes);
        if (!event) { incrementMetric('redis_invalid_messages_total'); continue; }
        if (event.publisherId === instanceId) continue;
        try {
          await hub.publish({
            siteId: event.siteId,
            topic: event.topic,
            payload: event.payload,
            eventId: event.eventId,
            occurredAt: event.occurredAt
          });
        } catch (error) {
          reportError(error);
        }
      }
    } finally {
      draining = false;
      if (inbound.length && !closed) void drainInbound();
    }
  }

  async function drainDocumentInbound() {
    if (drainingDocuments || closed) return;
    drainingDocuments = true;
    try {
      while (documentInbound.length && !closed) {
        const message = documentInbound.shift();
        setDocumentQueueGauge();
        const event = validateDocumentEnvelope(
          message.message,
          message.siteId,
          message.contentId,
          maxDocumentMessageBytes
        );
        if (!event) {
          incrementMetric('redis_document_invalid_messages_total');
          continue;
        }
        if (event.publisherId === instanceId) continue;
        try {
          await hub.publish({
            siteId: event.siteId,
            topic: 'document:' + event.contentId,
            payload: event.payload,
            eventId: event.eventId,
            occurredAt: event.occurredAt
          });
        } catch (error) {
          reportError(error);
        }
      }
    } finally {
      drainingDocuments = false;
      if (documentInbound.length && !closed) void drainDocumentInbound();
    }
  }

  async function attach(targetHub) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_CLOSED', 'The Redis real-time bridge is closed.');
    if (!targetHub || typeof targetHub.publish !== 'function' || typeof targetHub.invalidateAuthorization !== 'function') {
      throw new TypeError('A local hub with publish and authorization invalidation support is required.');
    }
    if (attached) {
      if (hub === targetHub) return;
      throw new Error('The Redis real-time bridge is already attached to another hub.');
    }
    hub = targetHub;
    try {
      const receive = (kind, message, channel) => {
        if (closed || typeof channel !== 'string' || typeof message !== 'string') return;
        if (kind === 'presence') {
          const prefix = channelPrefix + ':';
          if (!channel.startsWith(prefix) || !channel.endsWith(':presence')) return;
          const siteId = channel.slice(prefix.length, -':presence'.length);
          if (!SITE_ID_RE.test(siteId)) return;
          if (inbound.length >= maxInboundQueue) {
            incrementMetric('redis_inbound_queue_overflows_total');
            reportError({ code: 'ERR_REALTIME_INBOUND_QUEUE_FULL' });
            return;
          }
          inbound.push({ kind, message, siteId: siteId.toLowerCase() });
          incrementMetric('redis_pubsub_messages_total');
          setQueueGauge();
        } else if (kind === 'document') {
          const prefix = channelPrefix + ':';
          if (!channel.startsWith(prefix)) return;
          const scope = /^([0-9a-f-]{36}):document:([0-9a-f-]{36})$/i.exec(channel.slice(prefix.length));
          if (!scope || !SITE_ID_RE.test(scope[1]) || !DOCUMENT_ID_RE.test(scope[2])) return;
          if (documentInbound.length >= maxDocumentInboundQueue) {
            incrementMetric('redis_document_inbound_queue_overflows_total');
            setDocumentQueueGauge();
            return;
          }
          documentInbound.push({
            message,
            siteId: scope[1].toLowerCase(),
            contentId: scope[2].toLowerCase()
          });
          incrementMetric('redis_document_pubsub_messages_total');
          setDocumentQueueGauge();
          void drainDocumentInbound();
          return;
        } else {
          if (channel !== authorizationPattern) return;
          if (inbound.length >= maxInboundQueue) {
            incrementMetric('redis_inbound_queue_overflows_total');
            reportError({ code: 'ERR_REALTIME_INBOUND_QUEUE_FULL' });
            return;
          }
          inbound.push({ kind, message });
          incrementMetric('redis_pubsub_messages_total');
          setQueueGauge();
        }
        void drainInbound();
      };
      await subscriber.pSubscribe(presencePattern, (message, channel) => receive('presence', message, channel));
      await subscriber.pSubscribe(authorizationPattern, (message, channel) => receive('authorization', message, channel));
      await subscriber.pSubscribe(documentPattern, (message, channel) => receive('document', message, channel));
      attached = true;
    } catch (error) {
      hub = null;
      throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_UNAVAILABLE', 'The Redis real-time subscription could not be established.');
    }
  }

  async function publish({ siteId, topic, payload, eventId = randomUUID(), occurredAt = new Date(now()).toISOString() } = {}) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_CLOSED', 'The Redis real-time bridge is closed.');
    if (!attached || !hub) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_NOT_READY', 'The Redis real-time bridge is not ready.');
    if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId) || topic !== 'presence') {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_SCOPE_INVALID', 'A valid site-scoped presence event is required.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || payload.kind !== 'presence.refresh') {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_PAYLOAD_INVALID', 'Only presence refresh invalidations may be published through this bridge.');
    }
    if (!EVENT_ID_RE.test(eventId)) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_EVENT_ID_INVALID', 'eventId must be a UUID.');
    }
    const timestamp = new Date(occurredAt);
    if (!Number.isFinite(timestamp.getTime())) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_TIMESTAMP_INVALID', 'occurredAt must be a valid timestamp.');
    }

    const envelope = {
      schemaVersion: 1,
      publisherId: instanceId,
      eventId,
      siteId: siteId.toLowerCase(),
      topic: 'presence',
      occurredAt: timestamp.toISOString(),
      payload: PRESENCE_PAYLOAD
    };
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized) > maxMessageBytes) {
      throw realtimeError(413, 'ERR_SYSTEMFABRIC_REALTIME_EVENT_TOO_LARGE', 'Presence invalidation exceeds the configured size limit.');
    }
    // Deliver locally first: ephemeral relay failure must never suppress the
    // publisher instance's own presence refresh. Remote replicas recover by
    // their periodic authorization check and by fetching presence snapshots.
    const startedAt = now();
    const local = await hub.publish({
      siteId: envelope.siteId,
      topic: envelope.topic,
      payload: envelope.payload,
      eventId: envelope.eventId,
      occurredAt: envelope.occurredAt
    });
    try {
      await publisher.publish(channelFor(envelope.siteId), serialized);
      incrementMetric('redis_pubsub_publishes_total');
      setRelayState(true);
      try { metrics?.observe?.('redis_publish_duration_milliseconds', Math.max(0, now() - startedAt)); } catch {}
      return { ...local, relayPublished: true, degraded: false };
    } catch (error) {
      incrementMetric('redis_publish_failures_total');
      incrementMetric('fanout_failures_total');
      reportError(error);
      try { metrics?.observe?.('redis_publish_duration_milliseconds', Math.max(0, now() - startedAt)); } catch {}
      return { ...local, relayPublished: false, degraded: true };
    }
  }

  async function publishDocumentOperation({
    siteId,
    contentId,
    sequence,
    originConnectionId = null,
    operation
  } = {}) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_CLOSED', 'The Redis real-time bridge is closed.');
    if (!attached || !hub) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_NOT_READY', 'The Redis real-time bridge is not ready.');
    if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId) ||
        typeof contentId !== 'string' || !DOCUMENT_ID_RE.test(contentId)) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_SCOPE_INVALID', 'A valid site and document scope is required.');
    }
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_SEQUENCE_INVALID', 'A positive safe document sequence is required.');
    }
    if (originConnectionId !== null &&
        (typeof originConnectionId !== 'string' || !EVENT_ID_RE.test(originConnectionId))) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_ORIGIN_INVALID', 'originConnectionId must be null or a UUID.');
    }
    const validation = validateCollaborationOperation(operation);
    if (!validation.valid) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_INVALID_COLLABORATION_OPERATION', validation.errors.join('; '));
    }

    const envelope = {
      schemaVersion: 1,
      publisherId: instanceId,
      eventId: randomUUID(),
      siteId: siteId.toLowerCase(),
      contentId: contentId.toLowerCase(),
      topic: 'document',
      occurredAt: new Date(now()).toISOString(),
      payload: {
        kind: 'document.operation',
        sequence,
        originConnectionId: originConnectionId === null ? null : originConnectionId.toLowerCase(),
        operation
      }
    };
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized, 'utf8') > maxDocumentMessageBytes) {
      throw realtimeError(413, 'ERR_SYSTEMFABRIC_REALTIME_EVENT_TOO_LARGE', 'Document operation envelope exceeds the configured size limit.');
    }

    const startedAt = now();
    let local = { delivered: 0, revoked: 0, dropped: 0 };
    let localDegraded = false;
    try {
      local = await hub.publish({
        siteId: envelope.siteId,
        topic: 'document:' + envelope.contentId,
        payload: envelope.payload,
        eventId: envelope.eventId,
        occurredAt: envelope.occurredAt
      });
    } catch (error) {
      localDegraded = true;
      reportError(error);
    }

    try {
      await publisher.publish(channelForDocument(envelope.siteId, envelope.contentId), serialized);
      incrementMetric('redis_document_pubsub_publishes_total');
      setRelayState(true);
      try { metrics?.observe?.('redis_publish_duration_milliseconds', Math.max(0, now() - startedAt)); } catch {}
      return {
        ...local,
        eventId: envelope.eventId,
        relayPublished: true,
        degraded: localDegraded
      };
    } catch (error) {
      incrementMetric('redis_document_publish_failures_total');
      incrementMetric('fanout_failures_total');
      reportError(error);
      try { metrics?.observe?.('redis_publish_duration_milliseconds', Math.max(0, now() - startedAt)); } catch {}
      return {
        ...local,
        eventId: envelope.eventId,
        relayPublished: false,
        degraded: true
      };
    }
  }

  async function invalidateAuthorization({ siteId = null, principalId = null, sessionId = null } = {}) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_CLOSED', 'The Redis real-time bridge is closed.');
    if (!attached || !hub) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_NOT_READY', 'The Redis real-time bridge is not ready.');
    const payload = { kind: 'authorization.invalidate' };
    if (siteId !== null) payload.siteId = siteId;
    if (principalId !== null) payload.principalId = principalId;
    if (sessionId !== null) payload.sessionId = sessionId;
    const envelope = {
      schemaVersion: 1,
      publisherId: instanceId,
      eventId: randomUUID(),
      occurredAt: new Date(now()).toISOString(),
      payload
    };
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized) > maxMessageBytes) {
      throw realtimeError(413, 'ERR_SYSTEMFABRIC_REALTIME_EVENT_TOO_LARGE', 'Authorization invalidation exceeds the configured size limit.');
    }
    if (!validateAuthorizationEnvelope(serialized, maxMessageBytes)) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_INVALIDATION_SCOPE', 'Authorization invalidation requires valid UUID selectors.');
    }
    // Revoke local streams even if Redis is unavailable; other replicas also
    // revalidate sessions on each SSE heartbeat as a bounded fallback.
    const local = hub.invalidateAuthorization({ siteId, principalId, sessionId });
    const relayStartedAt = now();
    try {
      await publisher.publish(authorizationPattern, serialized);
      incrementMetric('redis_pubsub_publishes_total');
      setRelayState(true);
      try { metrics?.observe?.('redis_publish_duration_milliseconds', Math.max(0, now() - relayStartedAt)); } catch {}
    } catch (error) {
      incrementMetric('redis_publish_failures_total');
      incrementMetric('fanout_failures_total');
      reportError(error);
      try { metrics?.observe?.('redis_publish_duration_milliseconds', Math.max(0, now() - relayStartedAt)); } catch {}
      throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_UNAVAILABLE', 'The Redis authorization invalidation bridge is unavailable.');
    }
    return { ...local, eventId: envelope.eventId };
  }

  async function close() {
    if (closed) return;
    closed = true;
    setRelayState(false);
    inbound.length = 0;
    documentInbound.length = 0;
    setQueueGauge();
    setDocumentQueueGauge();
    const results = await Promise.allSettled([publisher, subscriber].map(async client => {
      try {
        if (client.isOpen && typeof client.quit === 'function') await client.quit();
        else client.destroy?.();
      } catch (error) {
        client.destroy?.();
        throw error;
      }
    }));
    for (const result of results) if (result.status === 'rejected') reportError(result.reason);
    hub = null;
  }

  return Object.freeze({
    attach,
    publish,
    publishDocumentOperation,
    invalidateAuthorization,
    close,
    get instanceId() { return instanceId; },
    get inboundQueueSize() { return inbound.length; },
    get documentInboundQueueSize() { return documentInbound.length; },
    get isReady() { return attached && !closed && Boolean(publisher.isReady ?? publisher.isOpen) && Boolean(subscriber.isReady ?? subscriber.isOpen); }
  });
}

module.exports = {
  DEFAULT_CHANNEL_PREFIX,
  createRedisRealtimeBridge,
  validatePresenceEnvelope,
  validateAuthorizationEnvelope,
  validateDocumentEnvelope,
  DEFAULT_DOCUMENT_MESSAGE_BYTES,
  DEFAULT_DOCUMENT_INBOUND_QUEUE
};
