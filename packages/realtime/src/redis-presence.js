'use strict';

const { createHash } = require('node:crypto');
const { SITE_ID_RE, realtimeError } = require('./event-hub');
const { createPresenceService, AVAILABILITY } = require('./presence');

const DEFAULT_KEY_PREFIX = 'systemfabric:presence:v1';
const PRINCIPAL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_PREFIX_RE = /^[A-Za-z0-9:_-]{1,96}$/;

// Each site uses one Redis Cluster hash slot for its index and all session leases.
// Expired lease records are retained briefly so a caller can observe an expiry
// notification when the site next performs a heartbeat or presence snapshot.
const UPSERT_SCRIPT = `
local expiredMembers = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
local expired = {}
for _, member in ipairs(expiredMembers) do
  local value = redis.call('GET', ARGV[8] .. member)
  if value then table.insert(expired, value) end
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return { -1, expired }
end
redis.call('SET', KEYS[2], ARGV[4], 'PX', ARGV[5])
redis.call('ZADD', KEYS[1], ARGV[6], ARGV[1])
local newest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if newest[2] then redis.call('PEXPIREAT', KEYS[1], tonumber(newest[2]) + tonumber(ARGV[7])) end
return { 1, expired }
`;

const REMOVE_SCRIPT = `
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return 1
`;

const LIST_SCRIPT = `
local expiredMembers = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local expired = {}
for _, member in ipairs(expiredMembers) do
  local value = redis.call('GET', ARGV[2] .. member)
  if value then table.insert(expired, value) end
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
local values = {}
for _, member in ipairs(members) do
  local value = redis.call('GET', ARGV[2] .. member)
  if value then
    table.insert(values, value)
  else
    redis.call('ZREM', KEYS[1], member)
  end
end
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return { values, expired }
`;

function validateSiteId(siteId) {
  if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) {
    throw realtimeError(400, 'ERR_SYSTEMFABRIC_PRESENCE_SITE_INVALID', 'A valid siteId is required.');
  }
  return siteId.toLowerCase();
}

function validatePrincipalId(value, field) {
  if (typeof value !== 'string' || !PRINCIPAL_ID_RE.test(value)) {
    throw realtimeError(400, 'ERR_SYSTEMFABRIC_PRESENCE_SCOPE_INVALID', `${field} must be a safe identifier.`);
  }
}

function validateScope(scope) {
  const siteId = validateSiteId(scope?.siteId);
  validatePrincipalId(scope?.principalId, 'principalId');
  validatePrincipalId(scope?.sessionId, 'sessionId');
  return { siteId, principalId: scope.principalId, sessionId: scope.sessionId };
}

function createRedisPresenceAdapter({
  client,
  keyPrefix = DEFAULT_KEY_PREFIX,
  maxEntriesPerSite = 10_000,
  expiryRetentionMs = 30_000,
  onExpired = () => {},
  now = Date.now,
  closeClient = false
} = {}) {
  if (!client || typeof client.eval !== 'function') {
    throw new TypeError('A connected Redis-compatible client with eval() is required.');
  }
  if (typeof keyPrefix !== 'string' || !KEY_PREFIX_RE.test(keyPrefix)) {
    throw new TypeError('keyPrefix must be a 1-96 character Redis-safe prefix.');
  }
  if (!Number.isInteger(maxEntriesPerSite) || maxEntriesPerSite < 1 || maxEntriesPerSite > 100_000) {
    throw new RangeError('maxEntriesPerSite must be between 1 and 100000.');
  }
  if (!Number.isInteger(expiryRetentionMs) || expiryRetentionMs < 1_000 || expiryRetentionMs > 300_000) {
    throw new RangeError('expiryRetentionMs must be between 1000 and 300000.');
  }
  if (typeof onExpired !== 'function') throw new TypeError('onExpired must be a function.');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');

  let closed = false;

  function keysFor(siteId, principalId, sessionId) {
    // Hashing identifiers prevents them from appearing in Redis key names.
    const siteTag = `{${siteId}}`;
    const digest = createHash('sha256').update(principalId).update(Buffer.from([0])).update(sessionId).digest('hex');
    const base = `${keyPrefix}:${siteTag}`;
    return {
      indexKey: `${base}:sessions`,
      leaseKey: `${base}:lease:${digest}`,
      leasePrefix: `${base}:lease:`,
      member: digest
    };
  }

  function decodeRecord(value, siteId) {
    if (typeof value !== 'string') return null;
    try {
      const record = JSON.parse(value);
      if (record && !Array.isArray(record) && record.siteId === siteId &&
          typeof record.principalId === 'string' && PRINCIPAL_ID_RE.test(record.principalId) &&
          typeof record.sessionId === 'string' && PRINCIPAL_ID_RE.test(record.sessionId) &&
          AVAILABILITY.has(record.availability) &&
          Number.isSafeInteger(record.lastSeenAtMs) &&
          Number.isSafeInteger(record.expiresAtMs)) return record;
    } catch {}
    return null;
  }

  function notifyExpired(values, siteId) {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      const expired = decodeRecord(value, siteId);
      if (!expired) continue;
      try {
        const result = onExpired({
          siteId: expired.siteId,
          principalId: expired.principalId,
          sessionId: expired.sessionId,
          lastSeenAtMs: expired.lastSeenAtMs,
          expiredAtMs: expired.expiresAtMs
        });
        if (result && typeof result.then === 'function') result.catch(() => {});
      } catch {}
    }
  }

  async function evaluate(script, keys, args) {
    if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_PRESENCE_STORE_CLOSED', 'The shared presence store is closed.');
    try {
      return await client.eval(script, { keys, arguments: args.map(value => String(value)) });
    } catch {
      throw realtimeError(503, 'ERR_SYSTEMFABRIC_PRESENCE_STORE_UNAVAILABLE', 'The shared presence store is unavailable.');
    }
  }

  return Object.freeze({
    async upsert(record) {
      const scope = validateScope(record);
      if (!AVAILABILITY.has(record.availability)) {
        throw realtimeError(400, 'ERR_SYSTEMFABRIC_PRESENCE_AVAILABILITY_INVALID', 'availability must be active, idle, away or hidden.');
      }
      if (!Number.isSafeInteger(record.lastSeenAtMs) || !Number.isSafeInteger(record.expiresAtMs)) {
        throw realtimeError(400, 'ERR_SYSTEMFABRIC_PRESENCE_RECORD_INVALID', 'Presence timestamps must be safe integer milliseconds.');
      }
      const timestamp = now();
      const ttlMs = record.expiresAtMs - timestamp;
      if (ttlMs < 1 || ttlMs > 120_000) {
        throw realtimeError(400, 'ERR_SYSTEMFABRIC_PRESENCE_RECORD_INVALID', 'Presence lease must expire within 120 seconds.');
      }
      const key = keysFor(scope.siteId, scope.principalId, scope.sessionId);
      const payload = JSON.stringify({
        siteId: scope.siteId,
        principalId: scope.principalId,
        sessionId: scope.sessionId,
        availability: record.availability,
        lastSeenAtMs: record.lastSeenAtMs,
        expiresAtMs: record.expiresAtMs
      });
      const result = await evaluate(
        UPSERT_SCRIPT,
        [key.indexKey, key.leaseKey],
        [key.member, timestamp, maxEntriesPerSite, payload, ttlMs + expiryRetentionMs,
          record.expiresAtMs, expiryRetentionMs, key.leasePrefix]
      );
      if (!Array.isArray(result) || result.length !== 2) {
        throw realtimeError(503, 'ERR_SYSTEMFABRIC_PRESENCE_STORE_INVALID_RESPONSE', 'The shared presence store returned an invalid response.');
      }
      notifyExpired(result[1], scope.siteId);
      if (Number(result[0]) === -1) {
        throw realtimeError(503, 'ERR_SYSTEMFABRIC_PRESENCE_CAPACITY', 'The shared presence store has reached its per-site session limit.');
      }
      if (Number(result[0]) !== 1) {
        throw realtimeError(503, 'ERR_SYSTEMFABRIC_PRESENCE_STORE_INVALID_RESPONSE', 'The shared presence store rejected the session lease.');
      }
    },

    async remove(scope) {
      const safeScope = validateScope(scope);
      const key = keysFor(safeScope.siteId, safeScope.principalId, safeScope.sessionId);
      await evaluate(REMOVE_SCRIPT, [key.indexKey, key.leaseKey], [key.member]);
    },

    async listBySite({ siteId }) {
      const safeSiteId = validateSiteId(siteId);
      const base = `${keyPrefix}:{${safeSiteId}}`;
      const indexKey = `${base}:sessions`;
      const leasePrefix = `${base}:lease:`;
      const result = await evaluate(LIST_SCRIPT, [indexKey], [now(), leasePrefix]);
      if (!Array.isArray(result) || result.length !== 2 ||
          !Array.isArray(result[0]) || !Array.isArray(result[1])) {
        throw realtimeError(503, 'ERR_SYSTEMFABRIC_PRESENCE_STORE_INVALID_RESPONSE', 'The shared presence store returned an invalid response.');
      }
      notifyExpired(result[1], safeSiteId);
      return result[0]
        .map(value => decodeRecord(value, safeSiteId))
        .filter(record => record && record.expiresAtMs > now());
    },

    async close() {
      if (closed) return;
      closed = true;
      if (closeClient) {
        try {
          if (client.isOpen && typeof client.quit === 'function') await client.quit();
          else client.destroy?.();
        } catch {
          client.destroy?.();
        }
      }
    }
  });
}

async function createRedisPresenceService({
  url,
  keyPrefix = DEFAULT_KEY_PREFIX,
  maxEntriesPerSite = 10_000,
  leaseMs = 30_000,
  expiryRetentionMs = 30_000,
  onExpired = () => {},
  now = Date.now,
  onError = () => {},
  createClient: createClientOverride
} = {}) {
  if (typeof url !== 'string' || !url) {
    throw new Error('SYSTEMFABRIC_PRESENCE_REDIS_URL is required when the Redis presence store is selected.');
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    throw new Error('SYSTEMFABRIC_PRESENCE_REDIS_URL must be a valid redis:// or rediss:// URL.');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('SYSTEMFABRIC_PRESENCE_REDIS_URL must use redis:// or rediss://.');
  }
  if (typeof onExpired !== 'function' || typeof onError !== 'function') {
    throw new TypeError('onExpired and onError must be functions.');
  }
  const createClient = createClientOverride || require('redis').createClient;
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy(retries) {
        if (retries > 10) return new Error('Redis presence reconnect limit reached.');
        return Math.min(100 * retries, 2_000);
      }
    }
  });
  client.on?.('error', error => {
    try { onError({ errorCode: String(error?.code || 'ERR_REDIS_CONNECTION').slice(0, 100) }); } catch {}
  });
  try {
    await client.connect();
  } catch (error) {
    client.destroy?.();
    throw new Error(`Could not connect to the configured Redis presence store (${String(error?.code || 'connection failed')}).`);
  }
  try {
    const adapter = createRedisPresenceAdapter({
      client,
      keyPrefix,
      maxEntriesPerSite,
      expiryRetentionMs,
      onExpired,
      now,
      closeClient: true
    });
    return createPresenceService({ adapter, leaseMs, now });
  } catch (error) {
    if (client.isOpen && typeof client.quit === 'function') await client.quit().catch(() => {});
    else client.destroy?.();
    throw error;
  }
}

module.exports = {
  DEFAULT_KEY_PREFIX,
  createRedisPresenceAdapter,
  createRedisPresenceService,
  UPSERT_SCRIPT,
  REMOVE_SCRIPT,
  LIST_SCRIPT
};
