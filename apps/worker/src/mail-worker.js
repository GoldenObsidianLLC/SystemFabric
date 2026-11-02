'use strict';

const { loadEnvFile } = require('../../../scripts/load-env');
const { createPostgresPool } = require('../../../packages/db/src/postgres-store');
const { sendEmail } = require('../../../packages/notifications/src/mailer');
const { initializeTracing } = require('../../../packages/observability/src/tracing');
const { initializeLogExport } = require('../../../packages/observability/src/otel-logs');
const { createStructuredLogger } = require('../../../packages/observability/src/structured-logger');

async function processBatch(pool, {
  limit = 10,
  logger = console,
  structuredLogger = null,
  clock = () => Date.now(),
  env = process.env
} = {}) {
  const log = structuredLogger || createStructuredLogger({
    logger,
    service: 'systemfabric-mail-worker',
    environment: env.NODE_ENV || 'development'
  });
  const started = clock();
  const client = await pool.connect(); let rows = [];
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT id,recipient,template,payload,attempts
      FROM mail_outbox WHERE status IN ('pending','failed') AND available_at<=now()
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
    rows = result.rows;
    if (rows.length) await client.query("UPDATE mail_outbox SET status='processing',locked_at=now() WHERE id=ANY($1::uuid[])", [rows.map(row => row.id)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }

  const results = [];
  for (const row of rows) {
    try {
      await sendEmail({ recipient: row.recipient, template: row.template, payload: row.payload }, env);
      await pool.query("UPDATE mail_outbox SET status='sent',sent_at=now(),payload='{}'::jsonb,last_error_code=NULL,locked_at=NULL WHERE id=$1", [row.id]);
      results.push({ id: row.id, status: 'sent' });
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const terminal = attempts >= 8 ||
        error.code === 'ERR_SYSTEMFABRIC_MAIL_REJECTED' ||
        error.code === 'ERR_SYSTEMFABRIC_MAIL_PROVIDER' ||
        error.code === 'ERR_SYSTEMFABRIC_MAIL_CONFIG' ||
        error.code === 'ERR_SYSTEMFABRIC_MAIL_DISABLED';
      const delayMs = Math.min(6 * 60 * 60_000, 1_000 * (2 ** Math.min(attempts, 14)));
      const errorCode = error.code || 'ERR_SYSTEMFABRIC_MAIL_FAILED';
      await pool.query(
        "UPDATE mail_outbox SET status=$2,attempts=$3,available_at=now()+($4 * interval '1 millisecond'),last_error_code=$5,locked_at=NULL WHERE id=$1",
        [row.id, terminal ? 'failed' : 'pending', attempts, delayMs, errorCode]
      );
      log.emit('error', 'systemfabric.mail.delivery_failure', {
        component: 'mail',
        operation: 'delivery',
        code: errorCode,
        attempts,
        terminal,
        outcome: terminal ? 'failed' : 'retry'
      });
      results.push({ id: row.id, status: terminal ? 'failed' : 'retry' });
    }
  }
  return { processed: results.length, results, durationMs: Math.max(0, clock() - started) };
}

async function main() {
  loadEnvFile('.env');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const serviceVersion = require('../../../package.json').version;
  const tracingRuntime = initializeTracing({
    env: process.env,
    serviceName: 'systemfabric-mail-worker',
    serviceVersion
  });
  let logRuntime;
  try {
    logRuntime = initializeLogExport({
      env: process.env,
      serviceName: 'systemfabric-mail-worker',
      serviceVersion
    });
  } catch (error) {
    await tracingRuntime.shutdown().catch(() => {});
    throw error;
  }
  const structuredLogger = createStructuredLogger({
    logger: console,
    otelLogger: logRuntime.logger,
    service: 'systemfabric-mail-worker',
    environment: process.env.NODE_ENV || 'development'
  });
  let pool = null;
  try {
    pool = createPostgresPool(process.env);
    let stopping = false;
    const run = async () => {
      while (!stopping) {
        const batch = await processBatch(pool, { structuredLogger });
        if (!batch.processed) await new Promise(resolve => setTimeout(resolve, 2_000));
      }
    };
    const shutdown = () => { stopping = true; };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    structuredLogger.emit('info', 'systemfabric.mail_worker.started', {
      component: 'mail', operation: 'startup', outcome: 'success'
    });
    await run();
  } finally {
    try {
      if (pool) await pool.end();
    } finally {
      await Promise.all([
        tracingRuntime.shutdown().catch(() => {}),
        logRuntime.shutdown().catch(() => {})
      ]);
    }
  }
}

if (require.main === module) void main().catch(error => {
  const bootstrapLogger = createStructuredLogger({
    service: 'systemfabric-mail-worker',
    environment: process.env.NODE_ENV || 'development'
  });
  bootstrapLogger.emit('error', 'systemfabric.mail_worker.start_failed', {
    component: 'mail',
    operation: 'startup',
    outcome: 'failure',
    code: error?.code,
    errorType: error?.name || 'Error'
  });
  process.exitCode = 1;
});

module.exports = { processBatch, main };
