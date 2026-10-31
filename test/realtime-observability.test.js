'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealtimeMetrics } = require('../packages/observability/src/metrics');
const { createRealtimeHub } = require('../packages/realtime/src/event-hub');
const { createMemoryPresenceAdapter, createPresenceService } = require('../packages/realtime/src/presence');
const { createApiServer } = require('../apps/api/src/server');

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const METRICS_TOKEN = 'observability-test-token-with-at-least-32-chars';

test('real-time metric registry is bounded, snapshots are isolated, and Prometheus output is valid', () => {
  const metrics = createRealtimeMetrics();
  metrics.increment('events_published_total', 2);
  metrics.setGauge('active_subscriptions', 3);
  metrics.observe('event_lag_milliseconds', 12);
  const snapshot = metrics.snapshot();

  assert.equal(snapshot.counters.events_published_total, 2);
  assert.equal(snapshot.gauges.active_subscriptions, 3);
  assert.equal(snapshot.histograms.event_lag_milliseconds.count, 1);
  assert.equal(snapshot.histograms.event_lag_milliseconds.sum, 12);
  assert.equal(snapshot.histograms.event_lag_milliseconds.bucketCounts[3], 1);
  assert.throws(() => { snapshot.histograms.event_lag_milliseconds.bucketCounts[3] = 0; }, TypeError);
  assert.throws(() => metrics.increment('unbounded_user_id_' + SITE_ID), /Unknown real-time counter/);
  assert.throws(() => metrics.setGauge('active_subscriptions', -1), /finite and non-negative/);

  const output = metrics.renderPrometheus();
  assert.match(output, /# TYPE systemfabric_realtime_events_published_total counter/);
  assert.match(output, /systemfabric_realtime_events_published_total 2/);
  assert.match(output, /systemfabric_realtime_event_lag_milliseconds_bucket\{le="25"\} 1/);
  assert.match(output, /systemfabric_realtime_active_subscriptions 3/);
  assert.ok(output.endsWith('\n'));
  assert.doesNotMatch(output, new RegExp(SITE_ID));
});

test('event hub records subscription, authorization, fan-out, lag, delivery and queue overflow metrics', async () => {
  const metrics = createRealtimeMetrics();
  let allowed = true;
  const hub = createRealtimeHub({
    authorizeSubscribe: async () => allowed,
    maxQueueSize: 1,
    metrics
  });

  const subscription = await hub.subscribe({
    principal: { id: 'user-a' },
    siteId: SITE_ID,
    topic: 'presence'
  });
  assert.equal(metrics.snapshot().gauges.active_subscriptions, 1);

  const occurredAt = new Date(Date.now() - 25).toISOString();
  await hub.publish({ siteId: SITE_ID, topic: 'presence', payload: { sequence: 1 }, occurredAt });
  await hub.publish({ siteId: SITE_ID, topic: 'presence', payload: { sequence: 2 }, occurredAt });
  assert.equal(hub.subscriberCount, 0);

  allowed = false;
  await assert.rejects(
    hub.subscribe({ principal: { id: 'user-b' }, siteId: SITE_ID, topic: 'presence' }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_FORBIDDEN'
  );

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.subscriptions_opened_total, 1);
  assert.equal(snapshot.counters.subscriptions_closed_total, 1);
  assert.equal(snapshot.counters.events_published_total, 2);
  assert.equal(snapshot.counters.events_delivered_total, 1);
  assert.equal(snapshot.counters.queue_overflows_total, 1);
  assert.equal(snapshot.counters.authorization_denials_total, 1);
  assert.equal(snapshot.gauges.active_subscriptions, 0);
  assert.equal(snapshot.histograms.fanout_targets_per_event.count, 2);
  assert.ok(snapshot.histograms.event_lag_milliseconds.sum >= 0);
  hub.close();
});

test('presence service records heartbeat, leave, active lease gauge and snapshot size', async () => {
  const metrics = createRealtimeMetrics();
  const adapter = createMemoryPresenceAdapter({ metrics, maxEntries: 10 });
  const presence = createPresenceService({ adapter, metrics, leaseMs: 5_000 });

  await presence.heartbeat({ siteId: SITE_ID, principalId: 'user-a', sessionId: 'session-a' });
  await presence.list({ siteId: SITE_ID, viewerId: 'user-a' });
  assert.equal(metrics.snapshot().gauges.presence_memory_active_leases, 1);
  await presence.leave({ siteId: SITE_ID, principalId: 'user-a', sessionId: 'session-a' });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.presence_heartbeats_total, 1);
  assert.equal(snapshot.counters.presence_leaves_total, 1);
  assert.equal(snapshot.gauges.presence_memory_active_leases, 0);
  assert.equal(snapshot.histograms.presence_snapshot_lease_count.count, 1);
  assert.equal(snapshot.histograms.presence_snapshot_lease_count.sum, 1);
  await presence.close();
});

test('API serves realtime metrics only through the existing bearer-protected metrics route', async t => {
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_API_TOKEN: 'developer-test-token',
      SYSTEMFABRIC_DEFAULT_SITE_ID: SITE_ID,
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      SYSTEMFABRIC_METRICS_ENABLED: 'true',
      SYSTEMFABRIC_METRICS_TOKEN: METRICS_TOKEN,
      AI_PROVIDER: 'mock',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await server.systemfabric.close();
  });

  const base = 'http://127.0.0.1:' + server.address().port;
  const heartbeat = await fetch(base + '/api/v1/sites/' + SITE_ID + '/presence/heartbeat', {
    method: 'POST',
    headers: {
      authorization: 'Bearer developer-test-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ availability: 'active' })
  });
  assert.equal(heartbeat.status, 200);

  const controller = new AbortController();
  const stream = await fetch(base + '/api/v1/sites/' + SITE_ID + '/realtime/events?topic=presence', {
    headers: { authorization: 'Bearer developer-test-token' },
    signal: controller.signal
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const connected = await reader.read();
  assert.match(new TextDecoder().decode(connected.value), /connected/);
  assert.equal(server.systemfabric.realtimeMetrics.gauges.active_sse_connections, 1);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let attempt = 0; attempt < 20 && server.systemfabric.realtimeMetrics.gauges.active_sse_connections !== 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(server.systemfabric.realtimeMetrics.gauges.active_sse_connections, 0);

  const unauthorized = await fetch(base + '/metrics');
  assert.equal(unauthorized.status, 401);

  const response = await fetch(base + '/metrics', {
    headers: { authorization: 'Bearer ' + METRICS_TOKEN }
  });
  assert.equal(response.status, 200);
  const output = await response.text();
  assert.match(output, /systemfabric_realtime_presence_heartbeats_total 1/);
  assert.match(output, /systemfabric_realtime_events_published_total 1/);
  assert.match(output, /systemfabric_realtime_sse_connections_opened_total 1/);
  assert.match(output, /systemfabric_realtime_sse_connections_closed_total 1/);
  assert.match(output, /systemfabric_http_requests_total/);
});
