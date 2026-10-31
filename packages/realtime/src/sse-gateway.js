'use strict';

const { realtimeError } = require('./event-hub');

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
function createSseGateway({ hub, heartbeatMs = 15_000, metrics = null } = {}) {
  if (!hub || typeof hub.subscribe !== 'function') {
    throw new TypeError('A real-time hub is required.');
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 5_000 || heartbeatMs > 60_000) {
    throw new RangeError('heartbeatMs must be between 5000 and 60000.');
  }

  let activeConnections = 0;

  function incrementMetric(name, amount = 1) {
    try { metrics?.increment?.(name, amount); } catch {}
  }
  function setActiveGauge() {
    try { metrics?.setGauge?.('active_sse_connections', activeConnections); } catch {}
  }

  async function handle(req, res, { principal, siteId, topic = 'presence', sessionId = null, expiresAt = null }) {
    const subscription = await hub.subscribe({ principal, siteId, topic, sessionId, expiresAt });
    activeConnections += 1;
    incrementMetric('sse_connections_opened_total');
    setActiveGauge();
    let closed = false;
    let blocked = false;
    let heartbeat = null;

    const onDrain = () => { blocked = false; };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      activeConnections = Math.max(0, activeConnections - 1);
      incrementMetric('sse_connections_closed_total');
      setActiveGauge();
      res.removeListener('drain', onDrain);
      req.removeListener('aborted', cleanup);
      res.removeListener('close', cleanup);
      subscription.close();
    };

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
    res.write(': connected\n\n');

    let reauthorizing = false;
    heartbeat = setInterval(async () => {
      if (closed || res.destroyed || res.writableEnded) return;
      if (typeof hub.reauthorize === 'function') {
        if (reauthorizing) return;
        reauthorizing = true;
        try {
          if (!(await hub.reauthorize(subscription))) return;
        } catch {
          subscription.close();
          return;
        } finally {
          reauthorizing = false;
        }
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
      // Do not expose authorization, payload or internal delivery details over SSE.
      if (!closed && !res.destroyed && !res.writableEnded) {
        incrementMetric('sse_reconnect_required_total');
        res.write('event: reconnect-required\ndata: {"reason":"stream-unavailable"}\n\n');
      }
    } finally {
      cleanup();
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }

  return Object.freeze({ handle });
}

module.exports = { createSseGateway };
