'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createApiServer } = require('../apps/api/src/server');
const { createMemoryRealtimeConnectionLimiter } = require('../packages/realtime/src/connection-quota');

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'websocket-preview-token';

function nextMessage(socket, timeoutMs = 1_000) {
  if (socket._messages.length) return Promise.resolve(JSON.parse(socket._messages.shift().toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = socket._waiters.indexOf(onMessage);
      if (index >= 0) socket._waiters.splice(index, 1);
      reject(new Error('Timed out waiting for WebSocket message.'));
    }, timeoutMs);
    const onMessage = data => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    };
    socket._waiters.push(onMessage);
  });
}

function connect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket._messages = [];
    socket._waiters = [];
    socket.on('message', data => {
      const waiter = socket._waiters.shift();
      if (waiter) waiter(data);
      else socket._messages.push(data);
    });
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_request, response) => {
      const error = new Error('WebSocket upgrade rejected with ' + response.statusCode);
      error.statusCode = response.statusCode;
      response.resume();
      reject(error);
    });
    socket.once('error', reject);
  });
}

async function createServer(t, options = {}) {
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_API_TOKEN: TOKEN,
      SYSTEMFABRIC_DEFAULT_SITE_ID: SITE_ID,
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      AI_PROVIDER: 'mock',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    logger: { error() {} },
    ...options
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const url = origin.replace('http://', 'ws://') + '/api/v1/sites/' + SITE_ID + '/realtime/ws';
  t.after(async () => {
    await server.systemfabric.close();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, origin, url };
}

test('authenticated same-origin WebSocket negotiates snapshot-refresh recovery and answers ping', async t => {
  const { url, origin } = await createServer(t);
  const socket = await connect(url, {
    authorization: 'Bearer ' + TOKEN,
    origin
  });
  t.after(() => socket.close());

  const ready = await nextMessage(socket);
  assert.equal(ready.type, 'connection.ready');
  assert.equal(ready.protocolVersion, 1);
  assert.equal(ready.recovery.resumeMode, 'snapshot-refresh');
  assert.equal(ready.recovery.eventReplay, false);
  assert.equal(ready.recovery.maxAttempts, 8);

  socket.send(JSON.stringify({ type: 'ping' }));
  const pong = await nextMessage(socket);
  assert.equal(pong.type, 'pong');
});

test('WebSocket presence heartbeat is session-scoped and updates the authoritative REST snapshot', async t => {
  const { server, origin, url } = await createServer(t);
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => socket.close());

  await nextMessage(socket);
  socket.send(JSON.stringify({ type: 'presence.heartbeat', availability: 'active' }));
  let acknowledgement;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const message = await nextMessage(socket);
    if (message.type === 'presence.heartbeat.ack') {
      acknowledgement = message;
      break;
    }
  }
  assert.ok(acknowledgement, 'presence heartbeat receives an acknowledgement after any resulting event frame');
  assert.equal(acknowledgement.type, 'presence.heartbeat.ack');
  assert.equal(acknowledgement.accepted, true);

  const response = await fetch(origin + '/api/v1/sites/' + SITE_ID + '/presence', {
    headers: { authorization: 'Bearer ' + TOKEN }
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.presence.length, 1);
  assert.equal(result.presence[0].availability, 'active');
  assert.equal(server.systemfabric.realtimeMetrics.counters.websocket_messages_received_total, 1);
});

test('WebSocket rejects unauthenticated and cross-origin upgrade attempts before connection', async t => {
  const { url, origin } = await createServer(t);

  await assert.rejects(
    connect(url, { origin }),
    error => error.statusCode === 401
  );
  await assert.rejects(
    connect(url, { authorization: 'Bearer ' + TOKEN, origin: 'https://attacker.example' }),
    error => error.statusCode === 403
  );
});

test('distributed connection quota rejects a second WebSocket for the same principal', async t => {
  const limiter = createMemoryRealtimeConnectionLimiter({
    limits: { maxGlobal: 10, maxPerSite: 10, maxPerPrincipal: 1 }
  });
  const { url, origin } = await createServer(t, { realtimeConnectionLimiter: limiter });
  const first = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => first.close());
  await nextMessage(first);

  await assert.rejects(
    connect(url, { authorization: 'Bearer ' + TOKEN, origin }),
    error => error.statusCode === 429
  );
});

test('WebSocket rejects unknown and malformed commands and cleans up on close', async t => {
  const { server, url, origin } = await createServer(t);
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  await nextMessage(socket);

  socket.send('{bad-json');
  const [code] = await new Promise(resolve => socket.once('close', (status, reason) => resolve([status, reason.toString()])));
  assert.equal(code, 1008);
  assert.equal(server.systemfabric.realtimeMetrics.gauges.active_websocket_connections, 0);
});

test('SSE and WebSocket consume the same principal connection quota and release it on disconnect', async t => {
  const limiter = createMemoryRealtimeConnectionLimiter({
    limits: { maxGlobal: 10, maxPerSite: 10, maxPerPrincipal: 1 }
  });
  const { origin, url } = await createServer(t, { realtimeConnectionLimiter: limiter });
  const controller = new AbortController();
  const response = await fetch(origin + '/api/v1/sites/' + SITE_ID + '/realtime/events?topic=presence', {
    headers: { authorization: 'Bearer ' + TOKEN },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const ready = await reader.read();
  const firstFrame = new TextDecoder().decode(ready.value);
  assert.match(firstFrame, /event: connection\.ready/);
  assert.match(firstFrame, /snapshot-refresh/);

  await assert.rejects(
    connect(url, { authorization: 'Bearer ' + TOKEN, origin }),
    error => error.statusCode === 429
  );

  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => socket.close());
  assert.equal((await nextMessage(socket)).type, 'connection.ready');
});

test('WebSocket reauthorizes each client command and closes after authorization is revoked', async t => {
  let authorized = true;
  const { createRealtimeHub } = require('../packages/realtime/src/event-hub');
  const hub = createRealtimeHub({ authorizeSubscribe: async () => authorized });
  const { url, origin } = await createServer(t, { realtimeHub: hub });
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => socket.close());
  assert.equal((await nextMessage(socket)).type, 'connection.ready');

  authorized = false;
  socket.send(JSON.stringify({ type: 'ping' }));
  const [code] = await new Promise(resolve => socket.once('close', status => resolve([status])));
  assert.equal(code, 1008);
  assert.equal(hub.subscriberCount, 0);
});

test('WebSocket presence.leave removes only the authenticated session lease', async t => {
  const { origin, url } = await createServer(t);
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => socket.close());
  await nextMessage(socket);

  socket.send(JSON.stringify({ type: 'presence.heartbeat', availability: 'active' }));
  let heartbeatAck;
  for (let i = 0; i < 3; i += 1) {
    const message = await nextMessage(socket);
    if (message.type === 'presence.heartbeat.ack') { heartbeatAck = message; break; }
  }
  assert.ok(heartbeatAck);

  socket.send(JSON.stringify({ type: 'presence.leave' }));
  let leaveAck;
  for (let i = 0; i < 3; i += 1) {
    const message = await nextMessage(socket);
    if (message.type === 'presence.leave.ack') { leaveAck = message; break; }
  }
  assert.ok(leaveAck);
  assert.equal(leaveAck.accepted, true);

  const response = await fetch(origin + '/api/v1/sites/' + SITE_ID + '/presence', {
    headers: { authorization: 'Bearer ' + TOKEN }
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).presence, []);
});

test('WebSocket server rejects binary and over-limit frames', async t => {
  const { origin, url } = await createServer(t);
  const binary = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  await nextMessage(binary);
  const binaryClosed = new Promise(resolve => binary.once('close', (code) => resolve(code)));
  binary.send(Buffer.from([0, 1, 2]));
  assert.equal(await binaryClosed, 1008);

  const oversized = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  await nextMessage(oversized);
  const oversizedClosed = new Promise(resolve => oversized.once('close', code => resolve(code)));
  oversized.send(JSON.stringify({ type: 'ping', padding: 'x'.repeat(5_000) }));
  assert.equal(await oversizedClosed, 1009);
});

test('WebSocket disconnect releases the shared quota lease', async t => {
  const limiter = createMemoryRealtimeConnectionLimiter({
    limits: { maxGlobal: 10, maxPerSite: 10, maxPerPrincipal: 1 }
  });
  const { url, origin } = await createServer(t, { realtimeConnectionLimiter: limiter });
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  assert.equal((await nextMessage(socket)).type, 'connection.ready');
  assert.equal(limiter.activeCount, 1);

  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.close();
  await closed;
  for (let attempt = 0; attempt < 20 && limiter.activeCount !== 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(limiter.activeCount, 0);
});

test('WebSocket enforces the per-connection command rate ceiling', async t => {
  const { url, origin } = await createServer(t);
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  await nextMessage(socket);
  const closed = new Promise(resolve => socket.once('close', code => resolve(code)));
  for (let index = 0; index < 61; index += 1) socket.send(JSON.stringify({ type: 'ping' }));
  assert.equal(await closed, 1008);
});

test('API shutdown closes active WebSockets and awaits shared quota release', async t => {
  const limiter = createMemoryRealtimeConnectionLimiter({
    limits: { maxGlobal: 10, maxPerSite: 10, maxPerPrincipal: 2 }
  });
  const { server, url, origin } = await createServer(t, { realtimeConnectionLimiter: limiter });
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  await nextMessage(socket);
  assert.equal(limiter.activeCount, 1);

  const closed = new Promise(resolve => socket.once('close', code => resolve(code)));
  await server.systemfabric.close();
  assert.equal(await closed, 1001);
  assert.equal(limiter.activeCount, 0);
});

test('API shutdown ends active SSE streams and awaits shared quota release', async t => {
  const limiter = createMemoryRealtimeConnectionLimiter({
    limits: { maxGlobal: 10, maxPerSite: 10, maxPerPrincipal: 2 }
  });
  const { server, origin } = await createServer(t, { realtimeConnectionLimiter: limiter });
  const response = await fetch(origin + '/api/v1/sites/' + SITE_ID + '/realtime/events?topic=presence', {
    headers: { authorization: 'Bearer ' + TOKEN }
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const ready = await reader.read();
  assert.match(new TextDecoder().decode(ready.value), /event: connection\.ready/);
  assert.equal(limiter.activeCount, 1);

  await server.systemfabric.close();
  assert.equal(limiter.activeCount, 0);
  const shutdownFrame = await reader.read();
  assert.match(new TextDecoder().decode(shutdownFrame.value), /server-shutdown/);
  const ended = await reader.read();
  assert.equal(ended.done, true);
});
