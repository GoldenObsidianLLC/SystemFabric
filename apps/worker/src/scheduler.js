'use strict';

const path = require('node:path');
const { loadEnvFile } = require('../../../scripts/load-env');
const { createPostgresPool, createPostgresStore } = require('../../../packages/db/src/postgres-store');
const { reconcileExpiredStripeCheckouts } = require('../../../packages/billing/src/checkout-reconciliation');

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured for scheduled publishing.');
  const pool = createPostgresPool(process.env); const store = createPostgresStore({ pool });
  const interval = Math.max(1000, Math.min(60_000, Number(process.env.SYSTEMFABRIC_SCHEDULER_INTERVAL_MS || 5000)));
  const controller = new AbortController(); process.on('SIGINT', () => controller.abort()); process.on('SIGTERM', () => controller.abort());
  console.error(JSON.stringify({ type: 'systemfabric.scheduler.started', intervalMs: interval }));
  if (!process.env.STRIPE_SECRET_KEY) console.error(JSON.stringify({ type: 'systemfabric.scheduler.checkout_reconciliation_disabled', reason: 'STRIPE_SECRET_KEY is not configured; expired stock holds will be retained.' }));
  try {
    while (!controller.signal.aborted) {
      try {
        const published = await store.publishDue({ limit: 25 });
        if (published.length) console.log(JSON.stringify({ type: 'systemfabric.scheduler.published', count: published.length, contentIds: published.map(row => row.id) }));
        if (process.env.STRIPE_SECRET_KEY) {
          const reconciliation = await reconcileExpiredStripeCheckouts(pool, { secretKey: process.env.STRIPE_SECRET_KEY, batchSize: 100 });
          if (reconciliation.checked || reconciliation.errors || reconciliation.unlinked) console.log(JSON.stringify({ type: 'systemfabric.scheduler.checkout_reconciliation', ...reconciliation }));
        }
      } catch (error) { console.error(JSON.stringify({ type: 'systemfabric.scheduler.error', code: error.code || 'ERR_SCHEDULER', message: error.message })); }
      await new Promise(resolve => { const timer = setTimeout(resolve, interval); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(`Scheduler failed: ${error.message}`); process.exitCode = 1; });
module.exports = { main };
