'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UUID_RE, isUuid } = require('../packages/domain/src/identifiers');

test('shared UUID identifier contract accepts RFC-compatible version and variant forms', () => {
  assert.equal(isUuid('11111111-1111-4111-8111-111111111111'), true);
  assert.equal(isUuid('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), true);
  assert.equal(UUID_RE.test('ffffffff-ffff-8fff-bfff-ffffffffffff'), true);
});

test('shared UUID identifier contract rejects malformed, nil and unsupported variant values', () => {
  for (const value of [
    null, undefined, 123, '', 'not-a-uuid',
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-7111-111111111111',
    '11111111-1111-9111-8111-111111111111',
    '11111111111141118111111111111111'
  ]) {
    assert.equal(isUuid(value), false, String(value));
  }
});
