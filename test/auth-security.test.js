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
  assert.throws(() => validatePassword('short'), { code: 'ERR_VIRGOSCORPIO_HUB_PASSWORD_POLICY' });
  assert.throws(() => validatePassword('alllowercase123'), { code: 'ERR_VIRGOSCORPIO_HUB_PASSWORD_POLICY' });
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

test('browser session and CSRF bearer values are random opaque tokens while only their SHA-256 digests are persisted', async () => {
  const passwordHash = await hashPassword('CorrectHorse9Battery');
  const userId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  let sessionInsert;

  const pool = {
    async query(sql, values) {
      if (sql.includes('FROM users WHERE lower(email)')) {
        return { rowCount: 1, rows: [{
          id: userId, email: 'owner@example.test', display_name: 'Owner',
          status: 'active', password_hash: passwordHash, mfa_enabled: false,
          email_verified_at: new Date()
        }] };
      }
      if (sql.includes('INSERT INTO auth_sessions')) {
        sessionInsert = { sql, values };
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const identity = createIdentityService({ pool, env: {} });
  const session = await identity.login({
    email: 'owner@example.test', password: 'CorrectHorse9Battery',
    ip: '192.0.2.10', userAgent: 'VirgoScorpio Hub security test'
  });

  assert.equal(Buffer.from(session.token, 'base64url').length, 32, 'session token contains 256 bits of random material');
  assert.equal(Buffer.from(session.csrf, 'base64url').length, 32, 'CSRF token contains 256 bits of random material');
  assert.equal(sessionInsert.values[0], userId);
  assert.equal(sessionInsert.values[1], digest(session.token), 'only the session token digest is sent to PostgreSQL');
  assert.equal(sessionInsert.values[2], digest(session.csrf), 'only the CSRF token digest is sent to PostgreSQL');
  assert.notEqual(sessionInsert.values[1], session.token);
  assert.notEqual(sessionInsert.values[2], session.csrf);
  assert.equal(sessionInsert.values[4], digest('VirgoScorpio Hub security test'));
  assert.equal(sessionInsert.values[5], digest('192.0.2.10'));
  assert.equal(session.user.id, userId);
});

test('MFA browser challenge is random, short-lived, and only its digest is persisted', async () => {
  const passwordHash = await hashPassword('CorrectHorse9Battery');
  const userId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  let challengeInsert;

  const pool = {
    async query(sql, values) {
      if (sql.includes('FROM users WHERE lower(email)')) {
        return { rowCount: 1, rows: [{
          id: userId, email: 'mfa@example.test', display_name: 'MFA User',
          status: 'active', password_hash: passwordHash, mfa_enabled: true,
          email_verified_at: new Date()
        }] };
      }
      if (sql.includes('INSERT INTO auth_mfa_challenges')) {
        challengeInsert = { sql, values };
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const identity = createIdentityService({ pool, env: {} });
  const login = await identity.login({
    email: 'mfa@example.test', password: 'CorrectHorse9Battery',
    ip: '192.0.2.11', userAgent: 'VirgoScorpio Hub MFA security test'
  });

  assert.equal(login.mfaRequired, true);
  assert.equal(Buffer.from(login.challengeToken, 'base64url').length, 32);
  assert.equal(challengeInsert.values[0], userId);
  assert.equal(challengeInsert.values[1], digest(login.challengeToken), 'only the MFA challenge digest is sent to PostgreSQL');
  assert.notEqual(challengeInsert.values[1], login.challengeToken);
  assert.ok(challengeInsert.values[2] instanceof Date);
  assert.ok(challengeInsert.values[2].getTime() > Date.now());
  assert.ok(challengeInsert.values[2].getTime() <= Date.now() + 5 * 60_000 + 1000);
});

test('token digests and equality checks avoid direct token storage assumptions', () => {
  assert.equal(digest('secret').length, 64);
  assert.equal(safeEqualText('abc', 'abc'), true);
  assert.equal(safeEqualText('abc', 'abd'), false);
  assert.equal(safeEqualText('abc', 'abcd'), false);
});
