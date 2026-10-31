'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealtimeHub } = require('../packages/realtime/src/event-hub');
const { createMemoryPresenceAdapter, createPresenceService } = require('../packages/realtime/src/presence');
const { createApiServer } = require('../apps/api/src/server');

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

test('real-time hub isolates site topics and emits bounded, versionable envelopes', async () => {
  const hub = createRealtimeHub({ authorizeSubscribe: async () => true });
  const subscription = await hub.subscribe({ principal: { id: 'user-a' }, siteId: SITE_A, topic: 'presence' });
  const iterator = subscription.events[Symbol.asyncIterator]();

  const otherSite = await hub.publish({ siteId: SITE_B, topic: 'presence', payload: { kind: 'presence.refresh' } });
  assert.equal(otherSite.delivered, 0);

  const result = await hub.publish({ siteId: SITE_A, topic: 'presence', payload: { kind: 'presence.refresh' } });
  assert.equal(result.delivered, 1);
  const next = await iterator.next();
  assert.equal(next.done, false);
  assert.equal(next.value.siteId, SITE_A);
  assert.equal(next.value.topic, 'presence');
  assert.equal(next.value.schemaVersion, 1);
  assert.equal(next.value.payload.kind, 'presence.refresh');
  assert.match(next.value.eventId, /^[0-9a-f-]{36}$/i);
  await assert.rejects(
    hub.publish({ siteId: SITE_A, topic: 'presence', eventId: 'bad\r\nid: injected', payload: {} }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_EVENT_ID_INVALID'
  );
  await assert.rejects(
    hub.publish({ siteId: SITE_A, topic: 'presence', payload: { text: 'x'.repeat(20_000) } }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_EVENT_TOO_LARGE'
  );

  subscription.close();
  hub.close();
  assert.equal(hub.subscriberCount, 0);
});

test('real-time subscriptions fail closed and authorization is rechecked before delivery', async () => {
  let allowed = true;
  const hub = createRealtimeHub({
    authorizeSubscribe: async () => allowed,
    maxSubscriptionsPerPrincipal: 1
  });

  const subscription = await hub.subscribe({ principal: { id: 'user-a' }, siteId: SITE_A, topic: 'presence' });
  const iterator = subscription.events[Symbol.asyncIterator]();

  await assert.rejects(
    hub.subscribe({ principal: { id: 'user-a' }, siteId: SITE_A, topic: 'presence' }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_CONNECTION_LIMIT'
  );

  allowed = false;
  const result = await hub.publish({ siteId: SITE_A, topic: 'presence', payload: { kind: 'presence.refresh' } });
  assert.equal(result.revoked, 1);
  assert.equal(hub.subscriberCount, 0);
  assert.equal((await iterator.next()).done, true);

  await assert.rejects(
    hub.subscribe({ principal: { id: 'user-b' }, siteId: SITE_A, topic: 'presence' }),
    error => error.statusCode === 403 && error.code === 'ERR_SYSTEMFABRIC_REALTIME_FORBIDDEN'
  );
  hub.close();
});

test('real-time hub disconnects slow consumers rather than growing an unbounded queue', async () => {
  const hub = createRealtimeHub({ authorizeSubscribe: async () => true, maxQueueSize: 1 });
  const subscription = await hub.subscribe({ principal: { id: 'user-a' }, siteId: SITE_A, topic: 'presence' });
  const iterator = subscription.events[Symbol.asyncIterator]();

  assert.equal((await hub.publish({ siteId: SITE_A, topic: 'presence', payload: { sequence: 1 } })).delivered, 1);
  const overflow = await hub.publish({ siteId: SITE_A, topic: 'presence', payload: { sequence: 2 } });
  assert.equal(overflow.dropped, 1);
  assert.equal(hub.subscriberCount, 0);
  assert.equal((await iterator.next()).value.payload.sequence, 1);
  await assert.rejects(iterator.next(), error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_SLOW_CONSUMER');
  hub.close();
});

test('presence aggregates multiple sessions, honors hidden state, and expires leases', async () => {
  let now = 1_000_000;
  const adapter = createMemoryPresenceAdapter({ now: () => now, maxEntries: 20 });
  const presence = createPresenceService({ adapter, leaseMs: 5_000, now: () => now });

  await presence.heartbeat({ siteId: SITE_A, principalId: 'user-a', sessionId: 'session-one', availability: 'active' });
  await presence.heartbeat({ siteId: SITE_A, principalId: 'user-a', sessionId: 'session-two', availability: 'away' });
  await presence.heartbeat({ siteId: SITE_A, principalId: 'user-b', sessionId: 'session-three', availability: 'hidden' });
  await presence.heartbeat({ siteId: SITE_B, principalId: 'user-c', sessionId: 'session-four', availability: 'active' });

  let visible = await presence.list({ siteId: SITE_A, viewerId: 'user-other' });
  assert.deepEqual(visible.map(item => [item.userId, item.availability]), [['user-a', 'active']]);

  const ownView = await presence.list({ siteId: SITE_A, viewerId: 'user-b' });
  assert.deepEqual(ownView.map(item => [item.userId, item.availability]), [['user-a', 'active'], ['user-b', 'hidden']]);

  await presence.leave({ siteId: SITE_A, principalId: 'user-a', sessionId: 'session-one' });
  visible = await presence.list({ siteId: SITE_A, viewerId: 'user-other' });
  assert.deepEqual(visible.map(item => [item.userId, item.availability]), [['user-a', 'away']]);

  now += 5_001;
  assert.deepEqual(await presence.list({ siteId: SITE_A, viewerId: 'user-other' }), []);
  await presence.close();
});

test('presence rejects invalid states and enforces adapter capacity', async () => {
  const adapter = createMemoryPresenceAdapter({ maxEntries: 1 });
  const presence = createPresenceService({ adapter });
  await assert.rejects(
    presence.heartbeat({ siteId: SITE_A, principalId: 'user-a', sessionId: 's1', availability: 'watching' }),
    error => error.code === 'ERR_SYSTEMFABRIC_PRESENCE_AVAILABILITY_INVALID'
  );
  await presence.heartbeat({ siteId: SITE_A, principalId: 'user-a', sessionId: 's1' });
  await assert.rejects(
    presence.heartbeat({ siteId: SITE_A, principalId: 'user-a', sessionId: 's2' }),
    error => error.code === 'ERR_SYSTEMFABRIC_PRESENCE_CAPACITY'
  );
  await presence.close();
});

async function withRealtimeServer(fn) {
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_API_TOKEN: 'test-secret-token',
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      AI_PROVIDER: 'mock',
      MAX_REQUEST_BYTES: '16384',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.systemfabric.close();
  }
}

test('API exposes authenticated presence and a site-scoped SSE presence stream in preview mode', async () => {
  await withRealtimeServer(async base => {
    const headers = { authorization: 'Bearer test-secret-token' };
    const heartbeatUrl = base + '/api/v1/sites/' + SITE_A + '/presence/heartbeat';

    const active = await fetch(heartbeatUrl, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ availability: 'active' })
    });
    assert.equal(active.status, 200);
    assert.equal((await active.json()).presence.availability, 'active');

    const controller = new AbortController();
    const stream = await fetch(base + '/api/v1/sites/' + SITE_A + '/realtime/events?topic=presence', {
      headers,
      signal: controller.signal
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);

    const reader = stream.body.getReader();
    const ready = await reader.read();
    assert.match(new TextDecoder().decode(ready.value), /connected/);

    const idle = await fetch(heartbeatUrl, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ availability: 'idle' })
    });
    assert.equal(idle.status, 200);

    const event = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for SSE presence event.')), 2_000))
    ]);
    const frame = new TextDecoder().decode(event.value);
    assert.match(frame, /event: presence/);
    assert.match(frame, /presence\.refresh/);
    assert.doesNotMatch(frame, /local-developer/);

    const listed = await fetch(base + '/api/v1/sites/' + SITE_A + '/presence', { headers });
    const data = await listed.json();
    assert.equal(listed.status, 200);
    assert.deepEqual(data.presence.map(item => [item.userId, item.availability]), [['local-developer', 'idle']]);

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

test('API enforces site capability checks for authenticated non-developer presence requests', async () => {
  const identityService = {
    async authenticate(token) {
      return token === 'session-token'
        ? {
          sessionId: 'session-1',
          user: { id: 'user-1', email: 'user@example.test', displayName: 'User', status: 'active' },
          memberships: [{ siteId: SITE_A, capabilities: [] }]
        }
        : null;
    },
    async authorizeSite() { return false; }
  };
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      AI_PROVIDER: 'mock',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    identityService,
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/sites/' + SITE_A + '/presence', {
      headers: { authorization: 'Bearer session-token' }
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ERR_SYSTEMFABRIC_FORBIDDEN');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.systemfabric.close();
  }
});

test('API does not enable presence implicitly when the preview adapter is disabled', async () => {
  const server = createApiServer({
    env: { NODE_ENV: 'test', SYSTEMFABRIC_API_TOKEN: 'test-secret-token', AI_PROVIDER: 'mock' },
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/sites/' + SITE_A + '/presence', {
      headers: { authorization: 'Bearer test-secret-token' }
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'ERR_SYSTEMFABRIC_REALTIME_DISABLED');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.systemfabric.close();
  }
});


test('API refuses Redis presence when no shared adapter service is injected', () => {
  assert.throws(() => createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      SYSTEMFABRIC_PRESENCE_STORE: 'redis',
      AI_PROVIDER: 'mock'
    },
    logger: { error() {} }
  }), /asynchronously connected presenceService to be injected/);
});

test('API accepts Redis-backed presence only with an attached cross-instance Pub/Sub bridge', async () => {
  let closed = false;
  const presenceService = {
    async heartbeat() { return { availability: 'active' }; },
    async leave() { return { left: true }; },
    async list() { return []; },
    async close() { closed = true; }
  };
  let bridgeClosed = false;
  const realtimeBridge = {
    async attach() {},
    async publish() { return { delivered: 0 }; },
    async close() { bridgeClosed = true; }
  };
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      SYSTEMFABRIC_PRESENCE_STORE: 'redis',
      AI_PROVIDER: 'mock'
    },
    presenceService,
    realtimeBridge,
    logger: { error() {} }
  });
  await server.systemfabric.ready();
  assert.equal(server.systemfabric.presenceService, presenceService);
  assert.equal(server.systemfabric.presenceStore, 'redis');
  assert.equal(server.systemfabric.realtimeMode, 'redis-shared-presence-pubsub');
  await server.systemfabric.close();
  assert.equal(closed, true);
  assert.equal(bridgeClosed, true);
});
