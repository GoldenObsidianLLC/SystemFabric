'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boundedInt } = require('../packages/ai/src/config');
const { createAIService } = require('../packages/ai/src/service');
const { createApiServer } = require('../apps/api/src/server');

test('bounded configuration uses defaults only when absent and fails closed on malformed limits', () => {
  assert.equal(boundedInt(undefined, 10, 1, 20, 'TEST_LIMIT'), 10);
  assert.equal(boundedInt('12', 10, 1, 20, 'TEST_LIMIT'), 12);
  assert.throws(() => boundedInt('NaN', 10, 1, 20, 'TEST_LIMIT'), { code: 'ERR_SYSTEMFABRIC_CONFIG_LIMIT' });
  assert.throws(() => boundedInt('100', 10, 1, 20, 'TEST_LIMIT'), { code: 'ERR_SYSTEMFABRIC_CONFIG_LIMIT' });
});

test('API refuses malformed request-rate configuration instead of disabling limits', () => {
  assert.throws(() => createApiServer({ env: { NODE_ENV: 'test', AI_PROVIDER: 'mock', RATE_LIMIT_MAX_REQUESTS: 'no-limit' } }), { code: 'ERR_SYSTEMFABRIC_CONFIG_LIMIT' });
});

test('AI service refuses malformed output ceilings', () => {
  assert.throws(() => createAIService({ env: { AI_PROVIDER: 'mock', AI_MAX_OUTPUT_CHARS: 'unlimited' }, audit() {} }), { code: 'ERR_SYSTEMFABRIC_CONFIG_LIMIT' });
});
