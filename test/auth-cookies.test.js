'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCookies,
  serializeAuthCookie,
  safeCsrfCookie
} = require('../apps/api/src/auth-cookies');

test('cookie parser accepts only token-like names and preserves opaque values', () => {
  const parsed = parseCookies('vsh_session=abc_DEF-123; vsh_csrf=csrf456; invalid name=no; empty=');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual({ ...parsed }, {
    vsh_session: 'abc_DEF-123',
    vsh_csrf: 'csrf456',
    empty: ''
  });
});

test('authentication cookie serializer produces the configured browser security attributes', () => {
  assert.equal(
    serializeAuthCookie('vsh_session', 's'.repeat(43), {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 3600
    }),
    'vsh_session=' + 's'.repeat(43) + '; Path=/; SameSite=Lax; Max-Age=3600; HttpOnly; Secure'
  );
  assert.equal(
    serializeAuthCookie('vsh_mfa_challenge', 'm'.repeat(43), {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/api/v1/auth/mfa',
      maxAge: 300
    }),
    'vsh_mfa_challenge=' + 'm'.repeat(43) + '; Path=/api/v1/auth/mfa; SameSite=Strict; Max-Age=300; HttpOnly; Secure'
  );
  assert.equal(
    serializeAuthCookie('vsh_session', '', { httpOnly: true, secure: true, maxAge: 0 }),
    'vsh_session=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure'
  );
});

test('authentication cookie serializer rejects unsafe names, values, attributes, and insecure SameSite=None', () => {
  for (const name of ['', 'bad;name', 'has space', 'bad=name']) {
    assert.throws(() => serializeAuthCookie(name, 'token'), /cookie name is invalid/);
  }
  for (const value of ['token; Secure', 'token\r\nSet-Cookie: attacker=1', 'contains space', 'not*base64url']) {
    assert.throws(() => serializeAuthCookie('vsh_session', value), /opaque base64url/);
  }
  for (const options of [
    { sameSite: 'None' },
    { sameSite: 'Invalid' },
    { path: 'relative/path' },
    { path: '/auth; Secure' },
    { path: '/auth\r\nSet-Cookie: attacker=1' },
    { maxAge: -1 },
    { maxAge: 31_536_001 },
    { maxAge: 1.5 },
    { secure: 'true' },
    { httpOnly: 1 }
  ]) {
    assert.throws(() => serializeAuthCookie('vsh_session', 'token', options));
  }
});

test('CSRF double-submit equality is byte-safe and rejects invalid or mismatched inputs', () => {
  assert.equal(safeCsrfCookie('a'.repeat(43), 'a'.repeat(43)), true);
  assert.equal(safeCsrfCookie('a'.repeat(43), 'b'.repeat(43)), false);
  assert.equal(safeCsrfCookie('short', 'longer'), false);
  assert.equal(safeCsrfCookie(undefined, 'token'), false);
  assert.equal(safeCsrfCookie('token', null), false);
});
