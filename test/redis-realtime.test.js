'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRedisRealtimeBridge,
  validatePresenceEnvelope,
  DEFAULT_CHANNEL_PREFIX
} = require('../packages/realtime/src/redis-realtime');
const { createRealtimeHub } = require('../packages/realtime/src/event-hub');

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const REDIS_URL = 'redis://127.0.0.1:6379';

class FakeRedisBroker {
  constructor() { this.clients = []; }

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
  const bridgeA = await createRedisRealtimeBridge(options);
  const bridgeB = await createRedisRealtimeBridge(options);
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

  const noCrossSiteDelivery = await Promise.race([
    otherSiteIterator.next().then(() => 'unexpected-event'),
    new Promise(resolve => setTimeout(() => resolve('quiet'), 75))
  ]);
  assert.equal(noCrossSiteDelivery, 'quiet');
  local.close();
  remote.close();
  otherSite.close();
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
  assert.equal(DEFAULT_CHANNEL_PREFIX, 'systemfabric:realtime:v1');
});
