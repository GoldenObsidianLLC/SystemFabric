'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createRedisPresenceService } = require('../../packages/realtime/src/redis-presence');

const enabled = process.env.SYSTEMFABRIC_RUN_REDIS_INTEGRATION === 'true' &&
  Boolean(process.env.SYSTEMFABRIC_PRESENCE_REDIS_URL);
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

test('Redis integration: two service instances share session leases, site isolation, capacity, and expiry', {
  skip: !enabled
}, async t => {
  let now = Date.now();
  const keyPrefix = `systemfabric:presence:it:${randomUUID().replaceAll('-', '')}`;
  const expired = [];
  const options = {
    url: process.env.SYSTEMFABRIC_PRESENCE_REDIS_URL,
    keyPrefix,
    leaseMs: 5_000,
    maxEntriesPerSite: 3,
    now: () => now,
    onExpired: event => expired.push(event)
  };
  const presenceA = await createRedisPresenceService(options);
  const presenceB = await createRedisPresenceService(options);
  t.after(async () => {
    await Promise.all([presenceA.close(), presenceB.close()]);
  });

  // Heartbeats arrive through separate clients, as they would on two API replicas.
  await presenceA.heartbeat({
    siteId: SITE_A, principalId: 'presence-user-a', sessionId: 'device-one', availability: 'active'
  });
  await presenceB.heartbeat({
    siteId: SITE_A, principalId: 'presence-user-a', sessionId: 'device-two', availability: 'away'
  });
  await presenceB.heartbeat({
    siteId: SITE_A, principalId: 'presence-user-b', sessionId: 'device-three', availability: 'hidden'
  });
  await presenceA.heartbeat({
    siteId: SITE_B, principalId: 'presence-user-c', sessionId: 'device-four', availability: 'active'
  });

  const visible = await presenceB.list({ siteId: SITE_A, viewerId: 'presence-observer' });
  assert.deepEqual(visible.map(item => [item.userId, item.availability]), [
    ['presence-user-a', 'active']
  ]);
  const ownHidden = await presenceA.list({ siteId: SITE_A, viewerId: 'presence-user-b' });
  assert.deepEqual(ownHidden.map(item => [item.userId, item.availability]), [
    ['presence-user-a', 'active'],
    ['presence-user-b', 'hidden']
  ]);
  assert.deepEqual((await presenceB.list({ siteId: SITE_B, viewerId: 'presence-observer' }))
    .map(item => item.userId), ['presence-user-c']);

  await assert.rejects(() => presenceA.heartbeat({
    siteId: SITE_A, principalId: 'presence-user-d', sessionId: 'device-five', availability: 'active'
  }), { code: 'ERR_SYSTEMFABRIC_PRESENCE_CAPACITY' });

  // A leave on replica B immediately changes the shared snapshot read by replica A.
  await presenceB.leave({ siteId: SITE_A, principalId: 'presence-user-a', sessionId: 'device-one' });
  const afterLeave = await presenceA.list({ siteId: SITE_A, viewerId: 'presence-observer' });
  assert.deepEqual(afterLeave.map(item => [item.userId, item.availability]), [
    ['presence-user-a', 'away']
  ]);

  now += 5_001;
  assert.deepEqual(await presenceA.list({ siteId: SITE_A, viewerId: 'presence-observer' }), []);
  assert.deepEqual(await presenceB.list({ siteId: SITE_B, viewerId: 'presence-observer' }), []);
  assert.deepEqual(expired.map(item => [item.siteId, item.principalId, item.sessionId]).sort(),
    [[SITE_A, 'presence-user-a', 'device-two'], [SITE_A, 'presence-user-b', 'device-three'], [SITE_B, 'presence-user-c', 'device-four']].sort());
});


test('Redis API integration: heartbeat on one API instance is visible from another instance', {
  skip: !enabled
}, async t => {
  const keyPrefix = `systemfabric:presence:api-it:${randomUUID().replaceAll('-', '')}`;
  const options = {
    url: process.env.SYSTEMFABRIC_PRESENCE_REDIS_URL,
    keyPrefix,
    leaseMs: 10_000
  };
  const presenceA = await createRedisPresenceService(options);
  const presenceB = await createRedisPresenceService(options);
  const { createRedisRealtimeBridge } = require('../../packages/realtime/src/redis-realtime');
  const bridgePrefix = 'systemfabric:realtime:api-snapshot-it:' + randomUUID().replaceAll('-', '');
  const bridgeA = await createRedisRealtimeBridge({ url: options.url, channelPrefix: bridgePrefix });
  const bridgeB = await createRedisRealtimeBridge({ url: options.url, channelPrefix: bridgePrefix });
  const { createApiServer } = require('../../apps/api/src/server');
  const sharedEnv = {
    NODE_ENV: 'test',
    SYSTEMFABRIC_API_TOKEN: 'redis-presence-api-test-token',
    SYSTEMFABRIC_REALTIME_ENABLED: 'true',
    SYSTEMFABRIC_PRESENCE_STORE: 'redis',
    AI_PROVIDER: 'mock',
    MAX_REQUEST_BYTES: '16384',
    RATE_LIMIT_MAX_REQUESTS: '100'
  };
  const serverA = createApiServer({
    env: sharedEnv,
    presenceService: presenceA,
    realtimeBridge: bridgeA,
    logger: { error() {} }
  });
  const serverB = createApiServer({
    env: sharedEnv,
    presenceService: presenceB,
    realtimeBridge: bridgeB,
    logger: { error() {} }
  });
  await Promise.all([serverA.systemfabric.ready(), serverB.systemfabric.ready()]);
  await Promise.all([
    new Promise(resolve => serverA.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => serverB.listen(0, '127.0.0.1', resolve))
  ]);
  t.after(async () => {
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve))
    ]);
    await Promise.all([
      serverA.systemfabric.close(),
      serverB.systemfabric.close()
    ]);
  });

  const headers = {
    authorization: 'Bearer redis-presence-api-test-token',
    'content-type': 'application/json'
  };
  const heartbeat = await fetch(
    `http://127.0.0.1:${serverA.address().port}/api/v1/sites/${SITE_A}/presence/heartbeat`,
    { method: 'POST', headers, body: JSON.stringify({ availability: 'active' }) }
  );
  assert.equal(heartbeat.status, 200);
  assert.equal(serverA.systemfabric.presenceStore, 'redis');
  assert.equal(serverB.systemfabric.presenceStore, 'redis');

  const snapshot = await fetch(
    `http://127.0.0.1:${serverB.address().port}/api/v1/sites/${SITE_A}/presence`,
    { headers: { authorization: headers.authorization } }
  );
  assert.equal(snapshot.status, 200);
  const data = await snapshot.json();
  assert.deepEqual(data.presence.map(item => [item.userId, item.availability]), [
    ['local-developer', 'active']
  ]);
});


test('Redis Pub/Sub API integration: cross-instance SSE fan-out, site isolation and lazy expiry propagation', {
  skip: !enabled
}, async t => {
  const suffix = randomUUID().replaceAll('-', '');
  const redisUrl = process.env.SYSTEMFABRIC_PRESENCE_REDIS_URL;
  const channelPrefix = 'systemfabric:realtime:api-it:' + suffix;
  const keyPrefix = 'systemfabric:presence:api-it:' + suffix;
  let now = Date.now();
  const bridgeA = await require('../../packages/realtime/src/redis-realtime').createRedisRealtimeBridge({
    url: redisUrl,
    channelPrefix
  });
  const bridgeB = await require('../../packages/realtime/src/redis-realtime').createRedisRealtimeBridge({
    url: redisUrl,
    channelPrefix
  });
  const presenceA = await createRedisPresenceService({
    url: redisUrl,
    keyPrefix,
    leaseMs: 5_000,
    now: () => now,
    onExpired: event => bridgeA.publish({
      siteId: event.siteId,
      topic: 'presence',
      payload: { kind: 'presence.refresh' }
    })
  });
  const presenceB = await createRedisPresenceService({
    url: redisUrl,
    keyPrefix,
    leaseMs: 5_000,
    now: () => now
  });
  const { createApiServer } = require('../../apps/api/src/server');
  const sharedEnv = {
    NODE_ENV: 'test',
    SYSTEMFABRIC_API_TOKEN: 'redis-realtime-api-test-token',
    SYSTEMFABRIC_REALTIME_ENABLED: 'true',
    SYSTEMFABRIC_PRESENCE_STORE: 'redis',
    AI_PROVIDER: 'mock',
    MAX_REQUEST_BYTES: '16384',
    RATE_LIMIT_MAX_REQUESTS: '100'
  };
  const serverA = createApiServer({
    env: sharedEnv,
    presenceService: presenceA,
    realtimeBridge: bridgeA,
    logger: { error() {} }
  });
  const serverB = createApiServer({
    env: sharedEnv,
    presenceService: presenceB,
    realtimeBridge: bridgeB,
    logger: { error() {} }
  });
  await Promise.all([serverA.systemfabric.ready(), serverB.systemfabric.ready()]);
  await Promise.all([
    new Promise(resolve => serverA.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => serverB.listen(0, '127.0.0.1', resolve))
  ]);
  const headers = { authorization: 'Bearer redis-realtime-api-test-token' };
  const controllerA = new AbortController();
  const controllerB = new AbortController();

  async function openPresenceStream(siteId, controller) {
    const response = await fetch(
      'http://127.0.0.1:' + serverB.address().port + '/api/v1/sites/' + siteId + '/realtime/events?topic=presence',
      { headers, signal: controller.signal }
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const ready = await reader.read();
    assert.match(new TextDecoder().decode(ready.value), /connected/);
    return reader;
  }

  async function readUntil(reader, marker, timeoutMs = 2_000) {
    let text = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for SSE marker: ' + marker)), remaining))
      ]);
      if (result.done) throw new Error('SSE stream closed before marker: ' + marker);
      text += new TextDecoder().decode(result.value);
      if (text.includes(marker)) return text;
    }
    throw new Error('Timed out waiting for SSE marker: ' + marker);
  }

  try {
    const siteAReader = await openPresenceStream(SITE_A, controllerA);
    const siteBReader = await openPresenceStream(SITE_B, controllerB);
    const heartbeat = await fetch(
      'http://127.0.0.1:' + serverA.address().port + '/api/v1/sites/' + SITE_A + '/presence/heartbeat',
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ availability: 'active' })
      }
    );
    assert.equal(heartbeat.status, 200);
    const pushed = await readUntil(siteAReader, 'presence.refresh');
    assert.match(pushed, /event: presence/);
    assert.doesNotMatch(pushed, /local-developer|principalId|sessionId/);

    const quietAfterHeartbeat = await Promise.race([
      siteBReader.read().then(() => 'unexpected-event'),
      new Promise(resolve => setTimeout(() => resolve('quiet'), 100))
    ]);
    assert.equal(quietAfterHeartbeat, 'quiet');

    now += 5_001;
    const snapshot = await fetch(
      'http://127.0.0.1:' + serverA.address().port + '/api/v1/sites/' + SITE_A + '/presence',
      { headers }
    );
    assert.equal(snapshot.status, 200);
    assert.deepEqual((await snapshot.json()).presence, []);
    const expiredPush = await readUntil(siteAReader, 'presence.refresh');
    assert.match(expiredPush, /event: presence/);

    const quietAfterExpiry = await Promise.race([
      siteBReader.read().then(() => 'unexpected-event'),
      new Promise(resolve => setTimeout(() => resolve('quiet'), 100))
    ]);
    assert.equal(quietAfterExpiry, 'quiet');
  } finally {
    controllerA.abort();
    controllerB.abort();
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve))
    ]);
    await Promise.all([
      serverA.systemfabric.close(),
      serverB.systemfabric.close()
    ]);
  }
});


test('Redis authorization integration: membership and session invalidations close only matching cross-instance SSE streams', {
  skip: !enabled
}, async t => {
  const suffix = randomUUID().replaceAll('-', '');
  const redisUrl = process.env.SYSTEMFABRIC_PRESENCE_REDIS_URL;
  const channelPrefix = 'systemfabric:realtime:authz-it:' + suffix;
  const bridgeA = await require('../../packages/realtime/src/redis-realtime').createRedisRealtimeBridge({
    url: redisUrl,
    channelPrefix
  });
  const bridgeB = await require('../../packages/realtime/src/redis-realtime').createRedisRealtimeBridge({
    url: redisUrl,
    channelPrefix
  });
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const identityService = {
    async authenticate(token) {
      return token === 'authorization-integration-session' ? {
        sessionId,
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: userId, email: 'user@example.test', displayName: 'User', status: 'active' },
        memberships: [{ siteId: SITE_A, capabilities: ['content:read'] }, { siteId: SITE_B, capabilities: ['content:read'] }]
      } : null;
    },
    async isSessionActive() { return true; },
    async authorizeSite() { return true; }
  };
  const presenceService = { async close() {} };
  const sharedEnv = {
    NODE_ENV: 'test',
    SYSTEMFABRIC_REALTIME_ENABLED: 'true',
    SYSTEMFABRIC_PRESENCE_STORE: 'redis',
    AI_PROVIDER: 'mock',
    MAX_REQUEST_BYTES: '16384',
    RATE_LIMIT_MAX_REQUESTS: '100'
  };
  const { createApiServer } = require('../../apps/api/src/server');
  const serverA = createApiServer({ env: sharedEnv, identityService, presenceService, realtimeBridge: bridgeA, logger: { error() {} } });
  const serverB = createApiServer({ env: sharedEnv, identityService, presenceService, realtimeBridge: bridgeB, logger: { error() {} } });
  await Promise.all([serverA.systemfabric.ready(), serverB.systemfabric.ready()]);
  await Promise.all([
    new Promise(resolve => serverA.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => serverB.listen(0, '127.0.0.1', resolve))
  ]);
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const headers = { authorization: 'Bearer authorization-integration-session' };

  async function openStream(siteId, controller) {
    const response = await fetch('http://127.0.0.1:' + serverB.address().port + '/api/v1/sites/' + siteId + '/realtime/events?topic=presence', {
      headers, signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const ready = await reader.read();
    assert.match(new TextDecoder().decode(ready.value), /connected/);
    return reader;
  }

  try {
    const siteAReader = await openStream(SITE_A, controllerA);
    const siteBReader = await openStream(SITE_B, controllerB);

    await bridgeA.invalidateAuthorization({ siteId: SITE_A, principalId: userId });
    const siteAClosed = await Promise.race([
      siteAReader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Site-scoped authorization invalidation did not close the remote SSE stream.')), 2_000))
    ]);
    assert.equal(siteAClosed.done, true);

    const siteBState = await Promise.race([
      siteBReader.read().then(result => result.done ? 'closed' : 'data'),
      new Promise(resolve => setTimeout(() => resolve('still-open'), 100))
    ]);
    assert.equal(siteBState, 'still-open', 'site-scoped invalidation must not close another site stream');

    await bridgeA.invalidateAuthorization({ sessionId });
    const siteBClosed = await Promise.race([
      siteBReader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Session invalidation did not close the remaining remote SSE stream.')), 2_000))
    ]);
    assert.equal(siteBClosed.done, true);
  } finally {
    controllerA.abort();
    controllerB.abort();
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve))
    ]);
    await Promise.all([serverA.systemfabric.close(), serverB.systemfabric.close()]);
  }
});
