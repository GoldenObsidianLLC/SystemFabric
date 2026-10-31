'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRedisRealtimeBridge,
  validatePresenceEnvelope,
  validateAuthorizationEnvelope,
  DEFAULT_CHANNEL_PREFIX
} = require('../packages/realtime/src/redis-realtime');
const { createRealtimeHub } = require('../packages/realtime/src/event-hub');
const { createRealtimeMetrics } = require('../packages/observability/src/metrics');

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_A1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESSION_A2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION_B1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SESSION_A3 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const REDIS_URL = 'redis://127.0.0.1:6379';

class FakeRedisBroker {
  constructor() { this.clients = []; this.failPublishes = false; }

  createClient() {
    const broker = this;
    const patterns = new Map();
    const handlers = new Map();
    const client = {
      isOpen: false,
      patterns,
      handlers,
      on(event, handler) {
        const list = handlers.get(event) || [];
        list.push(handler);
        handlers.set(event, list);
        return this;
      },
      async connect() { this.isOpen = true; },
      async pSubscribe(pattern, handler) {
        patterns.set(pattern, handler);
      },
      async publish(channel, message) {
        if (broker.failPublishes) throw Object.assign(new Error('Redis connection interrupted.'), { code: 'ECONNRESET' });
        let delivered = 0;
        for (const target of broker.clients) {
          for (const [pattern, handler] of target.patterns) {
            const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
            if (new RegExp('^' + escaped + '$').test(channel)) {
              queueMicrotask(() => handler(message, channel));
              delivered += 1;
            }
          }
        }
        return delivered;
      },
      async quit() { this.isOpen = false; },
      destroy() { this.isOpen = false; }
    };
    broker.clients.push(client);
    return client;
  }
}

function waitForEvent(iterator, timeoutMs = 1_000) {
  return Promise.race([
    iterator.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for Redis fan-out.')), timeoutMs))
  ]);
}

test('Redis realtime bridge fans site-scoped presence invalidations across independent hubs', async t => {
  const broker = new FakeRedisBroker();
  const options = {
    url: REDIS_URL,
    createClient: () => broker.createClient()
  };
  const metricsA = createRealtimeMetrics();
  const bridgeA = await createRedisRealtimeBridge({ ...options, metrics: metricsA });
  const metricsB = createRealtimeMetrics();
  const bridgeB = await createRedisRealtimeBridge({ ...options, metrics: metricsB });
  const hubA = createRealtimeHub({ authorizeSubscribe: async () => true });
  const hubB = createRealtimeHub({ authorizeSubscribe: async () => true });
  await Promise.all([bridgeA.attach(hubA), bridgeB.attach(hubB)]);
  t.after(async () => {
    hubA.close();
    hubB.close();
    await Promise.all([bridgeA.close(), bridgeB.close()]);
  });

  assert.equal(broker.clients.length, 4, 'each API bridge owns independent publisher and subscriber clients');
  const local = await hubA.subscribe({ principal: { id: 'user-a' }, siteId: SITE_A, topic: 'presence' });
  const remote = await hubB.subscribe({ principal: { id: 'user-b' }, siteId: SITE_A, topic: 'presence' });
  const otherSite = await hubB.subscribe({ principal: { id: 'user-c' }, siteId: SITE_B, topic: 'presence' });
  const localIterator = local.events[Symbol.asyncIterator]();
  const remoteIterator = remote.events[Symbol.asyncIterator]();
  const otherSiteIterator = otherSite.events[Symbol.asyncIterator]();

  const published = await bridgeA.publish({
    siteId: SITE_A,
    topic: 'presence',
    payload: { kind: 'presence.refresh' }
  });
  assert.equal(published.delivered, 1);
  const [localEvent, remoteEvent] = await Promise.all([
    waitForEvent(localIterator),
    waitForEvent(remoteIterator)
  ]);
  assert.equal(localEvent.value.payload.kind, 'presence.refresh');
  assert.equal(remoteEvent.value.payload.kind, 'presence.refresh');
  assert.equal(remoteEvent.value.siteId, SITE_A);
  assert.equal(remoteEvent.value.topic, 'presence');
  assert.equal(metricsA.snapshot().counters.redis_pubsub_publishes_total, 1);
  assert.equal(metricsB.snapshot().counters.redis_pubsub_messages_total, 1);
  assert.equal(metricsB.snapshot().gauges.redis_inbound_queue_size, 0);

  const noCrossSiteDelivery = await Promise.race([
    otherSiteIterator.next().then(() => 'unexpected-event'),
    new Promise(resolve => setTimeout(() => resolve('quiet'), 75))
  ]);
  assert.equal(noCrossSiteDelivery, 'quiet');
  local.close();
  remote.close();
  otherSite.close();
});

test('Redis realtime bridge propagates site-scoped authorization invalidation across instances', async t => {
  const broker = new FakeRedisBroker();
  const options = { url: REDIS_URL, createClient: () => broker.createClient() };
  const bridgeA = await createRedisRealtimeBridge(options);
  const metricsB = createRealtimeMetrics();
  const bridgeB = await createRedisRealtimeBridge({ ...options, metrics: metricsB });
  const hubA = createRealtimeHub({ authorizeSubscribe: async () => true });
  const hubB = createRealtimeHub({ authorizeSubscribe: async () => true });
  await Promise.all([bridgeA.attach(hubA), bridgeB.attach(hubB)]);
  t.after(async () => { hubA.close(); hubB.close(); await Promise.all([bridgeA.close(), bridgeB.close()]); });

  await hubA.subscribe({ principal: { id: USER_A }, sessionId: SESSION_A1, siteId: SITE_A, topic: 'presence' });
  await hubB.subscribe({ principal: { id: USER_A }, sessionId: SESSION_A2, siteId: SITE_A, topic: 'presence' });
  await hubB.subscribe({ principal: { id: USER_A }, sessionId: SESSION_B1, siteId: SITE_B, topic: 'presence' });
  await hubB.subscribe({ principal: { id: USER_B }, sessionId: SESSION_A3, siteId: SITE_A, topic: 'presence' });

  const local = await bridgeA.invalidateAuthorization({ siteId: SITE_A, principalId: USER_A });
  assert.equal(local.revoked, 1);
  for (let attempt = 0; attempt < 20 && hubB.subscriberCount !== 2; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(hubA.subscriberCount, 0);
  assert.equal(hubB.subscriberCount, 2, 'only the matching site and principal are revoked on the remote instance');
  assert.equal(metricsB.snapshot().counters.redis_pubsub_messages_total, 1);
  assert.equal(metricsB.snapshot().gauges.redis_inbound_queue_size, 0);
});

test('Redis realtime bridge rejects payloads that could expose presence records or identities', async t => {
  const broker = new FakeRedisBroker();
  const bridge = await createRedisRealtimeBridge({
    url: REDIS_URL,
    createClient: () => broker.createClient()
  });
  const hub = createRealtimeHub({ authorizeSubscribe: async () => true });
  await bridge.attach(hub);
  t.after(async () => { hub.close(); await bridge.close(); });

  await assert.rejects(
    bridge.publish({ siteId: SITE_A, topic: 'presence', payload: { kind: 'presence.refresh', principalId: 'user-a' } }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_PAYLOAD_INVALID'
  );
  await assert.rejects(
    bridge.publish({ siteId: SITE_A, topic: 'content', payload: { kind: 'presence.refresh' } }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_SCOPE_INVALID'
  );
  await assert.rejects(
    bridge.publish({ siteId: SITE_A, topic: 'presence', payload: { kind: 'presence.refresh' }, eventId: 'not-a-uuid' }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_EVENT_ID_INVALID'
  );
  await assert.rejects(
    bridge.invalidateAuthorization({ principalId: 'local-developer' }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_INVALIDATION_SCOPE'
  );
});

test('Redis realtime envelope validation enforces channel site, UUID identity and exact invalidation shape', () => {
  const valid = {
    schemaVersion: 1,
    publisherId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    siteId: SITE_A,
    topic: 'presence',
    occurredAt: new Date().toISOString(),
    payload: { kind: 'presence.refresh' }
  };
  assert.equal(validatePresenceEnvelope(JSON.stringify(valid), SITE_A, 4096).siteId, SITE_A);
  assert.equal(validatePresenceEnvelope(JSON.stringify(valid), SITE_B, 4096), null);
  assert.equal(validatePresenceEnvelope(JSON.stringify({ ...valid, payload: { kind: 'presence.refresh', userId: 'secret' } }), SITE_A, 4096), null);
  assert.equal(validatePresenceEnvelope(JSON.stringify(valid), SITE_A, 32), null);

  const authorization = {
    schemaVersion: 1,
    publisherId: USER_B,
    eventId: SESSION_A3,
    occurredAt: new Date().toISOString(),
    payload: { kind: 'authorization.invalidate', siteId: SITE_A, principalId: USER_A }
  };
  assert.equal(validateAuthorizationEnvelope(JSON.stringify(authorization), 4096).payload.principalId, USER_A);
  assert.equal(validateAuthorizationEnvelope(JSON.stringify({ ...authorization, payload: { kind: 'authorization.invalidate' } }), 4096), null);
  assert.equal(validateAuthorizationEnvelope(JSON.stringify({ ...authorization, payload: { ...authorization.payload, sessionToken: 'secret' } }), 4096), null);
  assert.equal(validateAuthorizationEnvelope(JSON.stringify({ ...authorization, sessionToken: 'secret' }), 4096), null);
  assert.equal(DEFAULT_CHANNEL_PREFIX, 'systemfabric:realtime:v1');
});

test('presence invalidation still fans out locally when Redis publish is interrupted', async t => {
  const broker = new FakeRedisBroker();
  const metrics = createRealtimeMetrics();
  const bridge = await createRedisRealtimeBridge({
    url: REDIS_URL,
    createClient: () => broker.createClient(),
    metrics
  });
  const hub = createRealtimeHub({ authorizeSubscribe: async () => true });
  await bridge.attach(hub);
  t.after(async () => { hub.close(); await bridge.close(); });

  const subscription = await hub.subscribe({ principal: { id: 'user-a' }, siteId: SITE_A, topic: 'presence' });
  const iterator = subscription.events[Symbol.asyncIterator]();
  broker.failPublishes = true;

  const result = await bridge.publish({
    siteId: SITE_A,
    topic: 'presence',
    payload: { kind: 'presence.refresh' }
  });

  assert.equal(result.delivered, 1, 'the local hub receives the invalidation despite Redis failure');
  assert.equal(result.relayPublished, false);
  assert.equal(result.degraded, true);
  const event = await waitForEvent(iterator);
  assert.equal(event.value.payload.kind, 'presence.refresh');
  assert.equal(metrics.snapshot().counters.redis_publish_failures_total, 1);
  assert.equal(metrics.snapshot().gauges.redis_bridge_degraded, 1);
  assert.equal(metrics.snapshot().gauges.redis_bridge_ready, 0);
});

test('authorization invalidation remains effective locally when Redis relay is unavailable', async t => {
  const broker = new FakeRedisBroker();
  const metrics = createRealtimeMetrics();
  const bridge = await createRedisRealtimeBridge({
    url: REDIS_URL,
    createClient: () => broker.createClient(),
    metrics
  });
  const hub = createRealtimeHub({ authorizeSubscribe: async () => true });
  await bridge.attach(hub);
  t.after(async () => { hub.close(); await bridge.close(); });

  const subscription = await hub.subscribe({
    principal: { id: USER_A },
    siteId: SITE_A,
    topic: 'presence',
    sessionId: SESSION_A1
  });
  broker.failPublishes = true;

  await assert.rejects(
    bridge.invalidateAuthorization({ sessionId: SESSION_A1 }),
    error => error.statusCode === 503 && error.code === 'ERR_SYSTEMFABRIC_REALTIME_BRIDGE_UNAVAILABLE'
  );
  assert.equal(hub.subscriberCount, 0, 'local authorization is revoked before relay publication');
  assert.equal((await subscription.events[Symbol.asyncIterator]().next()).done, true);
  assert.equal(metrics.snapshot().gauges.redis_bridge_degraded, 1);
  assert.equal(metrics.snapshot().counters.fanout_failures_total, 1);
});
