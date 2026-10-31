'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { realtimeError } = require('./event-hub');
const { createConnectionReadyPayload } = require('./realtime-protocol');

const MAX_MESSAGE_BYTES = 4_096;
const MAX_BUFFERED_BYTES = 1_048_576;
const MAX_MESSAGES_PER_MINUTE = 60;
const ALLOWED_AVAILABILITY = new Set(['active', 'idle', 'away', 'hidden']);

function incrementMetric(metrics, name, amount = 1) {
  try { metrics?.increment?.(name, amount); } catch {}
}
function setGauge(metrics, name, value) {
  try { metrics?.setGauge?.(name, value); } catch {}
}
function observeMetric(metrics, name, value) {
  try { metrics?.observe?.(name, value); } catch {}
}

function createWebSocketGateway({
  hub,
  presence,
  connectionLimiter = null,
  publishPresence = null,
  heartbeatMs = 15_000,
  maxMessageBytes = MAX_MESSAGE_BYTES,
  maxBufferedBytes = MAX_BUFFERED_BYTES,
  maxMessagesPerMinute = MAX_MESSAGES_PER_MINUTE,
  now = Date.now,
  metrics = null
} = {}) {
  if (!hub || typeof hub.subscribe !== 'function' || typeof hub.reauthorize !== 'function') {
    throw new TypeError('A real-time hub with subscription and reauthorization support is required.');
  }
  if (!presence || typeof presence.heartbeat !== 'function' || typeof presence.leave !== 'function') {
    throw new TypeError('A presence service with heartbeat and leave support is required.');
  }
  if (connectionLimiter && typeof connectionLimiter.acquire !== 'function') {
    throw new TypeError('connectionLimiter must expose acquire().');
  }
  if (publishPresence !== null && typeof publishPresence !== 'function') {
    throw new TypeError('publishPresence must be a function when provided.');
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 5_000 || heartbeatMs > 60_000) {
    throw new RangeError('heartbeatMs must be between 5000 and 60000.');
  }
  if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 256 || maxMessageBytes > 65_536) {
    throw new RangeError('maxMessageBytes must be between 256 and 65536.');
  }
  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < 16_384 || maxBufferedBytes > 16 * 1024 * 1024) {
    throw new RangeError('maxBufferedBytes must be between 16384 and 16777216.');
  }
  if (!Number.isInteger(maxMessagesPerMinute) || maxMessagesPerMinute < 1 || maxMessagesPerMinute > 600) {
    throw new RangeError('maxMessagesPerMinute must be between 1 and 600.');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: maxMessageBytes,
    perMessageDeflate: false,
    skipUTF8Validation: false
  });
  const clients = new Set();
  const cleanups = new Map();
  let closed = false;
  const readyMessage = JSON.stringify(createConnectionReadyPayload({ heartbeatMs }));

  async function handleUpgrade(req, socket, head, context) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_CLOSED', 'The real-time gateway is shutting down.');
    const { principal, siteId, topic = 'presence', principalId, sessionId, expiresAt = null } = context || {};
    if (topic !== 'presence') {
      throw realtimeError(403, 'ERR_SYSTEMFABRIC_REALTIME_TOPIC_FORBIDDEN', 'This WebSocket preview only supports the presence topic.');
    }
    if (!principal || typeof principal.id !== 'string' || principal.id !== principalId ||
        typeof principalId !== 'string' || !principalId.trim() ||
        typeof sessionId !== 'string' || !sessionId.trim()) {
      throw realtimeError(401, 'ERR_SYSTEMFABRIC_REALTIME_PRINCIPAL_REQUIRED', 'A server-authenticated principal and session are required for WebSocket connections.');
    }
    let lease = null;
    let subscription = null;
    const openedAt = now();

    try {
      if (connectionLimiter) lease = await connectionLimiter.acquire({ siteId, principalId });
      subscription = await hub.subscribe({ principal, siteId, topic, sessionId, expiresAt });
    } catch (error) {
      if (lease) await lease.release().catch(() => {});
      throw error;
    }

    return new Promise((resolve, reject) => {
      let upgraded = false;
      try {
        wss.handleUpgrade(req, socket, head, ws => {
          upgraded = true;
          wss.emit('connection', ws, req);
          clients.add(ws);
          incrementMetric(metrics, 'websocket_connections_opened_total');
          setGauge(metrics, 'active_websocket_connections', clients.size);
          let cleaned = false;
          let cleanupPromise = null;
          let alive = true;
          let timer = null;
          const messageTimes = [];
          let processingMessages = Promise.resolve();

          const cleanup = () => {
            if (cleanupPromise) return cleanupPromise;
            cleaned = true;
            cleanupPromise = (async () => {
              if (timer) clearInterval(timer);
              clients.delete(ws);
              subscription.close();
              if (lease) await lease.release().catch(() => {});
              cleanups.delete(ws);
              incrementMetric(metrics, 'websocket_connections_closed_total');
              observeMetric(metrics, 'realtime_connection_duration_milliseconds', Math.max(0, now() - openedAt));
              setGauge(metrics, 'active_websocket_connections', clients.size);
            })();
            return cleanupPromise;
          };
          cleanups.set(ws, cleanup);

          function close(code, reason) {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              try { ws.close(code, reason); } catch { ws.terminate(); }
            }
          }

          function send(value) {
            if (ws.readyState !== WebSocket.OPEN) return false;
            if (ws.bufferedAmount > maxBufferedBytes) {
              incrementMetric(metrics, 'websocket_backpressure_closes_total');
              incrementMetric(metrics, 'websocket_reconnect_required_total');
              close(1013, 'reconnect-required');
              return false;
            }
            try {
              ws.send(JSON.stringify(value), error => {
                if (error) {
                  incrementMetric(metrics, 'websocket_reconnect_required_total');
                  close(1013, 'transport-unavailable');
                }
              });
              return true;
            } catch {
              close(1013, 'transport-unavailable');
              return false;
            }
          }

          send(JSON.parse(readyMessage));

          ws.on('pong', () => { alive = true; });
          ws.on('close', () => { void cleanup(); });
          ws.on('error', () => { void cleanup(); });
          const processMessage = async (data, isBinary) => {
            if (cleaned || ws.readyState !== WebSocket.OPEN) return;
            incrementMetric(metrics, 'websocket_messages_received_total');
            if (isBinary || data.byteLength > maxMessageBytes) {
              incrementMetric(metrics, 'websocket_message_rejections_total');
              close(1008, 'invalid-message');
              return;
            }
            const timestamp = now();
            while (messageTimes.length && messageTimes[0] <= timestamp - 60_000) messageTimes.shift();
            if (messageTimes.length >= maxMessagesPerMinute) {
              incrementMetric(metrics, 'websocket_message_rejections_total');
              close(1008, 'message-rate-exceeded');
              return;
            }
            messageTimes.push(timestamp);

            let command;
            try { command = JSON.parse(data.toString()); } catch {
              incrementMetric(metrics, 'websocket_message_rejections_total');
              close(1008, 'invalid-message');
              return;
            }
            if (!command || typeof command !== 'object' || Array.isArray(command) ||
                Object.getPrototypeOf(command) !== Object.prototype ||
                typeof command.type !== 'string') {
              incrementMetric(metrics, 'websocket_message_rejections_total');
              close(1008, 'invalid-message');
              return;
            }

            try {
              if (!(await hub.reauthorize(subscription))) {
                close(1008, 'authorization-expired');
                return;
              }
              if (command.type === 'ping' && Object.keys(command).length === 1) {
                send({ type: 'pong', at: new Date(timestamp).toISOString() });
                return;
              }
              if (command.type === 'presence.heartbeat' &&
                  Object.keys(command).every(key => ['type', 'availability'].includes(key)) &&
                  (command.availability === undefined || ALLOWED_AVAILABILITY.has(command.availability))) {
                await presence.heartbeat({
                  siteId,
                  principalId,
                  sessionId,
                  availability: command.availability || 'active'
                });
                const relay = publishPresence
                  ? await publishPresence({ siteId, topic: 'presence', payload: { kind: 'presence.refresh' } })
                  : await hub.publish({ siteId, topic: 'presence', payload: { kind: 'presence.refresh' } });
                send({ type: 'presence.heartbeat.ack', accepted: true, relayDegraded: relay?.degraded === true });
                return;
              }
              if (command.type === 'presence.leave' && Object.keys(command).length === 1) {
                await presence.leave({ siteId, principalId, sessionId });
                const relay = publishPresence
                  ? await publishPresence({ siteId, topic: 'presence', payload: { kind: 'presence.refresh' } })
                  : await hub.publish({ siteId, topic: 'presence', payload: { kind: 'presence.refresh' } });
                send({ type: 'presence.leave.ack', accepted: true, relayDegraded: relay?.degraded === true });
                return;
              }
              incrementMetric(metrics, 'websocket_message_rejections_total');
              close(1008, 'unsupported-command');
            } catch (error) {
              if (error?.code === 'ERR_SYSTEMFABRIC_REALTIME_FORBIDDEN' ||
                  error?.code === 'ERR_SYSTEMFABRIC_REALTIME_SESSION_EXPIRED') {
                close(1008, 'authorization-expired');
              } else {
                send({ type: 'error', code: 'command-unavailable' });
              }
            }
          };
          ws.on('message', (data, isBinary) => {
            processingMessages = processingMessages
              .then(() => processMessage(data, isBinary))
              .catch(() => {
                incrementMetric(metrics, 'websocket_reconnect_required_total');
                close(1013, 'command-processing-unavailable');
              });
          });

          timer = setInterval(async () => {
            if (cleaned || ws.readyState !== WebSocket.OPEN) return;
            if (!alive) {
              incrementMetric(metrics, 'websocket_reconnect_required_total');
              close(1013, 'heartbeat-timeout');
              return;
            }
            alive = false;
            try {
              if (!(await hub.reauthorize(subscription))) {
                close(1008, 'authorization-expired');
                return;
              }
              if (lease && !(await lease.renew())) {
                incrementMetric(metrics, 'websocket_reconnect_required_total');
                close(1013, 'connection-lease-expired');
                return;
              }
              ws.ping();
              incrementMetric(metrics, 'websocket_pings_sent_total');
            } catch {
              incrementMetric(metrics, 'websocket_reconnect_required_total');
              close(1013, 'connection-unavailable');
            }
          }, heartbeatMs);
          timer.unref?.();

          void (async () => {
            try {
              for await (const event of subscription.events) {
                if (cleaned || ws.readyState !== WebSocket.OPEN) break;
                if (ws.bufferedAmount > maxBufferedBytes) {
                  incrementMetric(metrics, 'websocket_backpressure_closes_total');
                  incrementMetric(metrics, 'websocket_reconnect_required_total');
                  close(1013, 'reconnect-required');
                  break;
                }
                send({ type: 'event', event });
              }
            } catch {
              incrementMetric(metrics, 'websocket_reconnect_required_total');
              send({ type: 'reconnect-required', recovery: 'snapshot-refresh' });
              close(1013, 'reconnect-required');
            } finally {
              if (!cleaned && ws.readyState === WebSocket.OPEN) close(1008, 'subscription-closed');
            }
          })();

          resolve();
        });
      } catch (error) {
        if (!upgraded) {
          subscription.close();
          if (lease) void lease.release().catch(() => {});
          reject(error);
        }
      }
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    const active = [...clients].map(ws => ({ ws, cleanup: cleanups.get(ws) }));
    for (const { ws } of active) {
      try { ws.close(1001, 'server-shutdown'); } catch { ws.terminate(); }
    }
    await Promise.all(active.map(({ cleanup }) => cleanup ? cleanup() : Promise.resolve()));
    for (const { ws } of active) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await new Promise(resolve => wss.close(() => resolve()));
  }

  return Object.freeze({
    handleUpgrade,
    close,
    get connectionCount() { return clients.size; }
  });
}

module.exports = {
  createWebSocketGateway,
  MAX_MESSAGE_BYTES,
  MAX_BUFFERED_BYTES,
  MAX_MESSAGES_PER_MINUTE
};
