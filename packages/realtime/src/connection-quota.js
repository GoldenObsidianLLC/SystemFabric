'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { SITE_ID_RE, realtimeError } = require('./event-hub');

const DEFAULT_LIMITS = Object.freeze({
  maxGlobal: 10_000,
  maxPerSite: 500,
  maxPerPrincipal: 4
});
const KEY_PREFIX_RE = /^[A-Za-z0-9:_-]{1,96}$/;

const ACQUIRE_SCRIPT = `-- SF_REALTIME_QUOTA_ACQUIRE
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local maxGlobal = tonumber(ARGV[3])
local maxSite = tonumber(ARGV[4])
local maxPrincipal = tonumber(ARGV[5])
local connectionId = ARGV[6]
local ttl = tonumber(ARGV[7])
for i = 1, 3 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
end
local globalCount = redis.call('ZCARD', KEYS[1])
local siteCount = redis.call('ZCARD', KEYS[2])
local principalCount = redis.call('ZCARD', KEYS[3])
if globalCount >= maxGlobal then return {0, 1} end
if siteCount >= maxSite then return {0, 2} end
if principalCount >= maxPrincipal then return {0, 3} end
for i = 1, 3 do
  redis.call('ZADD', KEYS[i], expiresAt, connectionId)
  redis.call('PEXPIRE', KEYS[i], ttl)
end
return {1, globalCount + 1, siteCount + 1, principalCount + 1}`;

const RENEW_SCRIPT = `-- SF_REALTIME_QUOTA_RENEW
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local connectionId = ARGV[3]
local ttl = tonumber(ARGV[4])
for i = 1, 3 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
end
for i = 1, 3 do
  if not redis.call('ZSCORE', KEYS[i], connectionId) then
    for j = 1, 3 do redis.call('ZREM', KEYS[j], connectionId) end
    return 0
  end
end
for i = 1, 3 do
  redis.call('ZADD', KEYS[i], 'XX', expiresAt, connectionId)
  redis.call('PEXPIRE', KEYS[i], ttl)
end
return 1`;

const RELEASE_SCRIPT = `-- SF_REALTIME_QUOTA_RELEASE
local connectionId = ARGV[1]
local ttl = tonumber(ARGV[2])
for i = 1, 3 do
  redis.call('ZREM', KEYS[i], connectionId)
  if redis.call('ZCARD', KEYS[i]) == 0 then
    redis.call('DEL', KEYS[i])
  else
    redis.call('PEXPIRE', KEYS[i], ttl)
  end
end
return 1`;

function incrementMetric(metrics, name, amount = 1) {
  try { metrics?.increment?.(name, amount); } catch {}
}

function normalizeOptions({ limits = {}, leaseMs = 45_000, now = Date.now } = {}) {
  const normalizedLimits = {
    maxGlobal: limits.maxGlobal ?? DEFAULT_LIMITS.maxGlobal,
    maxPerSite: limits.maxPerSite ?? DEFAULT_LIMITS.maxPerSite,
    maxPerPrincipal: limits.maxPerPrincipal ?? DEFAULT_LIMITS.maxPerPrincipal
  };
  for (const [name, value] of Object.entries(normalizedLimits)) {
    if (!Number.isInteger(value) || value < 1 || value > 100_000) {
      throw new RangeError(name + ' must be an integer between 1 and 100000.');
    }
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 300_000) {
    throw new RangeError('leaseMs must be between 5000 and 300000.');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  return { limits: normalizedLimits, leaseMs, now };
}

function validateScope({ siteId, principalId }) {
  if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) {
    throw realtimeError(400, 'ERR_SYSTEMFABRIC_REALTIME_SITE_INVALID', 'A valid siteId is required for a real-time connection.');
  }
  if (typeof principalId !== 'string' || !principalId.trim() || principalId.trim().length > 128) {
    throw realtimeError(401, 'ERR_SYSTEMFABRIC_REALTIME_PRINCIPAL_REQUIRED', 'An authenticated principal is required for a real-time connection.');
  }
  return { siteId: siteId.toLowerCase(), principalId: principalId.trim() };
}

function quotaError(scope) {
  const error = realtimeError(429, 'ERR_SYSTEMFABRIC_REALTIME_CONNECTION_LIMIT', 'The real-time connection quota has been reached.');
  error.limitScope = scope;
  return error;
}

function createMemoryRealtimeConnectionLimiter(options = {}) {
  const { limits, leaseMs, now } = normalizeOptions(options);
  const leases = new Map();
  let closed = false;

  function prune() {
    const timestamp = now();
    for (const [id, lease] of leases) {
      if (lease.expiresAt <= timestamp) {
        leases.delete(id);
        incrementMetric(options.metrics, 'connection_quota_expirations_total');
      }
    }
  }

  function counts(scope) {
    let global = 0;
    let site = 0;
    let principal = 0;
    for (const lease of leases.values()) {
      global += 1;
      if (lease.siteId === scope.siteId) site += 1;
      if (lease.principalId === scope.principalId) principal += 1;
    }
    return { global, site, principal };
  }

  async function acquire(input) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_QUOTA_CLOSED', 'The real-time connection quota adapter is closed.');
    const scope = validateScope(input || {});
    prune();
    const current = counts(scope);
    if (current.global >= limits.maxGlobal) {
      incrementMetric(options.metrics, 'connection_quota_rejections_total');
      throw quotaError('global');
    }
    if (current.site >= limits.maxPerSite) {
      incrementMetric(options.metrics, 'connection_quota_rejections_total');
      throw quotaError('site');
    }
    if (current.principal >= limits.maxPerPrincipal) {
      incrementMetric(options.metrics, 'connection_quota_rejections_total');
      throw quotaError('principal');
    }

    const id = randomUUID();
    leases.set(id, { ...scope, expiresAt: now() + leaseMs });
    incrementMetric(options.metrics, 'connection_quota_acquires_total');
    let released = false;

    return Object.freeze({
      id,
      async renew() {
        if (released || closed) return false;
        prune();
        const lease = leases.get(id);
        if (!lease) return false;
        lease.expiresAt = now() + leaseMs;
        incrementMetric(options.metrics, 'connection_quota_renewals_total');
        return true;
      },
      async release() {
        if (released) return;
        released = true;
        if (leases.delete(id)) incrementMetric(options.metrics, 'connection_quota_releases_total');
      }
    });
  }

  async function close() {
    closed = true;
    leases.clear();
  }

  return Object.freeze({
    acquire,
    close,
    get activeCount() { prune(); return leases.size; },
    get isReady() { return !closed; }
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createRedisRealtimeConnectionLimiter({
  url,
  limits,
  leaseMs = 45_000,
  keyPrefix = 'systemfabric:realtime:v1:connections',
  createClient: createClientOverride,
  now = Date.now,
  metrics = null
} = {}) {
  if (typeof url !== 'string' || !url) {
    throw new Error('A Redis URL is required for distributed real-time connection quotas.');
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    throw new TypeError('The real-time quota Redis URL must be valid.');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new TypeError('The real-time quota Redis URL must use redis:// or rediss://.');
  }
  if (typeof keyPrefix !== 'string' || !KEY_PREFIX_RE.test(keyPrefix)) {
    throw new TypeError('keyPrefix must be a 1-96 character Redis-safe prefix.');
  }
  const normalized = normalizeOptions({ limits, leaseMs, now });
  const createClient = createClientOverride || require('redis').createClient;
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy(retries) {
        incrementMetric(metrics, 'redis_reconnect_attempts_total');
        if (retries > 10) return new Error('Redis real-time quota reconnect limit reached.');
        return Math.min(100 * (2 ** Math.min(retries, 5)), 2_000);
      }
    }
  });
  client.on?.('error', () => incrementMetric(metrics, 'connection_quota_store_errors_total'));

  try {
    await client.connect();
  } catch {
    try {
      if (client.isOpen && typeof client.quit === 'function') await client.quit();
      else client.destroy?.();
    } catch { client.destroy?.(); }
    incrementMetric(metrics, 'connection_quota_store_errors_total');
    throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_QUOTA_UNAVAILABLE', 'The distributed real-time connection quota store is unavailable.');
  }

  // Keep the multi-key Lua operation in one Redis Cluster hash slot.
  const hashSlotPrefix = keyPrefix + ':{quota}:';
  const globalKey = hashSlotPrefix + 'global';
  const ttl = normalized.leaseMs * 2;
  let closed = false;

  function keysFor(scope) {
    return [
      globalKey,
      hashSlotPrefix + 'site:' + digest(scope.siteId),
      hashSlotPrefix + 'principal:' + digest(scope.principalId)
    ];
  }

  async function runScript(script, keys, args) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_QUOTA_CLOSED', 'The real-time connection quota adapter is closed.');
    try {
      return await client.eval(script, { keys, arguments: args.map(value => String(value)) });
    } catch {
      incrementMetric(metrics, 'connection_quota_store_errors_total');
      throw realtimeError(503, 'ERR_SYSTEMFABRIC_REALTIME_QUOTA_UNAVAILABLE', 'The distributed real-time connection quota store is unavailable.');
    }
  }

  async function acquire(input) {
    const scope = validateScope(input || {});
    const id = randomUUID();
    const timestamp = normalized.now();
    const result = await runScript(ACQUIRE_SCRIPT, keysFor(scope), [
      timestamp,
      timestamp + normalized.leaseMs,
      normalized.limits.maxGlobal,
      normalized.limits.maxPerSite,
      normalized.limits.maxPerPrincipal,
      id,
      ttl
    ]);
    if (!Array.isArray(result) || Number(result[0]) !== 1) {
      const limitCode = Number(result?.[1]) === 1 ? 'global' : Number(result?.[1]) === 2 ? 'site' : 'principal';
      incrementMetric(metrics, 'connection_quota_rejections_total');
      throw quotaError(limitCode);
    }
    incrementMetric(metrics, 'connection_quota_acquires_total');
    const keys = keysFor(scope);
    let released = false;

    return Object.freeze({
      id,
      async renew() {
        if (released || closed) return false;
        const nowMs = normalized.now();
        const renewed = await runScript(RENEW_SCRIPT, keys, [nowMs, nowMs + normalized.leaseMs, id, ttl]);
        if (Number(renewed) === 1) {
          incrementMetric(metrics, 'connection_quota_renewals_total');
          return true;
        }
        incrementMetric(metrics, 'connection_quota_expirations_total');
        return false;
      },
      async release() {
        if (released) return;
        released = true;
        await runScript(RELEASE_SCRIPT, keys, [id, ttl]);
        incrementMetric(metrics, 'connection_quota_releases_total');
      }
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (client.isOpen && typeof client.quit === 'function') await client.quit();
      else client.destroy?.();
    } catch { client.destroy?.(); }
  }

  return Object.freeze({
    acquire,
    close,
    get isReady() { return !closed && Boolean(client.isReady ?? client.isOpen); }
  });
}

module.exports = {
  DEFAULT_LIMITS,
  createMemoryRealtimeConnectionLimiter,
  createRedisRealtimeConnectionLimiter
};
