'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../index');
const { connectWebTransport } = require('../transports/webtransport-client.mjs');

test('WebSocket preview adapter authorizes clients, renders safely, and bounds requests', async t => {
  const views = fs.mkdtempSync(path.join(os.tmpdir(), 'enginex-ws-'));
  fs.writeFileSync(path.join(views, 'page.html'), '<h1>{{ name }}</h1>');
  fs.writeFileSync(path.join(views, 'counter.html'), '<section data-enginex-fragment="count">{{#fragment "count"}}{{ notifications.count }}{{/fragment}}</section>');
  t.after(() => fs.rmSync(views, { recursive: true, force: true }));
  class WSS extends EventEmitter { constructor() { super(); this.clients = new Set(); } }
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = []; this.closed = null; }
    send(message) { this.sent.push(JSON.parse(message)); }
    close(code, reason) { this.closed = { code, reason }; this.readyState = 3; }
  }
  const wss = new WSS();
  engine.attachWebSocketLivePreview({ wss, engine, templateOptions: { views }, authorize: async () => ({ user: 'tester' }), maxMessageBytes: 1024 });
  const socket = new Socket();
  wss.emit('connection', socket, {});
  await new Promise(resolve => setTimeout(resolve, 0));
  socket.emit('message', JSON.stringify({ type: 'preview', template: 'page.html', revision: 3, data: { name: '<Admin>' } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(socket.sent[0].type, 'preview.result');
  assert.equal(socket.sent[0].html, '<h1>&lt;Admin&gt;</h1>');
  socket.emit('message', JSON.stringify({ type: 'preview', template: '../outside.html', data: {} }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(socket.sent[1].type, 'error');
  socket.emit('message', JSON.stringify({ type: 'incremental.start', sessionId: 'dashboard', template: 'counter.html', data: { notifications: { count: 1 } } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(socket.sent[2].type, 'incremental.result');
  assert.equal(socket.sent[2].result.type, 'full');
  socket.emit('message', JSON.stringify({ type: 'incremental.update', sessionId: 'dashboard', data: { notifications: { count: 2 } } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(socket.sent[3].result.type, 'patches');
  assert.deepEqual(socket.sent[3].result.patches.map(patch => patch.id), ['count']);
});

test('WebRTC wrapper sends typed JSON messages over an already negotiated channel', async () => {
  class MockChannel {
    constructor() { this.readyState = 'open'; this.bufferedAmount = 0; this.listeners = new Map(); this.sent = []; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    send(data) { this.sent.push(data); }
    emit(type, event) { for (const fn of this.listeners.get(type) || []) fn(event); }
  }
  const channel = new MockChannel();
  const wrapped = engine.wrapRtcDataChannel(channel, { maxMessageBytes: 128 });
  await wrapped.send({ type: 'patch', revision: 1 });
  assert.deepEqual(JSON.parse(channel.sent[0]), { type: 'patch', revision: 1 });
  const received = [];
  wrapped.onMessage(message => received.push(message));
  channel.emit('message', { data: JSON.stringify({ type: 'ack', revision: 1 }) });
  assert.deepEqual(received, [{ type: 'ack', revision: 1 }]);
  await assert.rejects(wrapped.send({ type: 'large', value: 'x'.repeat(200) }), /exceeds configured limit/);
  wrapped.close();
});

test('WebTransport client supports a loopback bidirectional stream and bounded messages', async () => {
  class MockWebTransport {
    constructor() { this.pair = new TransformStream(); this.ready = Promise.resolve(); this.closed = Promise.resolve(); }
    async createBidirectionalStream() { return { readable: this.pair.readable, writable: this.pair.writable }; }
    close() {}
  }
  const connection = await connectWebTransport('https://example.invalid/transport', { WebTransportClass: MockWebTransport, maxMessageBytes: 256 });
  const received = new Promise(resolve => connection.onMessage(resolve));
  await connection.send({ type: 'ping', revision: 2 });
  assert.deepEqual(await received, { type: 'ping', revision: 2 });
  await assert.rejects(connection.send({ type: 'large', value: 'x'.repeat(300) }), /exceeds configured limit/);
  await connection.close();
});
