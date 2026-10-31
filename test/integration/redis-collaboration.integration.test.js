'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');
const { createRealtimeHub } = require('../../packages/realtime/src/event-hub');
const { createRedisRealtimeBridge } = require('../../packages/realtime/src/redis-realtime');

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '99999999-9999-4999-8999-999999999999';
const CONTENT_A = '22222222-2222-4222-8222-222222222222';
const CONTENT_B = '33333333-3333-4333-8333-333333333333';

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

function createHub() {
  return createRealtimeHub({
    authorizeSubscribe: async ({ siteId, topic }) =>
      [SITE_A, SITE_B].includes(siteId) && /^document:[0-9a-f-]{36}$/i.test(topic)
  });
}

async function subscribe(hub, siteId, contentId, principalId) {
  return hub.subscribe({
    principal: { id: principalId },
    siteId,
    topic: 'document:' + contentId,
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
}

function nextEvent(subscription, timeoutMs = 2_000) {
  const iterator = subscription.events[Symbol.asyncIterator]();
  return Promise.race([
    iterator.next().then(result => {
      if (result.done) throw new Error('Subscription closed before an event arrived.');
      return result.value;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for Redis document event.')), timeoutMs))
  ]);
}

async function assertNoEvent(subscription, timeoutMs = 150) {
  await assert.rejects(nextEvent(subscription, timeoutMs), /Timed out waiting/);
}

function operation(opId, title) {
  return {
    schemaVersion: 1,
    opId,
    clientId: 'redis-integration',
    baseSequence: 0,
    type: 'document.set_title',
    payload: { title }
  };
}

const redisUrl = process.env.SYSTEMFABRIC_TEST_REDIS_URL || '';
const enabled = process.env.SYSTEMFABRIC_RUN_REDIS_INTEGRATION === 'true' && approvedRedisUrl(redisUrl);

test('real Redis document Pub/Sub routes only to the matching site and document', { skip: !enabled }, async t => {
  const channelPrefix = 'systemfabric:test:f1-10:' + randomUUID();
  const hubA = createHub();
  const hubB = createHub();
  let bridgeA;
  let bridgeB;
  const localA = await subscribe(hubA, SITE_A, CONTENT_A, 'local-a');
  const remoteSameDocument = await subscribe(hubB, SITE_A, CONTENT_A, 'remote-same');
  const remoteOtherDocument = await subscribe(hubB, SITE_A, CONTENT_B, 'remote-other');
  const remoteOtherSite = await subscribe(hubB, SITE_B, CONTENT_A, 'remote-site');

  t.after(async () => {
    for (const sub of [localA, remoteSameDocument, remoteOtherDocument, remoteOtherSite]) sub.close();
    hubA.close();
    hubB.close();
    await Promise.allSettled([bridgeA?.close(), bridgeB?.close()]);
  });

  bridgeA = await createRedisRealtimeBridge({ url: redisUrl, channelPrefix });
  bridgeB = await createRedisRealtimeBridge({ url: redisUrl, channelPrefix });
  await bridgeA.attach(hubA);
  await bridgeB.attach(hubB);

  const submitted = operation(randomUUID(), 'Cross-instance Redis document delivery');
  const result = await bridgeA.publishDocumentOperation({
    siteId: SITE_A,
    contentId: CONTENT_A,
    sequence: 1,
    originConnectionId: null,
    operation: submitted
  });

  assert.equal(result.relayPublished, true);
  assert.equal(result.degraded, false);
  const [localEvent, remoteEvent] = await Promise.all([
    nextEvent(localA),
    nextEvent(remoteSameDocument)
  ]);
  assert.equal(localEvent.payload.kind, 'document.operation');
  assert.equal(localEvent.payload.sequence, 1);
  assert.equal(localEvent.payload.operation.opId, submitted.opId);
  assert.equal(remoteEvent.payload.kind, 'document.operation');
  assert.equal(remoteEvent.payload.sequence, 1);
  assert.equal(remoteEvent.payload.operation.payload.title, submitted.payload.title);

  await Promise.all([
    assertNoEvent(remoteOtherDocument),
    assertNoEvent(remoteOtherSite),
    assertNoEvent(localA)
  ]);
});

test('real Redis document publish remains local-first and reports relay failure as degraded', { skip: !enabled }, async t => {
  const channelPrefix = 'systemfabric:test:f1-10:' + randomUUID();
  const hubA = createHub();
  const hubB = createHub();
  let bridgeA;
  let bridgeB;
  let failNextDocumentPublish = true;
  let publisherCreated = false;
  const localSubscription = await subscribe(hubA, SITE_A, CONTENT_A, 'degraded-local');
  const remoteSubscription = await subscribe(hubB, SITE_A, CONTENT_A, 'degraded-remote');

  t.after(async () => {
    localSubscription.close();
    remoteSubscription.close();
    hubA.close();
    hubB.close();
    await Promise.allSettled([bridgeA?.close(), bridgeB?.close()]);
  });

  const createFaultInjectingClient = options => {
    const client = createClient(options);
    if (!publisherCreated) {
      publisherCreated = true;
      const publish = client.publish.bind(client);
      client.publish = async (channel, message) => {
        if (failNextDocumentPublish && channel.includes(':document:')) {
          failNextDocumentPublish = false;
          const error = new Error('F1.10 injected Redis publish interruption');
          error.code = 'ERR_TEST_DOCUMENT_PUBLISH_INTERRUPTED';
          throw error;
        }
        return publish(channel, message);
      };
    }
    return client;
  };

  bridgeA = await createRedisRealtimeBridge({
    url: redisUrl,
    channelPrefix,
    createClient: createFaultInjectingClient
  });
  bridgeB = await createRedisRealtimeBridge({ url: redisUrl, channelPrefix });
  await bridgeA.attach(hubA);
  await bridgeB.attach(hubB);

  const submitted = operation(randomUUID(), 'Local commit despite Redis outage');
  const result = await bridgeA.publishDocumentOperation({
    siteId: SITE_A,
    contentId: CONTENT_A,
    sequence: 2,
    originConnectionId: null,
    operation: submitted
  });

  assert.equal(result.relayPublished, false);
  assert.equal(result.degraded, true);
  const localEvent = await nextEvent(localSubscription);
  assert.equal(localEvent.payload.sequence, 2);
  assert.equal(localEvent.payload.operation.opId, submitted.opId);
  await assertNoEvent(remoteSubscription);
});
