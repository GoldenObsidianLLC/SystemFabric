'use strict';

const { randomUUID } = require('node:crypto');

function createOutboxWorker({ pool, projector, workerId = `sf-${randomUUID()}`, batchSize = 25, leaseMs = 30_000, maxAttempts = 10, onError = () => {} }) {
  if (!pool || !projector || typeof projector.apply !== 'function') throw new TypeError('pool and projector.apply are required.');
  async function claimBatch() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT id,event_type,payload,attempts FROM outbox_events WHERE ((status='pending' AND available_at<=now()) OR (status='processing' AND lease_expires_at<now())) ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batchSize]
      );
      if (selected.rows.length) {
        await client.query(
          `UPDATE outbox_events SET status='processing',locked_by=$2,locked_at=now(),lease_expires_at=now()+($3::text || ' milliseconds')::interval,attempts=attempts+1 WHERE id = ANY($1::uuid[])`,
          [selected.rows.map(row => row.id), workerId, leaseMs]
        );
      }
      await client.query('COMMIT');
      return selected.rows;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function processOne(event) {
    try {
      await projector.apply({ type: event.event_type, payload: event.payload });
      await pool.query(`UPDATE outbox_events SET status='processed',processed_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE id=$1 AND locked_by=$2`, [event.id, workerId]);
      return { id: event.id, ok: true };
    } catch (error) {
      const attempts = Number(event.attempts || 0) + 1;
      const dead = attempts >= maxAttempts;
      const delayMs = Math.min(3_600_000, 1000 * (2 ** Math.min(attempts, 12)));
      const code = String(error.code || 'ERR_GRAPH_PROJECTION').slice(0, 100);
      await pool.query(
        `UPDATE outbox_events SET status=$3,available_at=now()+($4::text || ' milliseconds')::interval,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error_code=$5 WHERE id=$1 AND locked_by=$2`,
        [event.id, workerId, dead ? 'dead' : 'pending', delayMs, code]
      );
      onError({ eventId: event.id, eventType: event.event_type, errorCode: code, dead });
      return { id: event.id, ok: false, dead, errorCode: code };
    }
  }
  return Object.freeze({
    async runOnce() {
      const events = await claimBatch();
      const results = [];
      for (const event of events) results.push(await processOne(event));
      return { claimed: events.length, results };
    },
    async run({ signal, pollMs = 1000 } = {}) {
      while (!signal?.aborted) {
        const result = await this.runOnce();
        if (result.claimed === 0) await new Promise(resolve => setTimeout(resolve, pollMs));
      }
    }
  });
}

module.exports = { createOutboxWorker };
