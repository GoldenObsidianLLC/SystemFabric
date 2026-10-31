'use strict';

const { randomUUID } = require('node:crypto');
const { SITE_ID_RE, realtimeError } = require('./event-hub');

const DEFAULT_CHANNEL_PREFIX = 'systemfabric:realtime:v1';
const CHANNEL_PREFIX_RE = /^[A-Za-z0-9:_-]{1,96}$/;
const EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRESENCE_PAYLOAD = Object.freeze({ kind: 'presence.refresh' });

function safeErrorCode(error) {
  return String(error?.code || 'ERR_REDIS_CONNECTION').slice(0, 100);
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
 * Redis Pub/Sub bridge for small, ephemeral presence invalidations.
 * PostgreSQL remains the durable event source; this bridge carries no user,
 * session, resource or presence-record data.
 */
async function createRedisRealtimeBridge({
  url,
  channelPrefix = DEFAULT_CHANNEL_PREFIX,
  maxMessageBytes = 4_096,
  maxInboundQueue = 1_024,
  onError = () => {},
  createClient: createClientOverride,
  now = Date.now
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
        return Math.min(100 * retries, 2_000);
      }
    }
  };
  const publisher = createClient(clientOptions);
  const subscriber = createClient(clientOptions);
  const instanceId = randomUUID();
  const pattern = channelPrefix + ':*:presence';
  let hub = null;
  let attached = false;
  let closed = false;
  let draining = false;
  const inbound = [];

  function reportError(error) {
    try { onError({ errorCode: safeErrorCode(error) }); } catch {}
  }

  publisher.on?.('error', reportError);
  subscriber.on?.('error', reportError);

  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
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

  async function drainInbound() {
    if (draining || closed) return;
    draining = true;
    try {
      while (inbound.length && !closed) {
        const message = inbound.shift();
        const event = validatePresenceEnvelope(message.message, message.siteId, maxMessageBytes);
        if (!event || event.publisherId === instanceId) continue;
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

  async function attach(targetHub) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_CLOSED', 'The Redis real-time bridge is closed.');
    if (!targetHub || typeof targetHub.publish !== 'function') {
      throw new TypeError('A local authorization-aware real-time hub is required.');
    }
    if (attached) {
      if (hub === targetHub) return;
      throw new Error('The Redis real-time bridge is already attached to another hub.');
    }
    hub = targetHub;
    try {
      await subscriber.pSubscribe(pattern, (message, channel) => {
        if (closed || typeof channel !== 'string' || typeof message !== 'string') return;
        const prefix = channelPrefix + ':';
        if (!channel.startsWith(prefix) || !channel.endsWith(':presence')) return;
        const siteId = channel.slice(prefix.length, -':presence'.length);
        if (!SITE_ID_RE.test(siteId)) return;
        if (inbound.length >= maxInboundQueue) {
          reportError({ code: 'ERR_REALTIME_INBOUND_QUEUE_FULL' });
          return;
        }
        inbound.push({ message, siteId: siteId.toLowerCase() });
        void drainInbound();
      });
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
    try {
      await publisher.publish(channelFor(envelope.siteId), serialized);
    } catch {
      throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_UNAVAILABLE', 'The Redis real-time bridge is unavailable.');
    }
    // The publisher does not receive its own Redis Pub/Sub message, so deliver
    // locally after the broker accepts the invalidation.
    return hub.publish({
      siteId: envelope.siteId,
      topic: envelope.topic,
      payload: envelope.payload,
      eventId: envelope.eventId,
      occurredAt: envelope.occurredAt
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    inbound.length = 0;
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
    close,
    get instanceId() { return instanceId; },
    get inboundQueueSize() { return inbound.length; },
    get isReady() { return attached && !closed; }
  });
}

module.exports = {
  DEFAULT_CHANNEL_PREFIX,
  createRedisRealtimeBridge,
  validatePresenceEnvelope
};
