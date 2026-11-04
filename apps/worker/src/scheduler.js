'use strict';

const path = require('node:path');
const { loadEnvFile } = require('../../../scripts/load-env');
const { createPostgresPool, createPostgresStore } = require('../../../packages/db/src/postgres-store');
const { reconcileExpiredStripeCheckouts } = require('../../../packages/billing/src/checkout-reconciliation');
const { initializeTracing, withSpan } = require('../../../packages/observability/src/tracing');
const { initializeLogExport } = require('../../../packages/observability/src/otel-logs');
const { createStructuredLogger } = require('../../../packages/observability/src/structured-logger');

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured for scheduled publishing.');
  const serviceVersion = require('../../../package.json').version;
  const tracingRuntime = initializeTracing({ env: process.env, serviceName: 'virgoscorpio-hub-scheduler', serviceVersion });
  let logRuntime;
  try {
    logRuntime = initializeLogExport({ env: process.env, serviceName: 'virgoscorpio-hub-scheduler', serviceVersion });
  } catch (error) {
    await tracingRuntime.shutdown().catch(() => {});
    throw error;
  }
  const structuredLogger = createStructuredLogger({
    logger: console,
    otelLogger: logRuntime.logger,
    service: 'virgoscorpio-hub-scheduler',
    environment: process.env.NODE_ENV || 'development'
  });
  let pool = null;
  try {
    pool = createPostgresPool(process.env);
    const store = createPostgresStore({ pool });
    const interval = Math.max(1000, Math.min(60_000, Number(process.env.VIRGOSCORPIO_HUB_SCHEDULER_INTERVAL_MS || 5000)));
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    process.on('SIGTERM', () => controller.abort());
    structuredLogger.emit('info', 'virgoscorpio_hub.scheduler.started', {
      component: 'scheduler', operation: 'startup', outcome: 'success', intervalMs: interval
    });
    if (!process.env.STRIPE_SECRET_KEY) structuredLogger.emit('warn', 'virgoscorpio_hub.scheduler.checkout_reconciliation_disabled', {
      component: 'scheduler', operation: 'checkout_reconciliation', outcome: 'disabled'
    });
    while (!controller.signal.aborted) {
      try {
        const published = await withSpan('scheduler.publish_due', {
          'virgoscorpio_hub.component': 'scheduler',
          'virgoscorpio_hub.operation': 'publish_due'
        }, () => store.publishDue({ limit: 25 }));
        if (published.length) structuredLogger.emit('info', 'virgoscorpio_hub.scheduler.published', {
          component: 'scheduler', operation: 'publish_due', count: published.length, outcome: 'success'
        });
        if (process.env.STRIPE_SECRET_KEY) {
          const reconciliation = await withSpan('scheduler.checkout_reconciliation', {
            'virgoscorpio_hub.component': 'scheduler',
            'virgoscorpio_hub.operation': 'checkout_reconciliation'
          }, () => reconcileExpiredStripeCheckouts(pool, { secretKey: process.env.STRIPE_SECRET_KEY, batchSize: 100 }));
          if (reconciliation.checked || reconciliation.errors || reconciliation.unlinked) structuredLogger.emit(
            reconciliation.errors ? 'warn' : 'info',
            'virgoscorpio_hub.scheduler.checkout_reconciliation',
            { component: 'scheduler', operation: 'checkout_reconciliation', ...reconciliation }
          );
        }
      } catch (error) { structuredLogger.emit('error', 'virgoscorpio_hub.scheduler.error', {
        component: 'scheduler', operation: 'run', outcome: 'failure',
        code: error?.code || 'ERR_SCHEDULER', errorType: error?.name || 'Error'
      }); }
      await new Promise(resolve => { const timer = setTimeout(resolve, interval); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  } finally {
    try {
      if (pool) await pool.end();
    } finally {
      await Promise.all([tracingRuntime.shutdown().catch(() => {}), logRuntime.shutdown().catch(() => {})]);
    }
  }
}
if (require.main === module) main().catch(error => {
  const bootstrapLogger = createStructuredLogger({ service: 'virgoscorpio-hub-scheduler', environment: process.env.NODE_ENV || 'development' });
  bootstrapLogger.emit('error', 'virgoscorpio_hub.scheduler.start_failed', {
    component: 'scheduler', operation: 'startup', outcome: 'failure',
    code: error?.code, errorType: error?.name || 'Error'
  });
  process.exitCode = 1;
});
module.exports = { main };
