'use strict';

const path = require('node:path');
const { loadEnvFile } = require('../../../scripts/load-env');
const { createPostgresPool } = require('../../../packages/db/src/postgres-store');
const { createOutboxWorker } = require('../../../packages/db/src/outbox-worker');
const { createMemgraphDriver, createMemgraphProjector } = require('../../../packages/graph/src/memgraph-store');

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  if (process.env.NODE_ENV === 'production' && process.env.SYSTEMFABRIC_WORKER_APPROVED !== 'true') throw new Error('Set SYSTEMFABRIC_WORKER_APPROVED=true only after production security review.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured for the outbox worker.');
  if (process.env.MEMGRAPH_ENABLED !== 'true') throw new Error('MEMGRAPH_ENABLED=true is required to run the graph projection worker.');
  const pool = createPostgresPool(process.env);
  const driver = createMemgraphDriver({ url: process.env.MEMGRAPH_URL, username: process.env.MEMGRAPH_USERNAME, password: process.env.MEMGRAPH_PASSWORD });
  const projector = createMemgraphProjector({ driver });
  const worker = createOutboxWorker({ pool, projector, onError: event => console.error(JSON.stringify({ type: 'systemfabric.outbox.error', ...event })) });
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.error('SystemFabric outbox worker started.');
  try { await worker.run({ signal: controller.signal, pollMs: 1000 }); }
  finally { await driver.close(); await pool.end(); }
}

main().catch(error => { console.error(`Outbox worker failed: ${error.message}`); process.exitCode = 1; });
