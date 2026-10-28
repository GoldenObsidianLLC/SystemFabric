'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResponseCache } = require('../lib/response-cache');

test('response cache enforces LRU, TTL and byte bounds', async () => {
  const cache = createResponseCache({ maxEntries: 2, maxBytes: 16, ttlMs: 1000 });
  cache.set('a', '<b>A</b>');
  cache.set('b', '<b>B</b>');
  assert.equal(cache.get('a'), '<b>A</b>'); // make a most-recently used
  cache.set('c', '<b>C</b>');
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), '<b>A</b>');
  assert.equal(cache.get('c'), '<b>C</b>');
  assert.equal(cache.stats().evictions, 1);
  assert.throws(() => cache.set('bad', { html: 'no' }), /HTML strings only/);
  assert.throws(() => cache.get(''), /keys must be/);
  const expiring = createResponseCache({ ttlMs: 1 });
  expiring.set('x', 'cached');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(expiring.get('x'), undefined);
  assert.equal(expiring.stats().expirations, 1);
});

test('response cache is explicit and returns bytes/stats without mutating values', () => {
  const cache = createResponseCache({ maxEntries: 1, maxBytes: 8, ttlMs: 100 });
  assert.equal(cache.set('large', '0123456789'), false);
  assert.equal(cache.set('one', '<p>1</p>'), true);
  assert.equal(cache.set('two', '<p>2</p>'), true);
  assert.equal(cache.get('one'), undefined);
  assert.deepEqual(cache.stats().entries, 1);
  cache.clear();
  assert.equal(cache.stats().entries, 0);
});
