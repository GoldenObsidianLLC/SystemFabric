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


const DOCUMENT_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DOCUMENT_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORIGIN_CONNECTION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function collaborationOperation(opId = 'ffffffff-ffff-4fff-8fff-ffffffffffff') {
  return {
    schemaVersion: 1,
    opId,
    clientId: 'redis-client-a',
    baseSequence: 0,
    type: 'document.set_title',
    payload: { title: 'Cross-instance title' }
  };
}

function documentEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    publisherId: USER_A,
    eventId: USER_B,
    siteId: SITE_A,
    contentId: DOCUMENT_A,
    topic: 'document',
    occurredAt: new Date().toISOString(),
    payload: {
      kind: 'document.operation',
      sequence: 1,
      originConnectionId: ORIGIN_CONNECTION,
      operation: collaborationOperation()
    },
    ...overrides
  };
}

test('Redis document envelope validation enforces channel scope and the F1.9 operation schema', () => {
  const valid = JSON.stringify(documentEnvelope());
  const { validateDocumentEnvelope } = require('../packages/realtime/src/redis-realtime');

  const decoded = validateDocumentEnvelope(valid, SITE_A, DOCUMENT_A, 16_384);
  assert.equal(decoded.siteId, SITE_A);
  assert.equal(decoded.contentId, DOCUMENT_A);
  assert.equal(decoded.topic, 'document');
  assert.equal(decoded.payload.sequence, 1);
  assert.equal(decoded.payload.operation.payload.title, 'Cross-instance title');
  assert.equal(decoded.payload.originConnectionId, ORIGIN_CONNECTION);

  assert.equal(validateDocumentEnvelope(valid, SITE_B, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(valid, SITE_A, DOCUMENT_B, 16_384), null);
  assert.equal(validateDocumentEnvelope(JSON.stringify(documentEnvelope({ contentId: DOCUMENT_B })), SITE_A, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(JSON.stringify({ ...documentEnvelope(), extra: true }), SITE_A, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(JSON.stringify(documentEnvelope({
    payload: { ...documentEnvelope().payload, extra: 'forbidden' }
  })), SITE_A, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(JSON.stringify(documentEnvelope({
    payload: { ...documentEnvelope().payload, sequence: 0 }
  })), SITE_A, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(JSON.stringify(documentEnvelope({
    payload: { ...documentEnvelope().payload, originConnectionId: 'not-a-uuid' }
  })), SITE_A, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(JSON.stringify(documentEnvelope({
    payload: { ...documentEnvelope().payload, operation: { ...collaborationOperation(), type: 'document.patch' } }
  })), SITE_A, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(JSON.stringify(documentEnvelope({ occurredAt: 'not-a-timestamp' })), SITE_A, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(JSON.stringify(documentEnvelope({ eventId: 'not-a-uuid' })), SITE_A, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(JSON.stringify(documentEnvelope({
    payload: {
      ...documentEnvelope().payload,
      operation: {
        schemaVersion: 1,
        opId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        clientId: 'redis-client-a',
        baseSequence: 0,
        type: 'text.insert',
        payload: { nodeId: 'text-1', key: 'text', offset: 0, text: 'x'.repeat(13_000) }
      }
    }
  })), SITE_A, DOCUMENT_A, 16_384), null);
  assert.equal(validateDocumentEnvelope(valid, SITE_A, DOCUMENT_A, 32), null);
  assert.equal(validateDocumentEnvelope('{not-json', SITE_A, DOCUMENT_A, 16_384), null);
});

test('Redis document channel fans out only to the matching site and document across independent hubs', async t => {
  const broker = new FakeRedisBroker();
  const bridgeA = await createRedisRealtimeBridge({
    url: REDIS_URL,
    createClient: () => broker.createClient()
  });
  const bridgeB = await createRedisRealtimeBridge({
    url: REDIS_URL,
    createClient: () => broker.createClient()
  });
  const hubA = createRealtimeHub({ authorizeSubscribe: async () => true });
  const hubB = createRealtimeHub({ authorizeSubscribe: async () => true });
  await Promise.all([bridgeA.attach(hubA), bridgeB.attach(hubB)]);
  t.after(async () => {
    hubA.close();
    hubB.close();
    await Promise.all([bridgeA.close(), bridgeB.close()]);
  });

  const local = await hubA.subscribe({ principal: { id: USER_A }, siteId: SITE_A, topic: 'document:' + DOCUMENT_A });
  const remoteSameDocument = await hubB.subscribe({ principal: { id: USER_B }, siteId: SITE_A, topic: 'document:' + DOCUMENT_A });
  const remoteOtherDocument = await hubB.subscribe({ principal: { id: USER_B }, siteId: SITE_A, topic: 'document:' + DOCUMENT_B });
  const remoteOtherSite = await hubB.subscribe({ principal: { id: USER_B }, siteId: SITE_B, topic: 'document:' + DOCUMENT_A });
  const localIterator = local.events[Symbol.asyncIterator]();
  const remoteIterator = remoteSameDocument.events[Symbol.asyncIterator]();
  const otherDocumentIterator = remoteOtherDocument.events[Symbol.asyncIterator]();
  const otherSiteIterator = remoteOtherSite.events[Symbol.asyncIterator]();

  const published = await bridgeA.publishDocumentOperation({
    siteId: SITE_A,
    contentId: DOCUMENT_A,
    sequence: 1,
    originConnectionId: ORIGIN_CONNECTION,
    operation: collaborationOperation()
  });
  assert.equal(published.delivered, 1);
  assert.equal(published.relayPublished, true);
  assert.equal(published.degraded, false);

  const [localEvent, remoteEvent] = await Promise.all([
    waitForEvent(localIterator),
    waitForEvent(remoteIterator)
  ]);
  assert.equal(localEvent.value.payload.kind, 'document.operation');
  assert.equal(localEvent.value.payload.sequence, 1);
  assert.equal(localEvent.value.payload.originConnectionId, ORIGIN_CONNECTION);
  assert.equal(remoteEvent.value.siteId, SITE_A);
  assert.equal(remoteEvent.value.topic, 'document:' + DOCUMENT_A);
  assert.equal(remoteEvent.value.payload.operation.payload.title, 'Cross-instance title');

  const noSecondLocalEcho = await Promise.race([
    localIterator.next().then(() => 'duplicate'),
    new Promise(resolve => setTimeout(() => resolve('quiet'), 50))
  ]);
  assert.equal(noSecondLocalEcho, 'quiet', 'the publisher must not receive its own Redis relay a second time');

  const [crossDocument, crossSite] = await Promise.all([
    Promise.race([otherDocumentIterator.next().then(() => 'unexpected'), new Promise(resolve => setTimeout(() => resolve('quiet'), 50))]),
    Promise.race([otherSiteIterator.next().then(() => 'unexpected'), new Promise(resolve => setTimeout(() => resolve('quiet'), 50))])
  ]);
  assert.equal(crossDocument, 'quiet');
  assert.equal(crossSite, 'quiet');
});

test('Redis document publish is local-first and reports remote relay degradation', async t => {
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
    topic: 'document:' + DOCUMENT_A
  });
  const iterator = subscription.events[Symbol.asyncIterator]();
  broker.failPublishes = true;

  const result = await bridge.publishDocumentOperation({
    siteId: SITE_A,
    contentId: DOCUMENT_A,
    sequence: 1,
    originConnectionId: null,
    operation: collaborationOperation()
  });

  assert.equal(result.delivered, 1);
  assert.equal(result.relayPublished, false);
  assert.equal(result.degraded, true);
  const event = await waitForEvent(iterator);
  assert.equal(event.value.payload.sequence, 1);
  assert.equal(metrics.snapshot().counters.redis_document_publish_failures_total, 1);
  assert.equal(metrics.snapshot().gauges.redis_document_inbound_queue_size, 0);
});


test('Redis document queue saturation does not delay authorization invalidation', async t => {
  const broker = new FakeRedisBroker();
  const bridgeA = await createRedisRealtimeBridge({
    url: REDIS_URL,
    channelPrefix: 'systemfabric:test:isolation',
    createClient: () => broker.createClient()
  });
  const metricsB = createRealtimeMetrics();
  const bridgeB = await createRedisRealtimeBridge({
    url: REDIS_URL,
    channelPrefix: 'systemfabric:test:isolation',
    maxDocumentInboundQueue: 1,
    createClient: () => broker.createClient(),
    metrics: metricsB
  });
  let reauthorizeBlocked = false;
  let gateEntered = false;
  let releaseGate;
  let signalGateEntered;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const gateEnteredPromise = new Promise(resolve => { signalGateEntered = resolve; });
  const hubA = createRealtimeHub({ authorizeSubscribe: async () => true });
  const hubB = createRealtimeHub({
    authorizeSubscribe: async () => {
      if (reauthorizeBlocked && !gateEntered) {
        gateEntered = true;
        signalGateEntered();
        await gate;
      }
      return true;
    }
  });
  await Promise.all([bridgeA.attach(hubA), bridgeB.attach(hubB)]);
  t.after(async () => {
    releaseGate();
    hubA.close();
    hubB.close();
    await Promise.all([bridgeA.close(), bridgeB.close()]);
  });

  await hubB.subscribe({
    principal: { id: USER_A },
    sessionId: SESSION_A1,
    siteId: SITE_A,
    topic: 'document:' + DOCUMENT_A
  });
  reauthorizeBlocked = true;

  await bridgeA.publishDocumentOperation({
    siteId: SITE_A,
    contentId: DOCUMENT_A,
    sequence: 1,
    originConnectionId: null,
    operation: collaborationOperation('11111111-1111-4111-8111-111111111111')
  });
  await gateEnteredPromise;

  await bridgeA.publishDocumentOperation({
    siteId: SITE_A,
    contentId: DOCUMENT_A,
    sequence: 2,
    originConnectionId: null,
    operation: collaborationOperation('22222222-2222-4222-8222-222222222222')
  });
  await bridgeA.publishDocumentOperation({
    siteId: SITE_A,
    contentId: DOCUMENT_A,
    sequence: 3,
    originConnectionId: null,
    operation: collaborationOperation('33333333-3333-4333-8333-333333333333')
  });

  for (let attempt = 0; attempt < 50 && metricsB.snapshot().counters.redis_document_inbound_queue_overflows_total === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(bridgeB.documentInboundQueueSize, 1);
  assert.equal(metricsB.snapshot().counters.redis_document_inbound_queue_overflows_total, 1);

  await bridgeA.invalidateAuthorization({ sessionId: SESSION_A1 });
  for (let attempt = 0; attempt < 50 && hubB.subscriberCount !== 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(hubB.subscriberCount, 0, 'authorization invalidation uses its own ingress queue and is not blocked by document processing');

  releaseGate();
});
