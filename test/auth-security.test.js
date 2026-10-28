'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmail, validatePassword, hashPassword, verifyPassword, digest, safeEqualText } = require('../packages/auth/src/service');

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

test('token digests and equality checks avoid direct token storage assumptions', () => {
  assert.equal(digest('secret').length, 64);
  assert.equal(safeEqualText('abc', 'abc'), true);
  assert.equal(safeEqualText('abc', 'abd'), false);
  assert.equal(safeEqualText('abc', 'abcd'), false);
});
