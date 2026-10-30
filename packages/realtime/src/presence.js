'use strict';

const { SITE_ID_RE, realtimeError } = require('./event-hub');

const AVAILABILITY = new Set(['active', 'idle', 'away', 'hidden']);
const AVAILABILITY_RANK = Object.freeze({ hidden: 0, away: 1, idle: 2, active: 3 });

function validPrincipalId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function validatePresenceScope({ siteId, principalId, sessionId }) {
  if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) {
    throw realtimeError(400, 'ERR_SYSTEMFABRIC_PRESENCE_SITE_INVALID', 'A valid siteId is required.');
  }
  if (!validPrincipalId(principalId)) {
    throw realtimeError(401, 'ERR_SYSTEMFABRIC_PRESENCE_PRINCIPAL_REQUIRED', 'An authenticated principal is required.');
  }
  if (!validPrincipalId(sessionId)) {
    throw realtimeError(400, 'ERR_SYSTEMFABRIC_PRESENCE_SESSION_INVALID', 'A valid server-issued session identifier is required.');
  }
}

/**
 * Process-local lease adapter for tests and single-instance developer preview.
 * It is deliberately not suitable for multi-process or production deployments.
 */
function createMemoryPresenceAdapter({ now = Date.now, maxEntries = 10_000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
    throw new RangeError('maxEntries must be between 1 and 100000.');
  }
  const entries = new Map();
  let closed = false;

  function keyOf({ siteId, principalId, sessionId }) {
    return [siteId, principalId, sessionId].join('\u0000');
  }

  function sweep() {
    const timestamp = now();
    for (const [key, record] of entries) {
      if (record.expiresAtMs <= timestamp) entries.delete(key);
    }
  }

  return Object.freeze({
    async upsert(record) {
      if (closed) throw realtimeError(503, 'ERR_SYSTEMFABRIC_PRESENCE_STORE_CLOSED', 'The presence store is closed.');
      sweep();
      const key = keyOf(record);
      if (!entries.has(key) && entries.size >= maxEntries) {
        throw realtimeError(503, 'ERR_SYSTEMFABRIC_PRESENCE_CAPACITY', 'The local presence store has reached its capacity.');
      }
      entries.set(key, { ...record });
    },
    async remove(scope) {
      entries.delete(keyOf(scope));
    },
    async listBySite({ siteId }) {
      if (closed) return [];
      sweep();
      return [...entries.values()]
        .filter(record => record.siteId === siteId)
        .map(record => ({ ...record }));
    },
    async close() {
      closed = true;
      entries.clear();
    },
    get size() { return entries.size; }
  });
}

function createPresenceService({ adapter, leaseMs = 30_000, now = Date.now } = {}) {
  if (!adapter || typeof adapter.upsert !== 'function' || typeof adapter.remove !== 'function' || typeof adapter.listBySite !== 'function') {
    throw new TypeError('A presence adapter with upsert, remove and listBySite methods is required.');
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 120_000) {
    throw new RangeError('leaseMs must be between 5000 and 120000.');
  }

  async function heartbeat({ siteId, principalId, sessionId, availability = 'active' }) {
    validatePresenceScope({ siteId, principalId, sessionId });
    if (!AVAILABILITY.has(availability)) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_PRESENCE_AVAILABILITY_INVALID', 'availability must be active, idle, away or hidden.');
    }

    const timestamp = now();
    const record = {
      siteId: siteId.toLowerCase(),
      principalId,
      sessionId,
      availability,
      lastSeenAtMs: timestamp,
      expiresAtMs: timestamp + leaseMs
    };
    await adapter.upsert(record);
    return {
      siteId: record.siteId,
      userId: principalId,
      availability,
      expiresAt: new Date(record.expiresAtMs).toISOString()
    };
  }

  async function leave({ siteId, principalId, sessionId }) {
    validatePresenceScope({ siteId, principalId, sessionId });
    await adapter.remove({ siteId: siteId.toLowerCase(), principalId, sessionId });
    return { siteId: siteId.toLowerCase(), userId: principalId, left: true };
  }

  async function list({ siteId, viewerId }) {
    if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) {
      throw realtimeError(400, 'ERR_SYSTEMFABRIC_PRESENCE_SITE_INVALID', 'A valid siteId is required.');
    }
    if (!validPrincipalId(viewerId)) {
      throw realtimeError(401, 'ERR_SYSTEMFABRIC_PRESENCE_VIEWER_REQUIRED', 'An authenticated viewer is required.');
    }

    const timestamp = now();
    const records = await adapter.listBySite({ siteId: siteId.toLowerCase() });
    const grouped = new Map();

    for (const record of records) {
      if (!record || record.siteId !== siteId.toLowerCase() || record.expiresAtMs <= timestamp) continue;
      const current = grouped.get(record.principalId) || {
        userId: record.principalId,
        availability: 'hidden',
        lastSeenAtMs: 0
      };
      if (AVAILABILITY_RANK[record.availability] > AVAILABILITY_RANK[current.availability]) {
        current.availability = record.availability;
      }
      current.lastSeenAtMs = Math.max(current.lastSeenAtMs, record.lastSeenAtMs);
      grouped.set(record.principalId, current);
    }

    return [...grouped.values()]
      .filter(record => record.availability !== 'hidden' || record.userId === viewerId)
      .map(record => ({
        userId: record.userId,
        availability: record.availability,
        lastSeenAt: new Date(record.lastSeenAtMs).toISOString()
      }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  return Object.freeze({
    heartbeat,
    leave,
    list,
    async close() { await adapter.close?.(); }
  });
}

module.exports = { createMemoryPresenceAdapter, createPresenceService, AVAILABILITY };
