'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_GRAPH_CONSUMER_GROUP,
  GRAPH_PROJECTION_EVENT_TYPES,
  createGraphProjectionWorker
} = require('../apps/worker/src/outbox-worker');

test('graph projection worker binds the durable graph consumer group and preserves projector inputs', async () => {
  let delivered;
  const pool = {
    async query(sql) {
      if (sql.includes('SELECT event_types FROM outbox_consumer_groups')) return { rowCount: 1, rows: [{ event_types: GRAPH_PROJECTION_EVENT_TYPES }] };
      if (sql.includes('INSERT INTO outbox_deliveries')) return { rowCount: 1, rows: [] };
      if (sql.includes('WITH candidates AS')) return {
        rowCount: 1,
        rows: [{
          id: '33333333-3333-4333-8333-333333333333',
          aggregate_type: 'content',
          aggregate_id: '44444444-4444-4444-8444-444444444444',
          aggregate_version: 5,
          event_type: 'content.upsert',
          payload: { id: '44444444-4444-4444-8444-444444444444' },
          schema_version: 1,
          site_id: '11111111-1111-4111-8111-111111111111',
          actor_id: null,
          correlation_id: null,
          causation_id: null,
          classification: 'site-private',
          created_at: new Date('2026-10-30T16:30:00.000Z'),
          delivery_attempts: 1
        }]
      };
      if (sql.includes("SET status = 'processed'")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    }
  };
  const worker = createGraphProjectionWorker({
    pool,
    projector: { async apply(input) { delivered = input; } }
  });
  const result = await worker.runOnce();

  assert.equal(DEFAULT_GRAPH_CONSUMER_GROUP, 'graph.projection.v1');
  assert.ok(GRAPH_PROJECTION_EVENT_TYPES.includes('content.publish'));
  assert.ok(GRAPH_PROJECTION_EVENT_TYPES.includes('relationship.upsert'));
  assert.equal(result.claimed, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(delivered.type, 'content.upsert');
  assert.equal(delivered.envelope.resource.version, 5);
  assert.equal(delivered.delivery.consumerGroup, DEFAULT_GRAPH_CONSUMER_GROUP);
});
