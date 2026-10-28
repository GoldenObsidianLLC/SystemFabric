'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseOrderStockReservations, commitOrderStockReservations } = require('../packages/commerce/src/stock-reservations');

function fakeClient({ rows = [{ released_count: 2 }] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values) { calls.push({ sql, values }); return { rows }; }
  };
}

test('release reservations atomically restores only rows transitioned from reserved', async () => {
  const client = fakeClient({ rows: [{ released_count: 2 }] });
  const count = await releaseOrderStockReservations(client, {
    siteId: 'site-id', orderId: 'order-id', status: 'expired'
  });
  assert.equal(count, 2);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].sql, /UPDATE commerce_stock_reservations/);
  assert.match(client.calls[0].sql, /status='reserved'/);
  assert.match(client.calls[0].sql, /UPDATE commerce_products/);
  assert.deepEqual(client.calls[0].values, ['site-id', 'order-id', 'expired']);
});

test('reservation release and commit reject invalid status or missing identifiers', async () => {
  const client = fakeClient();
  await assert.rejects(releaseOrderStockReservations(client, { siteId: 's', orderId: 'o', status: 'committed' }), /status must be released or expired/);
  await assert.rejects(releaseOrderStockReservations(client, { siteId: null, orderId: 'o' }), /siteId and orderId are required/);
  await assert.rejects(commitOrderStockReservations(client, { siteId: 's', orderId: null }), /siteId and orderId are required/);
  assert.equal(client.calls.length, 0);
});

test('commit moves only outstanding reservations and is safe to repeat', async () => {
  const client = fakeClient({ rows: [{ id: 'r1' }] });
  const count = await commitOrderStockReservations(client, { siteId: 's', orderId: 'o' });
  assert.equal(count, 1);
  assert.match(client.calls[0].sql, /status='reserved' RETURNING id/);
  assert.deepEqual(client.calls[0].values, ['s', 'o']);
});
