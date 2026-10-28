'use strict';

const { randomBytes, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } = require('node:crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer) {
  let bits = 0; let value = 0; let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(input) {
  const text = String(input || '').toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  if (!text || /[^A-Z2-7]/.test(text)) throw new Error('Invalid base32 secret.');
  let bits = 0; let value = 0; const out = [];
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function generateTotpSecret() { return base32Encode(randomBytes(20)); }
function totpAt(secret, step) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}
function verifyTotp(secret, input, { now = Date.now(), window = 1, lastUsedStep = -1 } = {}) {
  if (typeof input !== 'string' || !/^\d{6}$/.test(input)) return null;
  const current = Math.floor(now / 30_000);
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step <= lastUsedStep || step < 0) continue;
    const expected = totpAt(secret, step);
    const a = Buffer.from(input); const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return step;
  }
  return null;
}
function totpUri(secret, email, issuer = 'SystemFabric') {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${query.toString()}`;
}
function keyFromEnv(env) {
  const value = env.SYSTEMFABRIC_MFA_ENCRYPTION_KEY;
  if (!value) { const error = new Error('SYSTEMFABRIC_MFA_ENCRYPTION_KEY is required for MFA.'); error.code = 'ERR_SYSTEMFABRIC_MFA_KEY_MISSING'; throw error; }
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32) { const error = new Error('SYSTEMFABRIC_MFA_ENCRYPTION_KEY must decode to exactly 32 bytes.'); error.code = 'ERR_SYSTEMFABRIC_MFA_KEY_INVALID'; throw error; }
  return key;
}
function encryptSecret(secret, env = process.env) {
  const key = keyFromEnv(env); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decryptSecret(payload, env = process.env) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported encrypted MFA secret format.');
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnv(env), Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}
function generateRecoveryCodes(count = 10) { return Array.from({ length: count }, () => randomBytes(9).toString('base64url').toUpperCase()); }
module.exports = { base32Encode, base32Decode, generateTotpSecret, totpAt, verifyTotp, totpUri, encryptSecret, decryptSecret, generateRecoveryCodes };
