'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TRACE_ID_RE, SPAN_ID_RE, TRACE_FLAGS_RE, REQUEST_ID_RE } = require('../packages/observability/src/trace-identifiers');

test('shared trace identifier expressions accept canonical W3C and request identifiers', () => {
  assert.equal(TRACE_ID_RE.test('0123456789abcdef0123456789abcdef'), true);
  assert.equal(SPAN_ID_RE.test('0123456789abcdef'), true);
  assert.equal(TRACE_FLAGS_RE.test('01'), true);
  assert.equal(REQUEST_ID_RE.test('req_12345678'), true);
});

test('shared trace identifier expressions reject zero, malformed, and oversized identifiers', () => {
  assert.equal(TRACE_ID_RE.test('00000000000000000000000000000000'), false);
  assert.equal(SPAN_ID_RE.test('0000000000000000'), false);
  assert.equal(TRACE_FLAGS_RE.test('xyz'), false);
  assert.equal(REQUEST_ID_RE.test('bad/id'), false);
  assert.equal(REQUEST_ID_RE.test('x'.repeat(81)), false);
});
