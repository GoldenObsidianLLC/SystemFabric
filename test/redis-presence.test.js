'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_KEY_PREFIX,
  createRedisPresenceAdapter,
  createRedisPresenceService,
  UPSERT_SCRIPT,
  REMOVE_SCRIPT,
  LIST_SCRIPT
} = require('../packages/realtime/src/redis-presence');

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

function fakeClient({ replies = [], error = null } = {}) {
  const calls = [];
  return {
    calls,
    isOpen: true,
    async eval(script, options) {
      calls.push({ script, ...options });
      if (error) throw error;
      return replies.shift();
    },
    async quit() { this.isOpen = false; return 'OK'; },
    destroy() { this.isOpen = false; }
  };
}

test('Redis presence uses site-hash-tagged lease and index keys with opaque session members', async () => {
  const client = fakeClient({ replies: [[1, []]] });
  const now = 10_000;
  const adapter = createRedisPresenceAdapter({ client, keyPrefix: 'test:presence', now: () => now });
  await adapter.upsert({
    siteId: SITE_A,
    principalId: 'user-a',
    sessionId: 'session-one',
    availability: 'active',
    lastSeenAtMs: 10_000,
    expiresAtMs: 40_000
  });

  const call = client.calls[0];
  assert.equal(call.script, UPSERT_SCRIPT);
  assert.equal(call.keys.length, 2);
  assert.ok(call.keys.every(key => key.includes(`{${SITE_A}}`)));
  assert.match(call.keys[1], /lease:[a-f0-9]{64}$/);
  assert.doesNotMatch(call.keys[1], /user-a|session-one/);
  assert.equal(call.arguments[1], String(now));
  assert.equal(call.arguments[2], '10000');
  const stored = JSON.parse(call.arguments[3]);
  assert.equal(stored.siteId, SITE_A);
  assert.equal(stored.principalId, 'user-a');
  assert.equal(stored.sessionId, 'session-one');
  assert.equal(call.arguments[4], '60000');
  assert.equal(call.arguments[6], '30000');
  assert.match(call.script, /SET.*PX/);
  assert.match(call.script, /ZADD/);
  assert.match(call.script, /PEXPIREAT/);
  assert.equal(DEFAULT_KEY_PREFIX, 'systemfabric:presence:v1');
  await adapter.close();
});

test('Redis presence reads only a site-scoped index and validates stored records', async () => {
  const record = {
    siteId: SITE_A,
    principalId: 'user-a',
    sessionId: 'session-one',
    availability: 'hidden',
    lastSeenAtMs: 20_000,
    expiresAtMs: 50_000
  };
  const client = fakeClient({ replies: [[
    [JSON.stringify(record), '{invalid-json}', JSON.stringify({ ...record, siteId: SITE_B }),
      JSON.stringify({ siteId: SITE_A, sessionId: 'missing-principal', availability: 'active', lastSeenAtMs: 1, expiresAtMs: 2 })],
    []
  ]] });
  const adapter = createRedisPresenceAdapter({ client, keyPrefix: 'test:presence', now: () => 25_000 });
  const records = await adapter.listBySite({ siteId: SITE_A });
  assert.deepEqual(records, [record]);
  assert.equal(client.calls[0].script, LIST_SCRIPT);
  assert.deepEqual(client.calls[0].keys, [`test:presence:{${SITE_A}}:sessions`]);
  assert.equal(client.calls[0].arguments[1], `test:presence:{${SITE_A}}:lease:`);
  await adapter.close();
});

test('Redis presence removal deletes the scoped lease and sorted-set member', async () => {
  const client = fakeClient({ replies: [1] });
  const adapter = createRedisPresenceAdapter({ client });
  await adapter.remove({ siteId: SITE_B, principalId: 'user-b', sessionId: 'session-two' });
  assert.equal(client.calls[0].script, REMOVE_SCRIPT);
  assert.ok(client.calls[0].keys[0].includes(`{${SITE_B}}`));
  assert.ok(client.calls[0].keys[1].includes(`{${SITE_B}}`));
  assert.match(client.calls[0].arguments[0], /^[a-f0-9]{64}$/);
  await adapter.close();
});

test('Redis presence emits expiry notifications when a site index is swept', async () => {
  const expired = {
    siteId: SITE_A,
    principalId: 'user-expired',
    sessionId: 'session-expired',
    availability: 'away',
    lastSeenAtMs: 10_000,
    expiresAtMs: 15_000
  };
  const seen = [];
  const client = fakeClient({ replies: [[[], [JSON.stringify(expired)]]] });
  const adapter = createRedisPresenceAdapter({
    client,
    now: () => 20_000,
    onExpired: event => seen.push(event)
  });
  assert.deepEqual(await adapter.listBySite({ siteId: SITE_A }), []);
  assert.deepEqual(seen, [{
    siteId: SITE_A,
    principalId: 'user-expired',
    sessionId: 'session-expired',
    lastSeenAtMs: 10_000,
    expiredAtMs: 15_000
  }]);
  await adapter.close();
});

test('Redis presence maps per-site capacity rejection to a bounded service error', async () => {
  const client = fakeClient({ replies: [[-1, []]] });
  const adapter = createRedisPresenceAdapter({ client, maxEntriesPerSite: 1 });
  await assert.rejects(() => adapter.upsert({
    siteId: SITE_A,
    principalId: 'user-a',
    sessionId: 'session-two',
    availability: 'active',
    lastSeenAtMs: Date.now(),
    expiresAtMs: Date.now() + 30_000
  }), { code: 'ERR_SYSTEMFABRIC_PRESENCE_CAPACITY', statusCode: 503 });
  await adapter.close();
});

test('Redis presence fails closed on store errors and invalid scopes', async () => {
  const client = fakeClient({ error: Object.assign(new Error('private connection detail'), { code: 'ECONNRESET' }) });
  const adapter = createRedisPresenceAdapter({ client });
  await assert.rejects(() => adapter.listBySite({ siteId: SITE_A }), error =>
    error.code === 'ERR_SYSTEMFABRIC_PRESENCE_STORE_UNAVAILABLE' &&
    error.statusCode === 503 &&
    !error.message.includes('private connection detail')
  );
  await assert.rejects(() => adapter.remove({
    siteId: SITE_A, principalId: 'user-a', sessionId: 'session\r\n-injection'
  }), { code: 'ERR_SYSTEMFABRIC_PRESENCE_SCOPE_INVALID' });
  await adapter.close();
});

test('Redis presence service factory connects, uses bounded reconnect policy, and closes its owned client', async () => {
  const client = fakeClient();
  client.on = (event, handler) => { client.errorHandler = handler; };
  client.connect = async () => { client.connected = true; };
  const service = await createRedisPresenceService({
    url: 'redis://127.0.0.1:6379',
    createClient(options) {
      client.options = options;
      return client;
    }
  });
  assert.equal(client.connected, true);
  assert.equal(client.options.socket.connectTimeout, 5000);
  assert.equal(client.options.socket.reconnectStrategy(1), 100);
  assert.ok(client.options.socket.reconnectStrategy(99) instanceof Error);
  await service.close();
  assert.equal(client.isOpen, false);
});

test('Redis presence service factory rejects invalid URLs before opening a client', async () => {
  await assert.rejects(() => createRedisPresenceService({ url: 'http://127.0.0.1:6379' }), /redis:\/\/ or rediss:\/\//);
});
