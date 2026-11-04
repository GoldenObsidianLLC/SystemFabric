'use strict';

const { timingSafeEqual } = require('node:crypto');

const COOKIE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const COOKIE_VALUE_RE = /^[A-Za-z0-9_-]*$/;
const SAME_SITE_VALUES = new Set(['Strict', 'Lax', 'None']);

/**
 * Parse a Cookie request header into its name/value pairs.
 *
 * This parser is intentionally small and accepts only token-like cookie names.
 * Authentication callers must still validate the token format and verify it
 * against the server-side digest; parsing a cookie never authenticates a user.
 */
function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const piece of String(header).split(';')) {
    const index = piece.indexOf('=');
    if (index < 0) continue;
    const key = piece.slice(0, index).trim();
    const value = piece.slice(index + 1).trim();
    if (/^[A-Za-z0-9_-]+$/.test(key)) cookies[key] = value;
  }
  return cookies;
}

/**
 * Serialize one browser authentication cookie.
 *
 * Session/MFA values are opaque random bearer tokens. The identity store keeps
 * only their digests. The CSRF cookie is a separate double-submit value and is
 * intentionally readable by same-origin browser JavaScript.
 *
 * Never pass passwords, personal data, provider credentials, or arbitrary user
 * input to this serializer.
 */
function serializeAuthCookie(name, value, {
  httpOnly = false,
  secure = false,
  maxAge = 43_200,
  sameSite = 'Lax',
  path = '/'
} = {}) {
  if (typeof name !== 'string' || !COOKIE_NAME_RE.test(name)) {
    throw new TypeError('Authentication cookie name is invalid.');
  }
  if (typeof value !== 'string' || !COOKIE_VALUE_RE.test(value)) {
    throw new TypeError('Authentication cookie value must be an opaque base64url token or empty value.');
  }
  if (typeof httpOnly !== 'boolean' || typeof secure !== 'boolean') {
    throw new TypeError('Authentication cookie security flags must be boolean.');
  }
  if (!Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > 31_536_000) {
    throw new RangeError('Authentication cookie maxAge must be an integer from 0 to 31536000.');
  }
  if (!SAME_SITE_VALUES.has(sameSite)) {
    throw new TypeError('Authentication cookie SameSite must be Strict, Lax, or None.');
  }
  if (sameSite === 'None' && !secure) {
    throw new TypeError('SameSite=None authentication cookies must also be Secure.');
  }
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes(';') || path.includes(',') || path.split('').some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new TypeError('Authentication cookie path must be an absolute, safe cookie path.');
  }
  return `${name}=${value}; Path=${path}; SameSite=${sameSite}; Max-Age=${maxAge}${httpOnly ? '; HttpOnly' : ''}${secure ? '; Secure' : ''}`;
}

function safeCsrfCookie(cookieValue, headerValue) {
  if (typeof cookieValue !== 'string' || typeof headerValue !== 'string') return false;
  const left = Buffer.from(cookieValue, 'utf8');
  const right = Buffer.from(headerValue, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

module.exports = { parseCookies, serializeAuthCookie, safeCsrfCookie };
