'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadEnvFile } = require('../../../scripts/load-env');
const { createPostgresPool } = require('../../../packages/db/src/postgres-store');
const { createOutboxDeliveryWorker } = require('../../../packages/db/src/outbox-delivery');
const { createMemgraphDriver, createMemgraphProjector } = require('../../../packages/graph/src/memgraph-store');

const DEFAULT_GRAPH_CONSUMER_GROUP = 'graph.projection.v1';
const GRAPH_PROJECTION_EVENT_TYPES = Object.freeze([
  'content.upsert',
  'content.delete',
  'content.publish',
  'content.unpublish',
  'content.submitted_for_review',
  'content.approved',
  'content.rejected',
  'content.scheduled',
  'content.archived',
  'content.unpublished',
  'taxonomy.upsert',
  'taxonomy.delete',
  'relationship.upsert',
  'relationship.delete'
]);

function createGraphProjectionWorker({
  pool,
  projector,
  consumerGroup = DEFAULT_GRAPH_CONSUMER_GROUP,
  workerId = `sf-graph-${randomUUID()}`,
  batchSize = 25,
  dispatchBatchSize = 250,
  leaseMs = 30_000,
  maxAttempts = 10,
  onError = () => {}
}) {
  if (!projector || typeof projector.apply !== 'function') {
    throw new TypeError('projector.apply is required for graph projection delivery.');
  }
  return createOutboxDeliveryWorker({
    pool,
    consumerGroup,
    eventTypes: GRAPH_PROJECTION_EVENT_TYPES,
    workerId,
    batchSize,
    dispatchBatchSize,
    leaseMs,
    maxAttempts,
    onError,
    handler: ({ type, payload, envelope, delivery }) => projector.apply({
      type,
      payload,
      envelope,
      delivery
    })
  });
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  if (process.env.NODE_ENV === 'production' && process.env.SYSTEMFABRIC_WORKER_APPROVED !== 'true') {
    throw new Error('Set SYSTEMFABRIC_WORKER_APPROVED=true only after production security review.');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured for the outbox worker.');
  if (process.env.MEMGRAPH_ENABLED !== 'true') throw new Error('MEMGRAPH_ENABLED=true is required to run the graph projection worker.');

  const pool = createPostgresPool(process.env);
  const driver = createMemgraphDriver({
    url: process.env.MEMGRAPH_URL,
    username: process.env.MEMGRAPH_USERNAME,
    password: process.env.MEMGRAPH_PASSWORD
  });
  const projector = createMemgraphProjector({ driver });
  const consumerGroup = process.env.SYSTEMFABRIC_GRAPH_CONSUMER_GROUP || DEFAULT_GRAPH_CONSUMER_GROUP;
  const batchSize = Number(process.env.SYSTEMFABRIC_GRAPH_BATCH_SIZE || 25);
  const dispatchBatchSize = Number(process.env.SYSTEMFABRIC_GRAPH_DISPATCH_BATCH_SIZE || 250);
  const leaseMs = Number(process.env.SYSTEMFABRIC_GRAPH_LEASE_MS || 30_000);
  const maxAttempts = Number(process.env.SYSTEMFABRIC_GRAPH_MAX_ATTEMPTS || 10);
  const pollMs = Number(process.env.SYSTEMFABRIC_GRAPH_POLL_MS || 1000);

  const worker = createGraphProjectionWorker({
    pool,
    projector,
    consumerGroup,
    batchSize,
    dispatchBatchSize,
    leaseMs,
    maxAttempts,
    onError: event => console.error(JSON.stringify({
      type: 'systemfabric.outbox.delivery_error',
      ...event
    }))
  });

  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.error(JSON.stringify({
    type: 'systemfabric.graph_projection_worker.started',
    consumerGroup,
    batchSize,
    dispatchBatchSize,
    leaseMs,
    maxAttempts,
    pollMs
  }));

  try {
    await worker.run({ signal: controller.signal, pollMs });
  } finally {
    await driver.close();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Outbox worker failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_GRAPH_CONSUMER_GROUP,
  GRAPH_PROJECTION_EVENT_TYPES,
  createGraphProjectionWorker,
  main
};
