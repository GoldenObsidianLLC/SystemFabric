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
  oversized.send(JSON.stringify({ type: 'ping', padding: 'x'.repeat(20_000) }));
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

test('two WebSocket sessions join the same draft, receive committed operations, and leave cleanly', async t => {
  const contentId = '22222222-2222-4222-8222-222222222222';
  const operation = {
    schemaVersion: 1,
    opId: '33333333-3333-4333-8333-333333333333',
    clientId: 'browser-a',
    baseSequence: 0,
    type: 'document.set_title',
    payload: { title: 'Shared title' }
  };
  const content = {
    id: contentId,
    site_id: SITE_ID,
    content_type: 'page',
    status: 'draft',
    created_by: null,
    body: { schemaVersion: 1, documentId: 'doc-test', type: 'page', title: 'Before', children: [] }
  };
  const store = {
    async getById({ siteId, id }) { return siteId === SITE_ID && id === contentId ? content : null; },
    async getCollaborationSync({ afterSequence }) {
      return { reloadRequired: false, sequence: 0, oldestReplaySequence: 0, operations: [] };
    },
    async applyCollaborationOperation({ operation: submitted, actorId }) {
      assert.equal(actorId, null, 'developer identity must not be trusted from the command envelope');
      return {
        sequence: 1, version: 2, lockVersion: 2, title: submitted.payload.title,
        operation: submitted, duplicate: false
      };
    }
  };
  const { url, origin, server } = await createServer(t, { contentStore: store });
  const first = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  const second = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => { first.close(); second.close(); });
  await nextMessage(first);
  await nextMessage(second);

  first.send(JSON.stringify({ type: 'document.join', contentId, afterSequence: 0 }));
  second.send(JSON.stringify({ type: 'document.join', contentId, afterSequence: 0 }));
  const joinedA = await nextMessage(first);
  const joinedB = await nextMessage(second);
  assert.equal(joinedA.type, 'document.joined');
  assert.equal(joinedA.sequence, 0);
  assert.equal(joinedB.type, 'document.joined');

  first.send(JSON.stringify({ type: 'document.operation', contentId, operation }));
  const ack = await nextMessage(first);
  assert.equal(ack.type, 'document.operation.ack');
  assert.equal(ack.sequence, 1);
  assert.equal(ack.operation.payload.title, 'Shared title', 'the acknowledgement carries the committed transformed operation');
  const event = await nextMessage(second);
  assert.equal(event.type, 'document.operation');
  assert.equal(event.contentId, contentId);
  assert.equal(event.sequence, 1);
  assert.equal(event.operation.payload.title, 'Shared title');

  second.send(JSON.stringify({ type: 'document.leave', contentId }));
  assert.equal((await nextMessage(second)).type, 'document.left');
  assert.equal(server.systemfabric.realtimeHub.subscriberCount, 3, 'the first session still holds its document subscription');
});

test('WebSocket document subscription rejects missing, non-draft, and oversized document operations', async t => {
  const contentId = '22222222-2222-4222-8222-222222222222';
  let status = 'draft';
  const store = {
    async getById({ siteId, id }) {
      if (siteId !== SITE_ID || id !== contentId) return null;
      return { id, site_id: SITE_ID, content_type: 'page', status, created_by: null };
    },
    async getCollaborationSync() {
      return { reloadRequired: false, sequence: 0, oldestReplaySequence: 0, operations: [] };
    },
    async applyCollaborationOperation() {
      const error = new Error('operation too large');
      error.statusCode = 400;
      error.code = 'ERR_SYSTEMFABRIC_INVALID_COLLABORATION_OPERATION';
      throw error;
    }
  };
  const { url, origin } = await createServer(t, { contentStore: store });
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => socket.close());
  await nextMessage(socket);

  socket.send(JSON.stringify({ type: 'document.join', contentId: '33333333-3333-4333-8333-333333333333', afterSequence: 0 }));
  const missing = await nextMessage(socket);
  assert.equal(missing.type, 'document.error');
  assert.equal(missing.code, 'ERR_SYSTEMFABRIC_REALTIME_FORBIDDEN');

  status = 'published';
  socket.send(JSON.stringify({ type: 'document.join', contentId, afterSequence: 0 }));
  const notDraft = await nextMessage(socket);
  assert.equal(notDraft.type, 'document.error');
  assert.equal(notDraft.code, 'ERR_SYSTEMFABRIC_REALTIME_FORBIDDEN');

  status = 'draft';
  socket.send(JSON.stringify({ type: 'document.join', contentId, afterSequence: 0 }));
  assert.equal((await nextMessage(socket)).type, 'document.joined');
  socket.send(JSON.stringify({
    type: 'document.operation',
    contentId,
    operation: {
      schemaVersion: 1,
      opId: '55555555-5555-4555-8555-555555555555',
      clientId: 'oversized-client',
      baseSequence: 0,
      type: 'text.insert',
      payload: { nodeId: 'text-1', key: 'text', offset: 0, text: 'x'.repeat(13_000) }
    }
  }));
  const oversizedOperation = await nextMessage(socket);
  assert.equal(oversizedOperation.type, 'document.error');
  assert.equal(oversizedOperation.code, 'ERR_SYSTEMFABRIC_INVALID_COLLABORATION_OPERATION');
});

test('WebSocket document collaboration requires an active session and edit or edit-own capability', async t => {
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const otherId = '33333333-3333-4333-8333-333333333333';
  let active = true;
  const identityService = {
    async authenticate(token) {
      if (token !== 'editor-session-token') return null;
      return {
        sessionId: 'editor-session',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'editor@example.test', status: 'active' },
        memberships: [{ siteId: SITE_ID, capabilities: ['content:read', 'content:edit:own'] }]
      };
    },
    async isSessionActive({ userId, sessionId }) {
      return active && userId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' && sessionId === 'editor-session';
    },
    async authorizeSite(_userId, _siteId, capability) {
      return capability === 'content:read' || capability === 'content:edit:own';
    }
  };
  const store = {
    async getById({ siteId, id }) {
      if (siteId !== SITE_ID || ![ownerId, otherId].includes(id)) return null;
      return {
        id, site_id: SITE_ID, content_type: 'page', status: 'draft',
        created_by: id === ownerId ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      };
    },
    async getCollaborationSync() {
      return { reloadRequired: false, sequence: 0, oldestReplaySequence: 0, operations: [] };
    },
    async applyCollaborationOperation() {
      return { sequence: 1, version: 2, lockVersion: 2, duplicate: false };
    }
  };
  const { url, origin } = await createServer(t, { identityService, contentStore: store });
  const socket = await connect(url, { authorization: 'Bearer editor-session-token', origin });
  t.after(() => socket.close());
  await nextMessage(socket);

  socket.send(JSON.stringify({ type: 'document.join', contentId: ownerId, afterSequence: 0 }));
  assert.equal((await nextMessage(socket)).type, 'document.joined');

  socket.send(JSON.stringify({ type: 'document.join', contentId: otherId, afterSequence: 0 }));
  const denied = await nextMessage(socket);
  assert.equal(denied.type, 'document.error');
  assert.equal(denied.code, 'ERR_SYSTEMFABRIC_REALTIME_FORBIDDEN');

  active = false;
  const revoked = new Promise(resolve => socket.once('close', code => resolve(code)));
  socket.send(JSON.stringify({
    type: 'document.operation',
    contentId: ownerId,
    operation: {
      schemaVersion: 1,
      opId: '44444444-4444-4444-8444-444444444444',
      clientId: 'browser-editor',
      baseSequence: 0,
      type: 'document.set_title',
      payload: { title: 'Should not be accepted' }
    }
  }));
  assert.equal(await revoked, 1008, 'revocation of the authenticated session closes the WebSocket');


});

test('WebSocket collaboration returns canonical reload data or a bounded REST reload instruction', async t => {
  const contentId = '22222222-2222-4222-8222-222222222222';
  const snapshot = {
    schemaVersion: 1,
    documentId: 'doc-reload',
    type: 'page',
    title: 'Canonical reload',
    children: []
  };
  const store = {
    async getById({ siteId, id }) {
      return siteId === SITE_ID && id === contentId
        ? { id, site_id: SITE_ID, content_type: 'page', status: 'draft', created_by: null }
        : null;
    },
    async getCollaborationSync() {
      return {
        reloadRequired: true,
        sequence: 1200,
        oldestReplaySequence: 200,
        document: snapshot,
        title: snapshot.title,
        version: 4,
        lockVersion: 6
      };
    },
    async applyCollaborationOperation() { throw new Error('should not be reached'); }
  };
  const { url, origin } = await createServer(t, { contentStore: store });
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => socket.close());
  await nextMessage(socket);
  socket.send(JSON.stringify({ type: 'document.join', contentId, afterSequence: 0 }));
  const joined = await nextMessage(socket);
  assert.equal(joined.type, 'document.joined');
  assert.equal(joined.reloadRequired, true);
  const reload = await nextMessage(socket);
  assert.equal(reload.type, 'document.reload');
  assert.deepEqual(reload.document, snapshot);
  assert.equal(reload.sequence, 1200);
});

test('WebSocket join replays accepted operations and isolates delivery by document topic', async t => {
  const firstId = '22222222-2222-4222-8222-222222222222';
  const secondId = '33333333-3333-4333-8333-333333333333';
  const replayedOperation = {
    schemaVersion: 1,
    opId: '44444444-4444-4444-8444-444444444444',
    clientId: 'prior-editor',
    baseSequence: 0,
    type: 'document.set_title',
    payload: { title: 'Replayed title' }
  };
  const submittedOperation = {
    schemaVersion: 1,
    opId: '55555555-5555-4555-8555-555555555555',
    clientId: 'first-editor',
    baseSequence: 0,
    type: 'document.set_title',
    payload: { title: 'First document only' }
  };
  const store = {
    async getById({ siteId, id }) {
      return siteId === SITE_ID && [firstId, secondId].includes(id)
        ? { id, site_id: SITE_ID, content_type: 'page', status: 'draft', created_by: null }
        : null;
    },
    async getCollaborationSync({ contentId, afterSequence }) {
      if (contentId === secondId && afterSequence === 0) {
        return {
          reloadRequired: false,
          sequence: 1,
          oldestReplaySequence: 0,
          operations: [{ sequence: 1, operation: replayedOperation, appliedOperation: replayedOperation }]
        };
      }
      return { reloadRequired: false, sequence: 0, oldestReplaySequence: 0, operations: [] };
    },
    async applyCollaborationOperation({ operation }) {
      return { sequence: 1, version: 2, lockVersion: 2, operation, duplicate: false };
    }
  };
  const { url, origin } = await createServer(t, { contentStore: store });
  const first = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  const second = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => { first.close(); second.close(); });
  await nextMessage(first);
  await nextMessage(second);

  first.send(JSON.stringify({ type: 'document.join', contentId: firstId, afterSequence: 0 }));
  second.send(JSON.stringify({ type: 'document.join', contentId: secondId, afterSequence: 0 }));
  assert.equal((await nextMessage(first)).type, 'document.joined');
  assert.equal((await nextMessage(second)).type, 'document.joined');
  const replay = await nextMessage(second);
  assert.equal(replay.type, 'document.sync.operation');
  assert.equal(replay.sequence, 1);
  assert.equal(replay.operation.payload.title, 'Replayed title');

  first.send(JSON.stringify({ type: 'document.operation', contentId: firstId, operation: submittedOperation }));
  assert.equal((await nextMessage(first)).type, 'document.operation.ack');
  await assert.rejects(nextMessage(first, 100), /Timed out waiting for WebSocket message/);
  await assert.rejects(
    nextMessage(second, 100),
    /Timed out waiting for WebSocket message/
  );
});

test('WebSocket disconnect releases both the base and document subscriptions', async t => {
  const contentId = '22222222-2222-4222-8222-222222222222';
  const store = {
    async getById({ siteId, id }) {
      return siteId === SITE_ID && id === contentId
        ? { id, site_id: SITE_ID, content_type: 'page', status: 'draft', created_by: null }
        : null;
    },
    async getCollaborationSync() {
      return { reloadRequired: false, sequence: 0, oldestReplaySequence: 0, operations: [] };
    }
  };
  const { url, origin, server } = await createServer(t, { contentStore: store });
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  await nextMessage(socket);
  socket.send(JSON.stringify({ type: 'document.join', contentId, afterSequence: 0 }));
  assert.equal((await nextMessage(socket)).type, 'document.joined');
  assert.equal(server.systemfabric.realtimeHub.subscriberCount, 2);
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.close();
  await closed;
  for (let attempt = 0; attempt < 20 && server.systemfabric.realtimeHub.subscriberCount !== 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(server.systemfabric.realtimeHub.subscriberCount, 0);
});

test('WebSocket committed operations use the shared publisher and report degraded relay after commit', async t => {
  const contentId = '22222222-2222-4222-8222-222222222222';
  const operation = {
    schemaVersion: 1,
    opId: '33333333-3333-4333-8333-333333333333',
    clientId: 'browser-editor',
    baseSequence: 0,
    type: 'document.set_title',
    payload: { title: 'Shared publisher' }
  };
  const publications = [];
  const store = {
    async getById({ siteId, id }) {
      return siteId === SITE_ID && id === contentId
        ? {
          id, site_id: SITE_ID, content_type: 'page', status: 'draft',
          created_by: null,
          body: { schemaVersion: 1, documentId: 'doc-publisher', type: 'page', title: 'Before', children: [] }
        }
        : null;
    },
    async getCollaborationSync() {
      return { reloadRequired: false, sequence: 0, oldestReplaySequence: 0, operations: [] };
    },
    async applyCollaborationOperation({ operation: submitted }) {
      return {
        sequence: 1, version: 2, lockVersion: 2,
        operation: submitted, duplicate: false
      };
    }
  };
  const { url, origin } = await createServer(t, {
    contentStore: store,
    publishDocumentOperation: async input => {
      publications.push(input);
      return { relayPublished: false, degraded: true };
    }
  });
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => socket.close());
  await nextMessage(socket);

  socket.send(JSON.stringify({ type: 'document.join', contentId, afterSequence: 0 }));
  assert.equal((await nextMessage(socket)).type, 'document.joined');

  socket.send(JSON.stringify({ type: 'document.operation', contentId, operation }));
  const ack = await nextMessage(socket);
  assert.equal(ack.type, 'document.operation.ack');
  assert.equal(ack.sequence, 1);
  assert.equal(ack.fanoutDegraded, true);
  assert.deepEqual(ack.operation, operation);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].siteId, SITE_ID);
  assert.equal(publications[0].contentId, contentId);
  assert.equal(publications[0].sequence, 1);
  assert.match(publications[0].originConnectionId, /^[0-9a-f-]{36}$/i);
  assert.equal(publications[0].operation.opId, operation.opId);
});


test('document heartbeat reconciles a lost final notification and shares single-flight sync with sequence-gap recovery', async t => {
  const contentId = '22222222-2222-4222-8222-222222222222';
  const operationOne = {
    schemaVersion: 1,
    opId: '33333333-3333-4333-8333-333333333333',
    clientId: 'heartbeat-a',
    baseSequence: 0,
    type: 'document.set_title',
    payload: { title: 'Recovered first operation' }
  };
  const operationTwo = {
    schemaVersion: 1,
    opId: '44444444-4444-4444-8444-444444444444',
    clientId: 'heartbeat-b',
    baseSequence: 1,
    type: 'document.set_title',
    payload: { title: 'Recovered second operation' }
  };
  let syncCalls = 0;
  let activeSyncCalls = 0;
  let maxActiveSyncCalls = 0;
  let releasePendingSync;
  let signalPendingSync;
  const pendingSync = new Promise(resolve => { releasePendingSync = resolve; });
  const pendingSyncStarted = new Promise(resolve => { signalPendingSync = resolve; });
  const store = {
    async getById({ siteId, id }) {
      return siteId === SITE_ID && id === contentId
        ? {
          id, site_id: SITE_ID, content_type: 'page', status: 'draft', created_by: null,
          body: { schemaVersion: 1, documentId: 'heartbeat-doc', type: 'page', title: 'Before', children: [] }
        }
        : null;
    },
    async getCollaborationSync() {
      syncCalls += 1;
      activeSyncCalls += 1;
      maxActiveSyncCalls = Math.max(maxActiveSyncCalls, activeSyncCalls);
      try {
        if (syncCalls === 1) {
          return { reloadRequired: false, sequence: 0, oldestReplaySequence: 0, operations: [] };
        }
        if (syncCalls === 2) {
          const error = new Error('temporary PostgreSQL sync outage');
          error.code = 'ERR_TEST_TRANSIENT_SYNC';
          throw error;
        }
        if (syncCalls === 3) {
          signalPendingSync();
          await pendingSync;
          return {
            reloadRequired: false,
            sequence: 2,
            oldestReplaySequence: 0,
            operations: [
              { sequence: 1, operation: operationOne, appliedOperation: operationOne },
              { sequence: 2, operation: operationTwo, appliedOperation: operationTwo }
            ]
          };
        }
        throw new Error('unexpected overlapping reconciliation query');
      } finally {
        activeSyncCalls -= 1;
      }
    }
  };
  const { server, url, origin } = await createServer(t, {
    contentStore: store,
    realtimeHeartbeatMs: 5_000
  });
  const socket = await connect(url, { authorization: 'Bearer ' + TOKEN, origin });
  t.after(() => socket.close());
  await nextMessage(socket);

  socket.send(JSON.stringify({ type: 'document.join', contentId, afterSequence: 0 }));
  assert.equal((await nextMessage(socket)).type, 'document.joined');
  assert.equal(syncCalls, 1, 'join takes the initial canonical sync');

  // No operation event is published after this point. A missed final Redis hint
  // must be repaired by the periodic heartbeat even though the socket stays open.
  const degraded = await nextMessage(socket, 7_000);
  assert.equal(degraded.type, 'document.sync.degraded');
  assert.equal(degraded.contentId, contentId);
  assert.equal(socket.readyState, WebSocket.OPEN, 'a transient database sync failure does not close the base WebSocket');

  await Promise.race([
    pendingSyncStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat did not start the next sync')), 6_000))
  ]);
  assert.equal(syncCalls, 3);
  assert.equal(activeSyncCalls, 1);

  // A sequence-2 Pub/Sub event arrives while the heartbeat reconciliation is
  // pending. The gateway must share the same promise, not issue another query.
  await server.systemfabric.realtimeHub.publish({
    siteId: SITE_ID,
    topic: 'document:' + contentId,
    payload: {
      kind: 'document.operation',
      sequence: 2,
      originConnectionId: null,
      operation: operationTwo
    }
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(syncCalls, 3, 'gap recovery and heartbeat share the single in-flight PostgreSQL sync');
  assert.equal(maxActiveSyncCalls, 1);

  releasePendingSync();
  const firstRecovered = await nextMessage(socket, 2_000);
  const secondRecovered = await nextMessage(socket, 2_000);
  assert.equal(firstRecovered.type, 'document.sync.operation');
  assert.equal(firstRecovered.sequence, 1);
  assert.equal(firstRecovered.operation.payload.title, 'Recovered first operation');
  assert.equal(secondRecovered.type, 'document.sync.operation');
  assert.equal(secondRecovered.sequence, 2);
  assert.equal(secondRecovered.operation.payload.title, 'Recovered second operation');

  await assert.rejects(
    nextMessage(socket, 150),
    /Timed out waiting for WebSocket message/,
    'the Pub/Sub hint that initiated gap recovery is not delivered a second time'
  );
  assert.equal(socket.readyState, WebSocket.OPEN);
  const counters = server.systemfabric.realtimeMetrics.counters;
  assert.equal(counters.document_sync_failures_total, 1);
  assert.equal(counters.document_sync_reconciliations_total, 2);
  assert.equal(counters.document_sync_recovered_operations_total, 2);
});
