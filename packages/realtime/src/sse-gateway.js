'use strict';

const { realtimeError } = require('./event-hub');
const { createConnectionReadyPayload } = require('./realtime-protocol');

function waitForDrainOrClose(response) {
  return new Promise(resolve => {
    const finish = canContinue => {
      response.removeListener('drain', onDrain);
      response.removeListener('close', onClose);
      response.removeListener('error', onError);
      resolve(canContinue);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    if (response.destroyed || response.writableEnded) finish(false);
  });
}

/**
 * Server-Sent Events transport for a site-scoped RealtimeHub subscription.
 * Authentication and site capability checks must be completed by the caller
 * before invoking handle().
 */
function createSseGateway({ hub, heartbeatMs = 15_000, metrics = null, connectionLimiter = null } = {}) {
  if (!hub || typeof hub.subscribe !== 'function') {
    throw new TypeError('A real-time hub is required.');
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 5_000 || heartbeatMs > 60_000) {
    throw new RangeError('heartbeatMs must be between 5000 and 60000.');
  }
  if (connectionLimiter && typeof connectionLimiter.acquire !== 'function') {
    throw new TypeError('connectionLimiter must expose acquire().');
  }

  let activeConnections = 0;
  let gatewayClosed = false;
  const connections = new Set();

  function incrementMetric(name, amount = 1) {
    try { metrics?.increment?.(name, amount); } catch {}
  }
  function setActiveGauge() {
    try { metrics?.setGauge?.('active_sse_connections', activeConnections); } catch {}
  }

  async function handle(req, res, { principal, siteId, topic = 'presence', sessionId = null, expiresAt = null }) {
    if (gatewayClosed) {
      throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_CLOSED', 'The SSE gateway is shutting down.');
    }
    const openedAt = Date.now();
    const lease = connectionLimiter
      ? await connectionLimiter.acquire({ siteId, principalId: principal?.id })
      : null;
    let subscription;
    try {
      subscription = await hub.subscribe({ principal, siteId, topic, sessionId, expiresAt });
    } catch (error) {
      if (lease) await lease.release().catch(() => {});
      throw error;
    }

    activeConnections += 1;
    incrementMetric('sse_connections_opened_total');
    setActiveGauge();
    let closed = false;
    let blocked = false;
    let heartbeat = null;
    let reauthorizing = false;
    let reconnectSignaled = false;
    let cleanupPromise = null;
    const connection = { res, subscription, cleanup: null };

    const onDrain = () => { blocked = false; };
    const cleanup = () => {
      if (cleanupPromise) return cleanupPromise;
      closed = true;
      cleanupPromise = (async () => {
        if (heartbeat) clearInterval(heartbeat);
        activeConnections = Math.max(0, activeConnections - 1);
        incrementMetric('sse_connections_closed_total');
        try { metrics?.observe?.('realtime_connection_duration_milliseconds', Math.max(0, Date.now() - openedAt)); } catch {}
        setActiveGauge();
        res.removeListener('drain', onDrain);
        req.removeListener('aborted', cleanup);
        res.removeListener('close', cleanup);
        subscription.close();
        if (lease) await lease.release().catch(() => {});
        connections.delete(connection);
      })();
      return cleanupPromise;
    };
    connection.cleanup = cleanup;
    connections.add(connection);

    req.once('aborted', cleanup);
    res.once('close', cleanup);
    res.on('drain', onDrain);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff'
    });
    res.flushHeaders?.();
    res.write(': connected\nretry: 3000\nevent: connection.ready\ndata: ' +
      JSON.stringify(createConnectionReadyPayload({ heartbeatMs })) + '\n\n');

    heartbeat = setInterval(async () => {
      if (closed || res.destroyed || res.writableEnded || reauthorizing) return;
      reauthorizing = true;
      try {
        if (lease && !(await lease.renew())) {
          incrementMetric('sse_reconnect_required_total');
          incrementMetric('realtime_reconnects_advised_total');
          reconnectSignaled = true;
          if (!blocked && !res.destroyed && !res.writableEnded) {
            res.write('event: reconnect-required\ndata: {"reason":"connection-lease-expired","recovery":"snapshot-refresh"}\n\n');
          }
          subscription.close(realtimeError(429, 'ERR_SYSTEMFABRIC_REALTIME_QUOTA_EXPIRED', 'The real-time connection lease expired.'));
          return;
        }
        if (typeof hub.reauthorize === 'function' && !(await hub.reauthorize(subscription))) {
          incrementMetric('sse_reconnect_required_total');
          incrementMetric('realtime_reconnects_advised_total');
          reconnectSignaled = true;
          if (!blocked && !res.destroyed && !res.writableEnded) {
            res.write('event: reconnect-required\ndata: {"reason":"authorization-changed","recovery":"snapshot-refresh"}\n\n');
          }
          return;
        }
      } catch {
        subscription.close(realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_UNAVAILABLE', 'The real-time connection requires recovery.'));
        return;
      } finally {
        reauthorizing = false;
      }
      if (!closed && !blocked && !res.destroyed && !res.writableEnded) {
        const writable = res.write(': heartbeat\n\n');
        incrementMetric('sse_heartbeats_total');
        if (!writable) {
          blocked = true;
          incrementMetric('sse_backpressure_waits_total');
        }
      }
    }, heartbeatMs);
    heartbeat.unref?.();

    try {
      for await (const event of subscription.events) {
        if (closed || res.destroyed || res.writableEnded) break;
        const frame = 'id: ' + event.eventId + '\nevent: ' + event.topic + '\ndata: ' + JSON.stringify(event) + '\n\n';
        if (blocked) {
          if (!(await waitForDrainOrClose(res))) break;
          blocked = false;
        }
        if (!res.write(frame)) {
          blocked = true;
          incrementMetric('sse_backpressure_waits_total');
          if (!(await waitForDrainOrClose(res))) break;
          blocked = false;
        }
      }
    } catch {
      if (!closed && !reconnectSignaled && !res.destroyed && !res.writableEnded) {
        incrementMetric('sse_reconnect_required_total');
        incrementMetric('realtime_reconnects_advised_total');
        res.write('event: reconnect-required\ndata: {"reason":"stream-unavailable","recovery":"snapshot-refresh"}\n\n');
      }
    } finally {
      await cleanup();
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }

  async function close() {
    if (gatewayClosed) return;
    gatewayClosed = true;
    const active = [...connections];
    for (const connection of active) {
      const res = connection.res;
      if (!res.destroyed && !res.writableEnded && !res.writableFinished) {
        try {
          incrementMetric('realtime_reconnects_advised_total');
          res.write('event: reconnect-required\ndata: {"reason":"server-shutdown","recovery":"snapshot-refresh"}\n\n');
        } catch {}
      }
    }
    await Promise.all(active.map(async connection => {
      await connection.cleanup();
      if (!connection.res.destroyed && !connection.res.writableEnded) connection.res.end();
    }));
  }

  return Object.freeze({
    handle,
    close,
    get connectionCount() { return activeConnections; }
  });
}

module.exports = { createSseGateway };
