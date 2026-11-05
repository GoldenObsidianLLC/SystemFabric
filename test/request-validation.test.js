'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBoundedJsonObject } = require('../apps/api/src/request-validation');

test('bounded JSON validation accepts plain objects up to the UTF-8 byte ceiling', () => {
  assert.equal(isBoundedJsonObject({ name: 'hub' }), true);
  const value = { message: 'é'.repeat(8) };
  assert.equal(isBoundedJsonObject(value, Buffer.byteLength(JSON.stringify(value), 'utf8')), true);
  assert.equal(isBoundedJsonObject(value, Buffer.byteLength(JSON.stringify(value), 'utf8') - 1), false);
});

test('bounded JSON validation rejects non-objects and invalid byte limits', () => {
  for (const value of [null, undefined, [], 'text', 1, true]) {
    assert.equal(isBoundedJsonObject(value), false);
  }
  for (const limit of [0, 1, -1, 1.5, NaN, Infinity, '32']) {
    assert.equal(isBoundedJsonObject({ ok: true }, limit), false);
  }
});

test('bounded JSON validation fails closed when serialization throws', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(isBoundedJsonObject(circular), false);
  assert.equal(isBoundedJsonObject({ amount: 1n }), false);
});
