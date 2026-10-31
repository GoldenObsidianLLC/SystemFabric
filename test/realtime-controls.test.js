'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let quota;
try { quota = require('../packages/realtime/src/connection-quota'); } catch { quota = {}; }

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

class FakeRedisQuotaClient {
  constructor() {
    this.isOpen = false;
    this.sortedSets = new Map();
    this.evalCalls = 0;
  }

  async connect() { this.isOpen = true; }
  async quit() { this.isOpen = false; }
  destroy() { this.isOpen = false; }

  async eval(script, { keys, arguments: args }) {
    this.evalCalls += 1;
    const sets = keys.map(key => {
      if (!this.sortedSets.has(key)) this.sortedSets.set(key, new Map());
      return this.sortedSets.get(key);
    });
    const now = Number(args[0]);
    for (const set of sets) {
      for (const [member, expiry] of set) if (expiry <= now) set.delete(member);
    }

    if (script.includes('SF_REALTIME_QUOTA_ACQUIRE')) {
      const [expiresAt, maxGlobal, maxSite, maxPrincipal, connectionId, ttl] = args.slice(1).map((value, index) => index < 5 ? (index < 4 ? Number(value) : value) : Number(value));
      if (sets[0].size >= maxGlobal) return [0, 'global'];
      if (sets[1].size >= maxSite) return [0, 'site'];
      if (sets[2].size >= maxPrincipal) return [0, 'principal'];
      for (const set of sets) set.set(connectionId, expiresAt);
      return [1, sets[0].size, sets[1].size, sets[2].size, ttl];
    }

    if (script.includes('SF_REALTIME_QUOTA_RENEW')) {
      const [expiresAt, connectionId] = args.slice(1);
      if (sets.some(set => !set.has(connectionId))) {
        for (const set of sets) set.delete(connectionId);
        return 0;
      }
      for (const set of sets) set.set(connectionId, Number(expiresAt));
      return 1;
    }

    if (script.includes('SF_REALTIME_QUOTA_RELEASE')) {
      const [connectionId] = args.slice(1);
      for (const set of sets) set.delete(connectionId);
      return 1;
    }

    throw new Error('Unexpected Redis quota script.');
  }
}

test('memory quota rejects global, per-site and per-principal excess connections', async () => {
  assert.equal(typeof quota.createMemoryRealtimeConnectionLimiter, 'function');

  const limiter = quota.createMemoryRealtimeConnectionLimiter({
    limits: { maxGlobal: 3, maxPerSite: 2, maxPerPrincipal: 1 },
    leaseMs: 5_000
  });
  const first = await limiter.acquire({ siteId: SITE_A, principalId: 'user-a' });
  await assert.rejects(
    limiter.acquire({ siteId: SITE_A, principalId: 'user-a' }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_CONNECTION_LIMIT'
  );

  const second = await limiter.acquire({ siteId: SITE_A, principalId: 'user-b' });
  await assert.rejects(
    limiter.acquire({ siteId: SITE_A, principalId: 'user-c' }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_CONNECTION_LIMIT'
  );

  const third = await limiter.acquire({ siteId: SITE_B, principalId: 'user-c' });
  await assert.rejects(
    limiter.acquire({ siteId: SITE_B, principalId: 'user-d' }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_CONNECTION_LIMIT'
  );

  await Promise.all([first.release(), second.release(), third.release()]);
  assert.equal(limiter.activeCount, 0);
  await limiter.close();
});

test('memory quota lease renewal fails after expiry and a stale release cannot remove a newer lease', async () => {
  assert.equal(typeof quota.createMemoryRealtimeConnectionLimiter, 'function');

  let now = 1_000;
  const limiter = quota.createMemoryRealtimeConnectionLimiter({
    limits: { maxGlobal: 2, maxPerSite: 2, maxPerPrincipal: 1 },
    leaseMs: 5_000,
    now: () => now
  });
  const expired = await limiter.acquire({ siteId: SITE_A, principalId: 'user-a' });
  now += 5_001;
  const current = await limiter.acquire({ siteId: SITE_A, principalId: 'user-a' });

  assert.equal(await expired.renew(), false);
  await expired.release();
  assert.equal(limiter.activeCount, 1);
  assert.equal(await current.renew(), true);
  await current.release();
  assert.equal(limiter.activeCount, 0);
  await limiter.close();
});

test('Redis quota adapter uses atomic leases for acquire, renew and release', async () => {
  assert.equal(typeof quota.createRedisRealtimeConnectionLimiter, 'function');

  const client = new FakeRedisQuotaClient();
  const limiter = await quota.createRedisRealtimeConnectionLimiter({
    url: 'redis://127.0.0.1:6379',
    limits: { maxGlobal: 2, maxPerSite: 2, maxPerPrincipal: 1 },
    leaseMs: 5_000,
    createClient: () => client,
    now: () => 1_000
  });

  const first = await limiter.acquire({ siteId: SITE_A, principalId: 'user-a' });
  await assert.rejects(
    limiter.acquire({ siteId: SITE_A, principalId: 'user-a' }),
    error => error.code === 'ERR_SYSTEMFABRIC_REALTIME_CONNECTION_LIMIT'
  );
  assert.equal(await first.renew(), true);
  await first.release();
  assert.equal(client.evalCalls, 4, 'acquire, rejected acquire, renew and release each run atomically');
  await limiter.close();
  assert.equal(client.isOpen, false);
});

test('Redis quota adapter fails closed when its backing store is unavailable', async () => {
  assert.equal(typeof quota.createRedisRealtimeConnectionLimiter, 'function');

  const client = new FakeRedisQuotaClient();
  const limiter = await quota.createRedisRealtimeConnectionLimiter({
    url: 'redis://127.0.0.1:6379',
    limits: { maxGlobal: 2, maxPerSite: 2, maxPerPrincipal: 1 },
    leaseMs: 5_000,
    createClient: () => client
  });
  client.eval = async () => { throw Object.assign(new Error('redis unavailable'), { code: 'ECONNRESET' }); };
  await assert.rejects(
    limiter.acquire({ siteId: SITE_A, principalId: 'user-a' }),
    error => error.statusCode === 503 && error.code === 'ERR_SYSTEMFABRIC_REALTIME_QUOTA_UNAVAILABLE'
  );
  await limiter.close();
});
