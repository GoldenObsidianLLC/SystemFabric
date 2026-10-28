'use strict';

const { loadEnvFile } = require('../../../scripts/load-env');
const { createPostgresPool } = require('../../../packages/db/src/postgres-store');
const { sendEmail } = require('../../../packages/notifications/src/mailer');

async function processBatch(pool, { limit = 10, logger = console, clock = () => Date.now(), env = process.env } = {}) {
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
      const attempts = Number(row.attempts || 0) + 1; const terminal = attempts >= 8 || error.code === 'ERR_SYSTEMFABRIC_MAIL_REJECTED' || error.code === 'ERR_SYSTEMFABRIC_MAIL_PROVIDER' || error.code === 'ERR_SYSTEMFABRIC_MAIL_CONFIG' || error.code === 'ERR_SYSTEMFABRIC_MAIL_DISABLED';
      const delayMs = Math.min(6 * 60 * 60_000, 1_000 * (2 ** Math.min(attempts, 14)));
      await pool.query("UPDATE mail_outbox SET status=$2,attempts=$3,available_at=now()+($4 * interval '1 millisecond'),last_error_code=$5,locked_at=NULL WHERE id=$1", [row.id, terminal ? 'failed' : 'pending', attempts, delayMs, error.code || 'ERR_SYSTEMFABRIC_MAIL_FAILED']);
      logger.error?.(JSON.stringify({ type: 'systemfabric.mail.delivery_failure', outboxId: row.id, code: error.code || 'ERR_SYSTEMFABRIC_MAIL_FAILED', attempts, terminal }));
      results.push({ id: row.id, status: terminal ? 'failed' : 'retry' });
    }
  }
  return { processed: results.length, results, durationMs: Math.max(0, clock() - started) };
}

async function main() {
  loadEnvFile('.env');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = createPostgresPool(process.env); let stopping = false;
  const run = async () => { while (!stopping) { const batch = await processBatch(pool); if (!batch.processed) await new Promise(resolve => setTimeout(resolve, 2_000)); } };
  const shutdown = () => { stopping = true; };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  try { await run(); } finally { await pool.end(); }
}
if (require.main === module) void main().catch(error => { console.error(`SystemFabric mail worker failed: ${error.message}`); process.exitCode = 1; });
module.exports = { processBatch };
