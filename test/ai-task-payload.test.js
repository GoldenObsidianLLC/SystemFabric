'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createAITaskPayloadCipher } = require('../packages/security/src/ai-task-payload');

const siteId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const encryptionKey = randomBytes(32).toString('base64url');

test('AI task payload cipher encrypts and authenticates JSON with site/task/purpose AAD', () => {
  const cipher = createAITaskPayloadCipher({ encryptionKey });
  const payload = { prompt: 'private prompt', context: ['one', 'two'] };
  const envelope = cipher.seal({ taskId, siteId, purpose: 'input', value: payload });

  assert.equal(envelope.nonce.length, 12);
  assert.equal(envelope.tag.length, 16);
  assert.notEqual(envelope.ciphertext.toString('utf8'), JSON.stringify(payload));
  assert.deepEqual(cipher.open({ taskId, siteId, purpose: 'input', envelope }), payload);
  assert.throws(() => cipher.open({
    taskId, siteId: '33333333-3333-4333-8333-333333333333',
    purpose: 'input', envelope
  }), { code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PAYLOAD_AUTHENTICATION_FAILED' });
  assert.throws(() => cipher.open({
    taskId, siteId, purpose: 'result', envelope
  }), { code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PAYLOAD_AUTHENTICATION_FAILED' });
});

test('AI task payload cipher rejects malformed keys, scopes, types and oversized payloads', () => {
  assert.throws(() => createAITaskPayloadCipher({ encryptionKey: 'weak' }), {
    code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_KEY_INVALID'
  });
  const cipher = createAITaskPayloadCipher({ encryptionKey, maxBytes: 64 });
  assert.throws(() => cipher.seal({ taskId, siteId, purpose: 'input', value: 'not-object' }), {
    code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PAYLOAD_INVALID'
  });
  assert.throws(() => cipher.seal({ taskId, siteId, purpose: 'input', value: { text: 'x'.repeat(100) } }), {
    code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PAYLOAD_INVALID'
  });
  assert.throws(() => cipher.seal({ taskId: 'invalid', siteId, purpose: 'input', value: { ok: true } }), {
    code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PAYLOAD_INVALID'
  });
  assert.throws(() => cipher.open({
    taskId, siteId, purpose: 'input',
    envelope: { nonce: Buffer.alloc(3), ciphertext: Buffer.from('x'), tag: Buffer.alloc(16) }
  }), { code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_PAYLOAD_INVALID' });
});

test('AI task payload cipher does not accept non-canonical base64url keys', () => {
  const invalid = Buffer.alloc(32, 7).toString('base64url') + 'A';
  assert.throws(() => createAITaskPayloadCipher({ encryptionKey: invalid }), {
    code: 'ERR_VIRGOSCORPIO_HUB_AI_QUEUE_KEY_INVALID'
  });
});
