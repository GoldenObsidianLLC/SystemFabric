'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityService, normalizeEmail, validatePassword, hashPassword, verifyPassword, digest, safeEqualText } = require('../packages/auth/src/service');

test('identity helpers normalize email consistently and reject invalid addresses', () => {
  assert.equal(normalizeEmail('  Admin@Example.COM '), 'admin@example.com');
  assert.equal(normalizeEmail('not-an-email'), '');
  assert.equal(normalizeEmail('x'.repeat(260)), '');
});

test('password policy and scrypt hashes are enforced', async () => {
  assert.throws(() => validatePassword('short'), { code: 'ERR_SYSTEMFABRIC_PASSWORD_POLICY' });
  assert.throws(() => validatePassword('alllowercase123'), { code: 'ERR_SYSTEMFABRIC_PASSWORD_POLICY' });
  const encoded = await hashPassword('CorrectHorse9Battery');
  assert.match(encoded, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('CorrectHorse9Battery', encoded), true);
  assert.equal(await verifyPassword('WrongHorse9Battery', encoded), false);
  assert.equal(await verifyPassword('anything', 'unknown$scheme'), false);
});

test('identity service emits scoped authorization invalidations after membership and session changes', async () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const siteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const changes = [];
  const pool = {
    async query(sql) {
      if (sql.includes('UPDATE auth_sessions')) return { rowCount: 1, rows: [{ id: sessionId, user_id: userId }] };
      if (sql.includes('SELECT 1 FROM auth_sessions')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('SELECT id,email,display_name,status FROM users')) return { rowCount: 1, rows: [{ id: userId, email: 'member@example.test', display_name: 'Member', status: 'active' }] };
      if (sql.includes('SELECT id FROM roles')) return { rowCount: 1, rows: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }] };
      if (sql.includes('INSERT INTO site_memberships')) return { rowCount: 1, rows: [{ user_id: userId }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
          if (sql.includes("r.slug='site-owner'")) return { rowCount: 0, rows: [] };
          if (sql.includes('DELETE FROM site_memberships')) return { rowCount: 1, rows: [{ user_id: userId }] };
          throw new Error(`Unexpected transaction query: ${sql}`);
        },
        release() {}
      };
    }
  };
  const identity = createIdentityService({ pool, env: {}, onAuthorizationChange: async change => changes.push(change) });

  assert.deepEqual(await identity.revokeSession({ userId, sessionId }), { revoked: true });
  assert.deepEqual(await identity.logout('opaque-session-token'), { revoked: true });
  await identity.addMember({ siteId, email: 'member@example.test', roleSlug: 'editor' });
  await identity.removeMember({ siteId, userId });
  assert.deepEqual(changes, [
    { principalId: userId, sessionId },
    { principalId: userId, sessionId },
    { siteId, principalId: userId },
    { siteId, principalId: userId }
  ]);
  assert.equal(await identity.isSessionActive({ userId, sessionId }), true);
  assert.equal(await identity.isSessionActive({ userId: '', sessionId }), false);
});

test('token digests and equality checks avoid direct token storage assumptions', () => {
  assert.equal(digest('secret').length, 64);
  assert.equal(safeEqualText('abc', 'abc'), true);
  assert.equal(safeEqualText('abc', 'abd'), false);
  assert.equal(safeEqualText('abc', 'abcd'), false);
});
