'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, timingSafeEqual } = require('node:crypto');
const { createSessionService } = require('../packages/auth/src/session-service');

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const siteId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const digestToken = value => createHash('sha256').update(String(value)).digest('hex');
const safeEqualText = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const safeUser = user => ({
  id: user.id,
  email: user.email,
  displayName: user.display_name,
  status: user.status,
  emailVerified: Boolean(user.email_verified_at),
  mfaEnabled: Boolean(user.mfa_enabled)
});

function createService(pool, overrides = {}) {
  const changes = [];
  const service = createSessionService({
    pool,
    clock: () => Date.UTC(2026, 10, 4, 12),
    sessionTtlMs: 12 * 60 * 60 * 1000,
    sessionIdleTtlMinutes: 60,
    digestToken,
    safeEqualText,
    safeUser,
    onAuthorizationChange: async change => changes.push(change),
    ...overrides
  });
  return { service, changes };
}

test('session service creates 256-bit opaque tokens and persists only their digests', async () => {
  let inserted;
  const pool = {
    async query(sql, values) {
      assert.match(sql, /INSERT INTO auth_sessions/);
      inserted = { sql, values };
      return { rowCount: 1, rows: [] };
    }
  };
  const { service } = createService(pool);
  const session = await service.createSession({
    id: userId,
    email: 'owner@example.test',
    display_name: 'Owner',
    status: 'active'
  }, {
    ip: '192.0.2.10',
    userAgent: 'VirgoScorpio Hub session test'
  });

  assert.equal(Buffer.from(session.token, 'base64url').length, 32);
  assert.equal(Buffer.from(session.csrf, 'base64url').length, 32);
  assert.equal(session.expiresAt.getTime(), Date.UTC(2026, 10, 4, 12) + 12 * 60 * 60 * 1000);
  assert.deepEqual(session.user, {
    id: userId,
    email: 'owner@example.test',
    displayName: 'Owner',
    status: 'active',
    emailVerified: false,
    mfaEnabled: false
  });
  assert.equal(inserted.values[0], userId);
  assert.equal(inserted.values[1], digestToken(session.token));
  assert.equal(inserted.values[2], digestToken(session.csrf));
  assert.equal(inserted.values[4], digestToken('VirgoScorpio Hub session test'));
  assert.equal(inserted.values[5], digestToken('192.0.2.10'));
  assert.notEqual(inserted.values[1], session.token);
  assert.notEqual(inserted.values[2], session.csrf);
});

test('session authentication returns normalized memberships and only queries with the token digest', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/FROM auth_sessions s JOIN users u/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            session_id: sessionId,
            user_id: userId,
            expires_at: new Date(Date.UTC(2026, 10, 4, 20)),
            email: 'editor@example.test',
            display_name: 'Editor',
            status: 'active',
            email_verified_at: new Date(),
            mfa_enabled: true
          }]
        };
      }
      if (/UPDATE auth_sessions SET last_seen_at/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM site_memberships m JOIN sites/.test(sql)) {
        return {
          rowCount: 3,
          rows: [
            { site_id: siteId, site_slug: 'main', site_name: 'Main', role_slug: 'editor', capabilities: ['content:read', 'content:edit'] },
            { site_id: siteId, site_slug: 'main', site_name: 'Main', role_slug: 'reviewer', capabilities: ['content:read', 'content:review'] },
            { site_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', site_slug: 'docs', site_name: 'Docs', role_slug: 'viewer', capabilities: ['content:read'] }
          ]
        };
      }
      throw new Error('Unexpected query: ' + sql);
    }
  };
  const { service } = createService(pool);
  const token = 't'.repeat(43);
  const actor = await service.authenticate(token);

  assert.equal(actor.sessionId, sessionId);
  assert.equal(actor.user.id, userId);
  assert.equal(actor.user.emailVerified, true);
  assert.equal(actor.user.mfaEnabled, true);
  assert.deepEqual(actor.memberships[0], {
    siteId,
    siteSlug: 'main',
    siteName: 'Main',
    roles: ['editor', 'reviewer'],
    capabilities: ['content:read', 'content:edit', 'content:review'],
    role: ['editor', 'reviewer']
  });
  assert.equal(actor.memberships[1].role, 'viewer');
  assert.equal(calls[0].values[0], digestToken(token));
  assert.notEqual(calls[0].values[0], token);
  assert.equal(calls[0].values[1], 60);
});

test('session authentication rejects malformed tokens without database access', async () => {
  let calls = 0;
  const { service } = createService({ async query() { calls += 1; return { rows: [] }; } });
  assert.equal(await service.authenticate('short'), null);
  assert.equal(await service.authenticate(null), null);
  assert.equal(calls, 0);
});

test('CSRF validation, active-session checks, and session listing preserve their scoping contracts', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT csrf_hash')) {
        return { rowCount: 1, rows: [{ csrf_hash: digestToken('csrf-value') }] };
      }
      if (sql.startsWith('SELECT 1 FROM auth_sessions')) return { rowCount: 1, rows: [{}] };
      if (sql.startsWith('SELECT id,created_at,last_seen_at')) {
        return {
          rowCount: 2,
          rows: [
            {
              id: sessionId,
              created_at: new Date(1),
              last_seen_at: new Date(2),
              expires_at: new Date(3),
              revoked_at: null,
              user_agent_hash: 'abcdef0123456789',
              ip_hash: null
            },
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              created_at: new Date(4),
              last_seen_at: new Date(5),
              expires_at: new Date(6),
              revoked_at: new Date(7),
              user_agent_hash: null,
              ip_hash: '0123456789abcdef'
            }
          ]
        };
      }
      throw new Error('Unexpected query: ' + sql);
    }
  };
  const { service } = createService(pool);
  const token = 's'.repeat(43);
  assert.equal(await service.validateCsrf(token, 'csrf-value'), true);
  assert.equal(await service.validateCsrf(token, 'different'), false);
  assert.equal(await service.validateCsrf(null, 'csrf-value'), false);
  assert.equal(await service.isSessionActive({ userId, sessionId }), true);
  assert.equal(await service.isSessionActive({ userId: '', sessionId }), false);
  const listed = await service.listSessions({ userId, currentSessionId: sessionId });
  assert.deepEqual(listed[0], {
    id: sessionId,
    createdAt: new Date(1),
    lastSeenAt: new Date(2),
    expiresAt: new Date(3),
    revokedAt: null,
    current: true,
    userAgentFingerprint: 'abcdef012345',
    ipFingerprint: null
  });
  assert.equal(listed[1].current, false);
  assert.equal(listed[1].ipFingerprint, '0123456789ab');
  assert.equal(calls[0].values[0], digestToken(token));
  assert.deepEqual(calls[2].values, [sessionId, userId, 60]);
});

test('logout and explicit revocation emit principal/session-scoped authorization changes', async () => {
  const pool = {
    async query(sql, values) {
      if (sql.includes('RETURNING id,user_id')) return { rowCount: 1, rows: [{ id: sessionId, user_id: userId }] };
      if (sql.includes('RETURNING id')) return { rowCount: 1, rows: [{ id: sessionId }] };
      throw new Error('Unexpected query: ' + sql);
    }
  };
  const { service, changes } = createService(pool);
  assert.deepEqual(await service.logout('opaque-token'), { revoked: true });
  assert.deepEqual(await service.logout(''), { revoked: false });
  assert.deepEqual(await service.revokeSession({ userId, sessionId }), { revoked: true });
  assert.deepEqual(changes, [
    { principalId: userId, sessionId },
    { principalId: userId, sessionId }
  ]);
  assert.ok(Object.isFrozen(changes[0]));
});

test('session service validates its persistence and security dependencies', () => {
  assert.throws(() => createSessionService(), /PostgreSQL query pool/);
  const dependencies = {
    pool: { query() {} },
    clock: () => 1,
    sessionTtlMs: 60_000,
    sessionIdleTtlMinutes: 60,
    digestToken,
    safeEqualText,
    safeUser
  };
  assert.throws(() => createSessionService({ ...dependencies, clock: 1 }), /clock must be a function/);
  assert.throws(() => createSessionService({ ...dependencies, sessionTtlMs: 0 }), /positive integer session TTL/);
  assert.throws(() => createSessionService({ ...dependencies, sessionIdleTtlMinutes: 0 }), /positive integer idle TTL/);
});
