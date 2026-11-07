'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createApiServer } = require('../apps/api/src/server');

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN = 'site-a-only-session-token';

function connectWebSocket(url, origin, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        authorization: 'Bearer ' + TOKEN,
        origin,
        ...extraHeaders
      }
    });
    socket._messages = [];
    socket._waiters = [];
    socket.on('message', data => {
      const waiter = socket._waiters.shift();
      if (waiter) waiter(data);
      else socket._messages.push(data);
    });
    let settled = false;

    socket.once('open', () => {
      settled = true;
      resolve(socket);
    });
    socket.once('unexpected-response', (_request, response) => {
      const error = new Error('WebSocket upgrade rejected with ' + response.statusCode);
      error.statusCode = response.statusCode;
      response.resume();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.once('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function nextWebSocketMessage(socket, timeoutMs = 1_000) {
  if (socket._messages.length) {
    return Promise.resolve(JSON.parse(socket._messages.shift().toString()));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = socket._waiters.indexOf(onMessage);
      if (index >= 0) socket._waiters.splice(index, 1);
      reject(new Error('Timed out waiting for WebSocket readiness.'));
    }, timeoutMs);
    function onMessage(data) {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    }
    socket._waiters.push(onMessage);
  });
}

test('site-A membership cannot cross into site-B presence, SSE, or WebSocket', async t => {
  const authorizationCalls = [];
  const identityService = {
    async authenticate(token) {
      if (token !== TOKEN) return null;
      return {
        sessionId: SESSION_A,
        expiresAt: new Date(Date.now() + 60_000),
        user: {
          id: USER_A,
          email: 'site-a-user@example.test',
          displayName: 'Site A User',
          status: 'active'
        },
        memberships: [{ siteId: SITE_A, capabilities: ['content:read'] }]
      };
    },
    async authorizeSite(userId, siteId, capability) {
      authorizationCalls.push({ userId, siteId, capability });
      return userId === USER_A && siteId === SITE_A && capability === 'content:read';
    },
    async isSessionActive({ userId, sessionId }) {
      return userId === USER_A && sessionId === SESSION_A;
    }
  };

  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      VIRGOSCORPIO_HUB_REALTIME_ENABLED: 'true',
      VIRGOSCORPIO_HUB_DEFAULT_SITE_ID: SITE_A,
      AI_PROVIDER: 'mock',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    identityService,
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const headers = { authorization: 'Bearer ' + TOKEN };
  const sitePath = siteId => '/api/v1/sites/' + siteId;
  let siteASocket = null;
  const sseController = new AbortController();

  t.after(async () => {
    sseController.abort();
    if (siteASocket && siteASocket.readyState !== WebSocket.CLOSED) {
      await new Promise(resolve => {
        siteASocket.once('close', resolve);
        siteASocket.close();
      });
    }
    await server.virgoScorpioHub.close();
    await new Promise(resolve => server.close(resolve));
  });

  const heartbeatA = await fetch(origin + sitePath(SITE_A) + '/presence/heartbeat', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ availability: 'active' })
  });
  assert.equal(heartbeatA.status, 200);
  assert.equal((await heartbeatA.json()).presence.availability, 'active');

  const presenceA = await fetch(origin + sitePath(SITE_A) + '/presence', { headers });
  assert.equal(presenceA.status, 200);
  assert.deepEqual(
    (await presenceA.json()).presence.map(entry => [entry.userId, entry.availability]),
    [[USER_A, 'active']]
  );

  const presenceMismatchHeader = await fetch(origin + sitePath(SITE_A) + '/presence', {
    headers: { ...headers, 'x-virgoscorpio-hub-site-id': SITE_B }
  });
  assert.equal(presenceMismatchHeader.status, 400);
  assert.equal((await presenceMismatchHeader.json()).code, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH');

  const presenceMismatchQuery = await fetch(origin + sitePath(SITE_A) + '/presence?siteId=' + SITE_B, { headers });
  assert.equal(presenceMismatchQuery.status, 400);
  assert.equal((await presenceMismatchQuery.json()).code, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH');

  const heartbeatMismatchBody = await fetch(origin + sitePath(SITE_A) + '/presence/heartbeat', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ siteId: SITE_B, availability: 'active' })
  });
  assert.equal(heartbeatMismatchBody.status, 400);
  assert.equal((await heartbeatMismatchBody.json()).code, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH');

  const presenceAfterMismatch = await fetch(origin + sitePath(SITE_A) + '/presence', { headers });
  assert.equal(presenceAfterMismatch.status, 200);
  assert.deepEqual((await presenceAfterMismatch.json()).presence.map(entry => [entry.userId, entry.availability]), [[USER_A, 'active']]);

  const heartbeatB = await fetch(origin + sitePath(SITE_B) + '/presence/heartbeat', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ availability: 'active' })
  });
  assert.equal(heartbeatB.status, 403);
  assert.equal((await heartbeatB.json()).code, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN');

  const presenceB = await fetch(origin + sitePath(SITE_B) + '/presence', { headers });
  assert.equal(presenceB.status, 403);
  assert.equal((await presenceB.json()).code, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN');

  const sseA = await fetch(origin + sitePath(SITE_A) + '/realtime/events?topic=presence', {
    headers,
    signal: sseController.signal
  });
  assert.equal(sseA.status, 200);
  assert.match(sseA.headers.get('content-type'), /text\/event-stream/);

  const sseMismatch = await fetch(origin + sitePath(SITE_A) + '/realtime/events?topic=presence', {
    headers: { ...headers, 'x-virgoscorpio-hub-site-id': SITE_B }
  });
  assert.equal(sseMismatch.status, 400);
  assert.equal((await sseMismatch.json()).code, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH');
  assert.doesNotMatch(sseMismatch.headers.get('content-type') || '', /text\/event-stream/);

  const sseQueryMismatch = await fetch(origin + sitePath(SITE_A) + '/realtime/events?topic=presence&siteId=' + SITE_B, { headers });
  assert.equal(sseQueryMismatch.status, 400);
  assert.equal((await sseQueryMismatch.json()).code, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH');
  const sseReader = sseA.body.getReader();
  const readyFrame = await sseReader.read();
  assert.match(new TextDecoder().decode(readyFrame.value), /connection\.ready/);
  sseController.abort();
  await sseReader.cancel().catch(() => {});

  const sseB = await fetch(origin + sitePath(SITE_B) + '/realtime/events?topic=presence', { headers });
  assert.equal(sseB.status, 403);
  assert.equal((await sseB.json()).code, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN');
  assert.doesNotMatch(sseB.headers.get('content-type') || '', /text\/event-stream/);

  const wsPath = siteId => origin.replace(/^http/, 'ws') + sitePath(siteId) + '/realtime/ws';
  siteASocket = await connectWebSocket(wsPath(SITE_A), origin);
  assert.equal((await nextWebSocketMessage(siteASocket)).type, 'connection.ready');

  const subscriptionsBeforeDeniedUpgrade = server.virgoScorpioHub.realtimeHub.subscriberCount;
  await assert.rejects(
    connectWebSocket(wsPath(SITE_B), origin),
    error => error.statusCode === 403
  );

  await assert.rejects(
    connectWebSocket(wsPath(SITE_A), origin, { 'x-virgoscorpio-hub-site-id': SITE_B }),
    error => error.statusCode === 400
  );
  await assert.rejects(
    connectWebSocket(wsPath(SITE_A) + '?siteId=' + SITE_B, origin),
    error => error.statusCode === 400
  );
  assert.equal(server.virgoScorpioHub.realtimeHub.subscriberCount, subscriptionsBeforeDeniedUpgrade, 'selector-mismatched upgrades must not create subscriptions');
  assert.equal(
    server.virgoScorpioHub.realtimeHub.subscriberCount,
    subscriptionsBeforeDeniedUpgrade,
    'the denied Site B upgrade must not create a subscription'
  );

  assert.ok(authorizationCalls.some(call => call.siteId === SITE_A && call.capability === 'content:read'));
  assert.ok(authorizationCalls.some(call => call.siteId === SITE_B && call.capability === 'content:read'));
  assert.ok(authorizationCalls.every(call => call.userId === USER_A));
});
