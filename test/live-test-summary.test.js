'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNodeTestSummary } = require('../scripts/parse-node-test-summary');

test('parses Node.js information-symbol test summary', () => {
  const summary = parseNodeTestSummary([
    'ℹ tests 5',
    'ℹ suites 0',
    'ℹ pass 4',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0'
  ].join('\n'));
  assert.deepEqual(summary, {
    tests: 5, passed: 4, failed: 1, cancelled: 0, skipped: 0, todo: 0
  });
});

test('parses classic TAP summary lines', () => {
  const summary = parseNodeTestSummary([
    '# tests 2', '# pass 2', '# fail 0', '# skipped 0'
  ].join('\n'));
  assert.deepEqual(summary, {
    tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0
  });
});

test('fails closed when a TAP log has no complete summary', () => {
  assert.equal(parseNodeTestSummary('✔ test passed\n'), null);
  assert.equal(parseNodeTestSummary('# tests 1\n# pass 1\n'), null);
  assert.equal(parseNodeTestSummary(null), null);
});
