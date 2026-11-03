'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadEnvFile } = require('../../../scripts/load-env');
const { createPostgresPool } = require('../../../packages/db/src/postgres-store');
const { createOutboxDeliveryWorker } = require('../../../packages/db/src/outbox-delivery');
const { createMemgraphDriver, createMemgraphProjector } = require('../../../packages/graph/src/memgraph-store');
const { initializeTracing, withSpan } = require('../../../packages/observability/src/tracing');
const { initializeLogExport } = require('../../../packages/observability/src/otel-logs');
const { createStructuredLogger } = require('../../../packages/observability/src/structured-logger');

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
  workerId = `vsh-graph-${randomUUID()}`,
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
    handler: ({ type, payload, envelope, delivery }) => withSpan('graph.projection.apply', {
      'virgoscorpio_hub.component': 'graph',
      'virgoscorpio_hub.operation': type,
      'db.system': 'memgraph',
      'db.operation.name': 'write'
    }, () => projector.apply({ type, payload, envelope, delivery }))
  });
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  if (process.env.NODE_ENV === 'production' && process.env.VIRGOSCORPIO_HUB_WORKER_APPROVED !== 'true') {
    throw new Error('Set VIRGOSCORPIO_HUB_WORKER_APPROVED=true only after production security review.');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured for the outbox worker.');
  if (process.env.MEMGRAPH_ENABLED !== 'true') throw new Error('MEMGRAPH_ENABLED=true is required to run the graph projection worker.');
  const serviceVersion = require('../../../package.json').version;
  const tracingRuntime = initializeTracing({ env: process.env, serviceName: 'virgoscorpio-hub-outbox-worker', serviceVersion });
  let logRuntime;
  try {
    logRuntime = initializeLogExport({ env: process.env, serviceName: 'virgoscorpio-hub-outbox-worker', serviceVersion });
  } catch (error) {
    await tracingRuntime.shutdown().catch(() => {});
    throw error;
  }
  const structuredLogger = createStructuredLogger({
    logger: console,
    otelLogger: logRuntime.logger,
    service: 'virgoscorpio-hub-outbox-worker',
    environment: process.env.NODE_ENV || 'development'
  });

  let pool = null;
  let driver = null;
  try {
    pool = createPostgresPool(process.env);
    driver = createMemgraphDriver({
      url: process.env.MEMGRAPH_URL,
      username: process.env.MEMGRAPH_USERNAME,
      password: process.env.MEMGRAPH_PASSWORD
    });
    const projector = createMemgraphProjector({ driver });
    const consumerGroup = process.env.VIRGOSCORPIO_HUB_GRAPH_CONSUMER_GROUP || DEFAULT_GRAPH_CONSUMER_GROUP;
    const batchSize = Number(process.env.VIRGOSCORPIO_HUB_GRAPH_BATCH_SIZE || 25);
    const dispatchBatchSize = Number(process.env.VIRGOSCORPIO_HUB_GRAPH_DISPATCH_BATCH_SIZE || 250);
    const leaseMs = Number(process.env.VIRGOSCORPIO_HUB_GRAPH_LEASE_MS || 30_000);
    const maxAttempts = Number(process.env.VIRGOSCORPIO_HUB_GRAPH_MAX_ATTEMPTS || 10);
    const pollMs = Number(process.env.VIRGOSCORPIO_HUB_GRAPH_POLL_MS || 1000);

    const worker = createGraphProjectionWorker({
      pool,
      projector,
      consumerGroup,
      batchSize,
      dispatchBatchSize,
      leaseMs,
      maxAttempts,
      onError: event => structuredLogger.emit('error', 'virgoscorpio_hub.outbox.delivery_error', {
        component: 'outbox',
        operation: 'delivery',
        code: event?.errorCode,
        outcome: event?.leaseLost ? 'lease_lost' : (event?.dead ? 'dead_letter' : 'retry')
      })
    });

    const controller = new AbortController();
    const shutdown = () => controller.abort();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    structuredLogger.emit('info', 'virgoscorpio_hub.graph_projection_worker.started', {
      component: 'graph', operation: 'startup', outcome: 'success',
      batchSize, dispatchBatchSize, leaseMs, maxAttempts, pollMs
    });

    await worker.run({ signal: controller.signal, pollMs });
  } finally {
    await Promise.allSettled([
      driver ? driver.close() : Promise.resolve(),
      pool ? pool.end() : Promise.resolve()
    ]);
    await Promise.all([tracingRuntime.shutdown().catch(() => {}), logRuntime.shutdown().catch(() => {})]);
  }
}

if (require.main === module) {
  main().catch(error => {
    const bootstrapLogger = createStructuredLogger({ service: 'virgoscorpio-hub-outbox-worker', environment: process.env.NODE_ENV || 'development' });
    bootstrapLogger.emit('error', 'virgoscorpio_hub.outbox_worker.start_failed', {
      component: 'graph', operation: 'startup', outcome: 'failure',
      code: error?.code, errorType: error?.name || 'Error'
    });
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_GRAPH_CONSUMER_GROUP,
  GRAPH_PROJECTION_EVENT_TYPES,
  createGraphProjectionWorker,
  main
};
