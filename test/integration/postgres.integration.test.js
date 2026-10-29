'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPostgresPool, createPostgresStore } = require('../../packages/db/src/postgres-store');
const { createOutboxWorker } = require('../../packages/db/src/outbox-worker');

const enabled = Boolean(process.env.DATABASE_URL && process.env.SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION === 'true');

test('PostgreSQL integration: revisions, publication snapshots, outbox, and site isolation', { skip: !enabled }, async t => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: '4' });
  const store = createPostgresStore({ pool });
  const a = await pool.query('INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id', [`it-${randomUUID().slice(0, 8)}`, 'Integration Site A']);
  const b = await pool.query('INSERT INTO sites(slug,name) VALUES($1,$2) RETURNING id', [`it-${randomUUID().slice(0, 8)}`, 'Integration Site B']);
  const siteA = a.rows[0].id; const siteB = b.rows[0].id;
  const author = await pool.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`it-author-${randomUUID()}@example.test`, 'Integration Author']);
  const authorId = author.rows[0].id;
  t.after(async () => {
    await pool.query("DELETE FROM outbox_events WHERE aggregate_type IN ('integration-outbox','integration-outbox-poison') OR aggregate_id IN (SELECT id FROM content_items WHERE site_id=ANY($1::uuid[]))", [[siteA, siteB]]).catch(() => {});
    await pool.query('DELETE FROM sites WHERE id=ANY($1::uuid[])', [[siteA, siteB]]);
    await pool.query('DELETE FROM users WHERE id=$1', [authorId]);
    await pool.end();
  });

  const document = { schemaVersion: 1, documentId: 'integration-doc', type: 'page', title: 'Integration Page', children: [{ id: 'heading-1', type: 'widget.heading', props: { text: 'Hello integration' }, children: [] }] };
  const saved = await store.saveDraft({ siteId: siteA, title: 'Integration Page', slug: 'integration-page', locale: 'en', contentType: 'page', document, authorId, note: 'integration fixture' });
  assert.equal(saved.status, 'draft');
  assert.equal(saved.version, 1);
  assert.equal(await store.getById({ siteId: siteB, id: saved.id }), null);
  assert.equal((await store.listRevisions({ siteId: siteA, contentId: saved.id })).length, 1);
  const draftWorkflow = await pool.query("SELECT actor_id FROM workflow_events WHERE site_id=$1 AND content_id=$2 AND action='draft_saved' ORDER BY created_at DESC LIMIT 1", [siteA, saved.id]);
  assert.equal(draftWorkflow.rows[0]?.actor_id, authorId, 'draft workflow event should record the author as its actor');

  const submitted = await store.submitForReview({ siteId: siteA, id: saved.id, expectedVersion: saved.version, note: 'review fixture' });
  const approved = await store.approve({ siteId: siteA, id: saved.id, expectedVersion: submitted.version, note: 'approved fixture' });
  const published = await store.publishContent({ siteId: siteA, id: saved.id, expectedVersion: approved.version, note: 'publish fixture' });
  assert.equal(published.status, 'published');
  const publicRecord = await store.getPublishedBySlug({ siteId: siteA, slug: 'integration-page', locale: 'en' });
  assert.equal(publicRecord.title, 'Integration Page');
  assert.equal(publicRecord.body.children[0].props.text, 'Hello integration');
  assert.equal(await store.getPublishedBySlug({ siteId: siteB, slug: 'integration-page', locale: 'en' }), null);
  const outbox = await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1 AND status='pending'", [saved.id]);
  assert.ok(outbox.rows[0].n >= 2);
});

test('PostgreSQL integration: concurrent outbox workers claim events once and quarantine poison events', { skip: !enabled }, async t => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: '8' });
  const runKeys = Array.from({ length: 20 }, () => randomUUID());
  const poisonKey = randomUUID();
  t.after(async () => { await pool.query("DELETE FROM outbox_events WHERE aggregate_type IN ('integration-outbox','integration-outbox-poison')"); await pool.end(); });
  for (const eventKey of runKeys) await pool.query("INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('integration-outbox',$1,1,'integration.noop',$2::jsonb) ON CONFLICT DO NOTHING", [randomUUID(), JSON.stringify({ eventKey })]);
  await pool.query("INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('integration-outbox-poison',$1,1,'integration.poison',$2::jsonb) ON CONFLICT DO NOTHING", [randomUUID(), JSON.stringify({ eventKey: poisonKey })]);
  const applied = [];
  const projector = { async apply({ type, payload }) { if (type === 'integration.poison') { const e = new Error('fixture failure'); e.code = 'ERR_TEST_POISON'; throw e; } if (payload.eventKey) { await new Promise(resolve => setTimeout(resolve, 5)); applied.push(payload.eventKey); } } };
  const first = createOutboxWorker({ pool, projector, workerId: `it-a-${randomUUID()}`, batchSize: 50, maxAttempts: 1 });
  const second = createOutboxWorker({ pool, projector, workerId: `it-b-${randomUUID()}`, batchSize: 50, maxAttempts: 1 });
  await Promise.all([first.runOnce(), second.runOnce()]);
  assert.equal(applied.length, 20);
  assert.equal(new Set(applied).size, 20);
  const dead = await pool.query("SELECT status,attempts,last_error_code FROM outbox_events WHERE event_type='integration.poison' AND payload->>'eventKey'=$1", [poisonKey]);
  assert.equal(dead.rows[0]?.status, 'dead');
  assert.equal(dead.rows[0]?.attempts, 1);
  assert.equal(dead.rows[0]?.last_error_code, 'ERR_TEST_POISON');
});
test('PostgreSQL integration: failed transaction rolls back earlier writes', { skip: !enabled }, async t => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: '2' });
  const slug = `rollback-it-${randomUUID().slice(0, 10)}`;

  t.after(async () => {
    await pool.query('DELETE FROM sites WHERE slug=$1', [slug]).catch(() => {});
    await pool.end();
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      'INSERT INTO sites(slug,name) VALUES($1,$2)',
      [slug, 'Rollback Integration Site']
    );

    await assert.rejects(
      client.query(
        'INSERT INTO sites(slug,name) VALUES($1,$2)',
        [slug, 'Duplicate Rollback Integration Site']
      ),
      error => error.code === '23505'
    );

    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const persisted = await pool.query(
    'SELECT id FROM sites WHERE slug=$1',
    [slug]
  );

  assert.equal(
    persisted.rows.length,
    0,
    'A failed transaction must not persist earlier writes'
  );
});

test('PostgreSQL integration: outbox recovers after a transient graph-projection failure', { skip: !enabled }, async t => {
  const pool = createPostgresPool({
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_POOL_MAX: '4',
  });

  const aggregateId = randomUUID();
  const eventKey = randomUUID();
  const errors = [];
  const projected = [];
  let graphAvailable = false;

  t.after(async () => {
    await pool.query(
      "DELETE FROM outbox_events WHERE aggregate_type='integration-outbox-recovery' AND aggregate_id=$1",
      [aggregateId]
    ).catch(() => {});
    await pool.end();
  });

  const existing = await pool.query(
    "SELECT count(*)::int AS count FROM outbox_events WHERE status IN ('pending','processing')"
  );

  assert.equal(
    existing.rows[0].count,
    0,
    'The isolated integration database must not contain unrelated pending outbox events'
  );

  const inserted = await pool.query(
    `INSERT INTO outbox_events(
       aggregate_type,aggregate_id,aggregate_version,event_type,payload
     )
     VALUES('integration-outbox-recovery',$1,1,'integration.recovery',$2::jsonb)
     RETURNING id`,
    [aggregateId, JSON.stringify({ eventKey })]
  );

  const eventId = inserted.rows[0].id;

  const projector = {
    async apply({ type, payload }) {
      assert.equal(type, 'integration.recovery');

      if (!graphAvailable) {
        throw Object.assign(
          new Error('Simulated graph-projection outage'),
          { code: 'ERR_TEST_GRAPH_UNAVAILABLE' }
        );
      }

      projected.push(payload.eventKey);
    }
  };

  const worker = createOutboxWorker({
    pool,
    projector,
    workerId: `it-recovery-${randomUUID()}`,
    batchSize: 10,
    maxAttempts: 3,
    onError: error => errors.push(error),
  });

  // First attempt: graph projection is unavailable.
  const first = await worker.runOnce();

  assert.equal(first.claimed, 1);
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].id, eventId);
  assert.equal(first.results[0].ok, false);
  assert.equal(first.results[0].dead, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorCode, 'ERR_TEST_GRAPH_UNAVAILABLE');

  const failed = await pool.query(
    `SELECT status,attempts,last_error_code,locked_by,lease_expires_at
       FROM outbox_events
      WHERE id=$1`,
    [eventId]
  );

  assert.equal(failed.rows[0].status, 'pending');
  assert.equal(failed.rows[0].attempts, 1);
  assert.equal(failed.rows[0].last_error_code, 'ERR_TEST_GRAPH_UNAVAILABLE');
  assert.equal(failed.rows[0].locked_by, null);
  assert.equal(failed.rows[0].lease_expires_at, null);

  // Make the retry immediately eligible instead of waiting for backoff.
  const retryReady = await pool.query(
    `UPDATE outbox_events
        SET available_at=now()-interval '1 second'
      WHERE id=$1 AND status='pending'
      RETURNING id`,
    [eventId]
  );

  assert.equal(retryReady.rowCount, 1);

  // Simulate recovery and retry the persisted event.
  graphAvailable = true;

  const second = await worker.runOnce();

  assert.equal(second.claimed, 1);
  assert.equal(second.results[0].id, eventId);
  assert.equal(second.results[0].ok, true);
  assert.deepEqual(projected, [eventKey]);

  const recovered = await pool.query(
    `SELECT status,attempts,last_error_code,processed_at,locked_by
       FROM outbox_events
      WHERE id=$1`,
    [eventId]
  );

  assert.equal(recovered.rows[0].status, 'processed');
  assert.equal(recovered.rows[0].attempts, 2);
  assert.equal(recovered.rows[0].last_error_code, null);
  assert.ok(recovered.rows[0].processed_at);
  assert.equal(recovered.rows[0].locked_by, null);

  // A completed event must not be processed again.
  const third = await worker.runOnce();

  assert.equal(third.claimed, 0);
  assert.deepEqual(projected, [eventKey]);
});