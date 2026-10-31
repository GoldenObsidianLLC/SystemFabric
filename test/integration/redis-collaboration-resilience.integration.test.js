'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');
const { createRealtimeHub } = require('../../packages/realtime/src/event-hub');
const { createRedisRealtimeBridge } = require('../../packages/realtime/src/redis-realtime');
const { createRealtimeMetrics } = require('../../packages/observability/src/metrics');

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const CONTENT_ID = '22222222-2222-4222-8222-222222222222';
const REDIS_URL = process.env.SYSTEMFABRIC_TEST_REDIS_URL || '';

function approvedRedisUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const url = new URL(raw);
    return ['redis:', 'rediss:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase()) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

const enabled = process.env.SYSTEMFABRIC_RUN_REDIS_INTEGRATION === 'true' && approvedRedisUrl(REDIS_URL);

function createHub(metrics = null, maxQueueSize = 64) {
  return createRealtimeHub({
    authorizeSubscribe: async ({ siteId, topic }) =>
      siteId === SITE_ID && topic === 'document:' + CONTENT_ID,
    maxQueueSize,
    metrics
  });
}

async function subscribe(hub, principalId) {
  return hub.subscribe({
    principal: { id: principalId },
    siteId: SITE_ID,
    topic: 'document:' + CONTENT_ID,
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 120_000).toISOString()
  });
}

function operation(sequence) {
  return {
    schemaVersion: 1,
    opId: randomUUID(),
    clientId: 'f1-11-resilience-load',
    baseSequence: sequence - 1,
    type: 'document.set_title',
    payload: { title: 'Resilience load operation ' + sequence }
  };
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(name + ' must be an integer between ' + min + ' and ' + max + '.');
  }
  return parsed;
}

test('real Redis document relay recovers after a transient publish interruption', {
  skip: !enabled,
  timeout: 30_000
}, async t => {
  const channelPrefix = 'systemfabric:test:f1-11-recovery:' + randomUUID();
  const hubA = createHub();
  const hubB = createHub();
  const metricsA = createRealtimeMetrics();
  let bridgeA;
  let bridgeB;
  let publisherIntercepted = false;
  let failNextPublish = true;

  const createFaultInjectingClient = options => {
    const client = createClient(options);
    if (!publisherIntercepted) {
      publisherIntercepted = true;
      const publish = client.publish.bind(client);
      client.publish = async (channel, message, ...args) => {
        if (failNextPublish && channel.includes(':document:')) {
          failNextPublish = false;
          const error = new Error('Injected one-shot Redis publish interruption');
          error.code = 'ERR_TEST_TRANSIENT_PUBLISH';
          throw error;
        }
        return publish(channel, message, ...args);
      };
    }
    return client;
  };

  const local = await subscribe(hubA, 'f1-11-local-recovery');
  const remote = await subscribe(hubB, 'f1-11-remote-recovery');
  const localIterator = local.events[Symbol.asyncIterator]();
  const remoteIterator = remote.events[Symbol.asyncIterator]();

  t.after(async () => {
    local.close();
    remote.close();
    hubA.close();
    hubB.close();
    await Promise.allSettled([bridgeA?.close(), bridgeB?.close()]);
  });

  bridgeA = await createRedisRealtimeBridge({
    url: REDIS_URL,
    channelPrefix,
    createClient: createFaultInjectingClient,
    metrics: metricsA
  });
  bridgeB = await createRedisRealtimeBridge({ url: REDIS_URL, channelPrefix });
  await Promise.all([bridgeA.attach(hubA), bridgeB.attach(hubB)]);

  const first = await bridgeA.publishDocumentOperation({
    siteId: SITE_ID,
    contentId: CONTENT_ID,
    sequence: 1,
    operation: operation(1)
  });
  assert.equal(first.delivered, 1, 'the local hub must receive the operation before Redis is attempted');
  assert.equal(first.relayPublished, false);
  assert.equal(first.degraded, true);
  const localFirst = await localIterator.next();
  assert.equal(localFirst.done, false);
  assert.equal(localFirst.value.payload.sequence, 1);
  assert.equal(metricsA.snapshot().gauges.redis_bridge_degraded, 1);

  const second = await bridgeA.publishDocumentOperation({
    siteId: SITE_ID,
    contentId: CONTENT_ID,
    sequence: 2,
    operation: operation(2)
  });
  assert.equal(second.relayPublished, true);
  assert.equal(second.degraded, false);

  const [localSecond, remoteSecond] = await Promise.all([
    localIterator.next(),
    remoteIterator.next()
  ]);
  assert.equal(localSecond.value.payload.sequence, 2);
  assert.equal(remoteSecond.value.payload.sequence, 2);
  assert.equal(metricsA.snapshot().gauges.redis_bridge_ready, 1);
  assert.equal(metricsA.snapshot().gauges.redis_bridge_degraded, 0);

  console.log(JSON.stringify({
    scenario: 'transient-redis-publish-recovery',
    firstPublishDegraded: first.degraded,
    subsequentPublishRecovered: second.relayPublished,
    bridgeReadyAfterRecovery: metricsA.snapshot().gauges.redis_bridge_ready
  }));
});

test('real Redis relay sustains bounded sequenced fan-out without loss or slow-consumer overflow', {
  skip: !enabled,
  timeout: 120_000
}, async t => {
  const subscribersCount = boundedInteger('SYSTEMFABRIC_TEST_LOAD_SUBSCRIBERS', 10, 2, 40);
  const messageCount = boundedInteger('SYSTEMFABRIC_TEST_LOAD_MESSAGES', 2_000, 100, 10_000);
  const pacingMs = boundedInteger('SYSTEMFABRIC_TEST_LOAD_PACING_MS', 5, 0, 100);
  const channelPrefix = 'systemfabric:test:f1-11-load:' + randomUUID();
  const metricsB = createRealtimeMetrics();
  const hubA = createHub();
  const hubB = createHub(metricsB, Math.max(64, messageCount + 8));
  let bridgeA;
  let bridgeB;
  const subscriptions = [];
  const startedBySequence = new Map();

  t.after(async () => {
    for (const subscription of subscriptions) subscription.close();
    hubA.close();
    hubB.close();
    await Promise.allSettled([bridgeA?.close(), bridgeB?.close()]);
  });

  bridgeA = await createRedisRealtimeBridge({ url: REDIS_URL, channelPrefix });
  bridgeB = await createRedisRealtimeBridge({ url: REDIS_URL, channelPrefix, metrics: metricsB });
  await Promise.all([bridgeA.attach(hubA), bridgeB.attach(hubB)]);

  for (let index = 1; index <= subscribersCount; index += 1) {
    subscriptions.push(await subscribe(hubB, 'f1-11-load-subscriber-' + index));
  }

  const readers = subscriptions.map((subscription, subscriberIndex) => (async () => {
    const iterator = subscription.events[Symbol.asyncIterator]();
    const latencies = [];
    for (let expectedSequence = 1; expectedSequence <= messageCount; expectedSequence += 1) {
      const result = await iterator.next();
      assert.equal(result.done, false, 'subscriber ' + subscriberIndex + ' closed before the expected sequence');
      const event = result.value;
      assert.equal(event.payload.kind, 'document.operation');
      assert.equal(event.payload.sequence, expectedSequence, 'subscriber ' + subscriberIndex + ' must receive strictly ordered operations');
      const startedAt = startedBySequence.get(expectedSequence);
      assert.ok(startedAt, 'publisher start time must exist for sequence ' + expectedSequence);
      latencies.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    }
    return latencies;
  })());

  const startedAt = process.hrtime.bigint();
  for (let sequence = 1; sequence <= messageCount; sequence += 1) {
    startedBySequence.set(sequence, process.hrtime.bigint());
    const result = await bridgeA.publishDocumentOperation({
      siteId: SITE_ID,
      contentId: CONTENT_ID,
      sequence,
      operation: operation(sequence)
    });
    assert.equal(result.relayPublished, true, 'Redis publish must remain healthy at sequence ' + sequence);
    assert.equal(result.degraded, false);
    if (pacingMs > 0) await new Promise(resolve => setTimeout(resolve, pacingMs));
  }
  const publishCompletedAt = process.hrtime.bigint();

  const latencyGroups = await Promise.all(readers);
  const latencies = latencyGroups.flat().sort((a, b) => a - b);
  const elapsedMs = Number(publishCompletedAt - startedAt) / 1_000_000;
  const metrics = metricsB.snapshot();
  const overflowCount = metrics.counters.redis_document_inbound_queue_overflows_total || 0;
  const slowConsumerOverflows = metrics.counters.queue_overflows_total || 0;

  assert.equal(latencies.length, subscribersCount * messageCount);
  assert.equal(overflowCount, 0, 'Redis document ingress queue must not overflow under the configured load');
  assert.equal(slowConsumerOverflows, 0, 'active subscribers must not overflow their bounded event queues');
  assert.equal(bridgeB.documentInboundQueueSize, 0);

  console.log(JSON.stringify({
    scenario: 'redis-document-sustained-fanout',
    subscribers: subscribersCount,
    messages: messageCount,
    expectedDeliveries: subscribersCount * messageCount,
    observedDeliveries: latencies.length,
    publisherElapsedMs: Math.round(elapsedMs),
    publishRatePerSecond: Math.round(messageCount / Math.max(elapsedMs / 1_000, 0.001)),
    subscriberLatencyMs: {
      p50: Number(percentile(latencies, 0.50).toFixed(2)),
      p95: Number(percentile(latencies, 0.95).toFixed(2)),
      p99: Number(percentile(latencies, 0.99).toFixed(2))
    },
    documentQueueOverflows: overflowCount,
    slowConsumerOverflows,
    remainingDocumentQueue: bridgeB.documentInboundQueueSize
  }));
});
