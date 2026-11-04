'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { UUID_RE } = require('../../domain/src/identifiers');
const MAX_AI_TASK_PAYLOAD_BYTES = 128 * 1024;
const PURPOSES = new Set(['input', 'result']);

function queueCryptoError(message, code = 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PAYLOAD_INVALID') {
  return Object.assign(new TypeError(message), { code, statusCode: 400 });
}

function keyFromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw queueCryptoError(
      'VIRGOSCORPIO_HUB_AI_QUEUE_ENCRYPTION_KEY must be a canonical base64url-encoded 32-byte key.',
      'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_KEY_INVALID'
    );
  }
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) {
    throw queueCryptoError(
      'VIRGOSCORPIO_HUB_AI_QUEUE_ENCRYPTION_KEY must decode to exactly 32 bytes.',
      'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_KEY_INVALID'
    );
  }
  return key;
}

function requireScope({ taskId, siteId, purpose }) {
  if (typeof taskId !== 'string' || !UUID_RE.test(taskId) ||
      typeof siteId !== 'string' || !UUID_RE.test(siteId) ||
      !PURPOSES.has(purpose)) {
    throw queueCryptoError('A valid task ID, site ID and payload purpose are required.');
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createAITaskPayloadCipher({ encryptionKey, maxBytes = MAX_AI_TASK_PAYLOAD_BYTES } = {}) {
  const key = keyFromBase64Url(encryptionKey);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_AI_TASK_PAYLOAD_BYTES) {
    throw new RangeError('maxBytes must be an integer between 1 and 131072.');
  }

  function aad({ taskId, siteId, purpose }) {
    requireScope({ taskId, siteId, purpose });
    return Buffer.from(`virgoscorpio-hub:ai-task:v1:${siteId.toLowerCase()}:${taskId.toLowerCase()}:${purpose}`, 'utf8');
  }

  function seal({ taskId, siteId, purpose, value }) {
    const serialized = (() => {
      try { return JSON.stringify(value); }
      catch { throw queueCryptoError('AI task payload must be JSON-serializable.'); }
    })();
    if (typeof serialized !== 'string' || !isPlainObject(value)) {
      throw queueCryptoError('AI task payload must be a JSON object.');
    }
    const plaintext = Buffer.from(serialized, 'utf8');
    if (plaintext.length < 1 || plaintext.length > maxBytes) {
      throw queueCryptoError(`AI task payload exceeds the ${maxBytes}-byte limit.`);
    }

    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad({ taskId, siteId, purpose }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { nonce, ciphertext, tag: cipher.getAuthTag() };
  }

  function open({ taskId, siteId, purpose, envelope }) {
    requireScope({ taskId, siteId, purpose });
    if (!envelope || !Buffer.isBuffer(envelope.nonce) || envelope.nonce.length !== 12 ||
        !Buffer.isBuffer(envelope.ciphertext) || envelope.ciphertext.length < 1 ||
        envelope.ciphertext.length > maxBytes ||
        !Buffer.isBuffer(envelope.tag) || envelope.tag.length !== 16) {
      throw queueCryptoError('Encrypted AI task payload has an invalid envelope.');
    }

    let plaintext;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce);
      decipher.setAAD(aad({ taskId, siteId, purpose }));
      decipher.setAuthTag(envelope.tag);
      plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    } catch {
      throw queueCryptoError(
        'Encrypted AI task payload authentication failed.',
        'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PAYLOAD_AUTHENTICATION_FAILED'
      );
    }

    if (plaintext.length > maxBytes) {
      throw queueCryptoError('Decrypted AI task payload exceeds the configured limit.');
    }
    let value;
    try { value = JSON.parse(plaintext.toString('utf8')); }
    catch {
      throw queueCryptoError(
        'Decrypted AI task payload is not valid JSON.',
        'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PAYLOAD_AUTHENTICATION_FAILED'
      );
    }
    if (!isPlainObject(value)) throw queueCryptoError('Decrypted AI task payload must be a JSON object.');
    return value;
  }

  return Object.freeze({ seal, open, maxBytes });
}

module.exports = {
  MAX_AI_TASK_PAYLOAD_BYTES,
  createAITaskPayloadCipher
};
