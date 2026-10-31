'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPostgresPool, createPostgresStore } = require('../../packages/db/src/postgres-store');
const { createOutboxWorker } = require('../../packages/db/src/outbox-worker');
const { eventEnvelopeFromOutboxRow } = require('../../packages/realtime/src/event-contract');

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
  const domainEvent = await pool.query(
    "SELECT id,aggregate_type,aggregate_id,aggregate_version,event_type,payload,schema_version,site_id,actor_id,correlation_id,causation_id,classification,created_at FROM outbox_events WHERE aggregate_id=$1 AND event_type='content.upsert' ORDER BY created_at DESC LIMIT 1",
    [saved.id]
  );
  assert.equal(domainEvent.rows[0].site_id, siteA);
  assert.equal(domainEvent.rows[0].actor_id, authorId);
  assert.equal(domainEvent.rows[0].schema_version, 1);
  assert.equal(domainEvent.rows[0].classification, 'site-private');
  const envelope = eventEnvelopeFromOutboxRow(domainEvent.rows[0]);
  assert.equal(envelope.eventId, domainEvent.rows[0].id);
  assert.equal(envelope.siteId, siteA);
  assert.equal(envelope.actor.id, authorId);
  assert.equal(domainEvent.rows[0].aggregate_version, saved.lock_version);
  assert.equal(envelope.resource.version, saved.lock_version);
  assert.equal(domainEvent.rows[0].payload.version, saved.version);
  assert.equal(envelope.idempotencyKey, 'content:' + saved.id + ':' + saved.lock_version + ':content.upsert');
  const publishEvent = await pool.query(
    "SELECT aggregate_version,payload FROM outbox_events WHERE aggregate_id=$1 AND event_type='content.publish' ORDER BY created_at DESC LIMIT 1",
    [saved.id]
  );
  assert.equal(publishEvent.rows[0].aggregate_version, published.lock_version);
  assert.equal(publishEvent.rows[0].payload.version, saved.version, 'projection sequence and editorial revision remain distinct');
});

test('PostgreSQL integration: concurrent outbox workers claim events once and quarantine poison events', { skip: !enabled }, async t => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: '8' });
  const runKeys = Array.from({ length: 20 }, () => randomUUID());
  const poisonKey = randomUUID();
  t.after(async () => { await pool.query("DELETE FROM outbox_events WHERE aggregate_type IN ('integration-outbox','integration-outbox-poison')"); await pool.end(); });
  for (const eventKey of runKeys) await pool.query("INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('integration-outbox',$1,1,'integration.noop',$2::jsonb) ON CONFLICT DO NOTHING", [randomUUID(), JSON.stringify({ eventKey })]);
  await pool.query("INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('integration-outbox-poison',$1,1,'integration.poison',$2::jsonb) ON CONFLICT DO NOTHING", [randomUUID(), JSON.stringify({ eventKey: poisonKey })]);
  const applied = [];
  const projector = { async apply({ type, payload, envelope }) { assert.equal(envelope.eventType, type); assert.equal(envelope.classification, 'internal'); if (type === 'integration.poison') { const e = new Error('fixture failure'); e.code = 'ERR_TEST_POISON'; throw e; } if (payload.eventKey) { await new Promise(resolve => setTimeout(resolve, 5)); applied.push(payload.eventKey); } } };
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
    async apply({ type, payload, envelope }) {
      assert.equal(type, 'integration.recovery');
      assert.equal(envelope.eventType, type);
      assert.equal(envelope.classification, 'internal');
      assert.equal(envelope.resource.id, aggregateId);

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

test('PostgreSQL integration: consumer groups independently deliver events under concurrent workers', { skip: !enabled }, async t => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: '8' });
  const consumerGroup = `it.delivery.${randomUUID().replaceAll('-', '')}`;
  const aggregateIds = Array.from({ length: 12 }, () => randomUUID());
  const applied = [];
  t.after(async () => {
    await pool.query('DELETE FROM outbox_consumer_groups WHERE consumer_group=$1', [consumerGroup]).catch(() => {});
    await pool.query("DELETE FROM outbox_events WHERE aggregate_type='integration-delivery' AND aggregate_id=ANY($1::uuid[])", [aggregateIds]).catch(() => {});
    await pool.end();
  });

  for (let index = 0; index < aggregateIds.length; index++) {
    await pool.query(
      `INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload)
       VALUES('integration-delivery',$1,1,'integration.delivery',$2::jsonb)`,
      [aggregateIds[index], JSON.stringify({ eventKey: `event-${index}` })]
    );
  }

  const { createOutboxDeliveryWorker } = require('../../packages/db/src/outbox-delivery');
  const handler = async ({ envelope, payload }) => {
    assert.equal(envelope.eventType, 'integration.delivery');
    await new Promise(resolve => setTimeout(resolve, 5));
    applied.push(payload.eventKey);
  };
  const workerA = createOutboxDeliveryWorker({
    pool, consumerGroup, eventTypes: ['integration.delivery'], handler, workerId: `it-delivery-a-${randomUUID()}`,
    batchSize: 6, dispatchBatchSize: 50
  });
  const workerB = createOutboxDeliveryWorker({
    pool, consumerGroup, eventTypes: ['integration.delivery'], handler, workerId: `it-delivery-b-${randomUUID()}`,
    batchSize: 6, dispatchBatchSize: 50
  });

  await Promise.all([workerA.runOnce(), workerB.runOnce()]);
  assert.equal(applied.length, aggregateIds.length);
  assert.equal(new Set(applied).size, aggregateIds.length);

  const deliveryCounts = await pool.query(
    `SELECT status,count(*)::int AS count
       FROM outbox_deliveries
      WHERE consumer_group=$1
      GROUP BY status`,
    [consumerGroup]
  );
  assert.equal(deliveryCounts.rows.find(row => row.status === 'processed')?.count, aggregateIds.length);

  // A distinct consumer group gets its own durable copy of the same source events.
  const secondGroup = `it.delivery.${randomUUID().replaceAll('-', '')}`;
  t.after(async () => {
    await pool.query('DELETE FROM outbox_consumer_groups WHERE consumer_group=$1', [secondGroup]).catch(() => {});
  });
  const secondWorker = createOutboxDeliveryWorker({
    pool, consumerGroup: secondGroup, eventTypes: ['integration.delivery'], handler: async () => {},
    batchSize: 50, dispatchBatchSize: 50
  });
  const secondResult = await secondWorker.runOnce();
  assert.equal(secondResult.dispatched, aggregateIds.length);
  const secondCount = await pool.query(
    'SELECT count(*)::int AS count FROM outbox_deliveries WHERE consumer_group=$1 AND status=$2',
    [secondGroup, 'processed']
  );
  assert.equal(secondCount.rows[0].count, aggregateIds.length);
});

test('PostgreSQL integration: per-aggregate ordering blocks behind dead events until replay', { skip: !enabled }, async t => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: '4' });
  const consumerGroup = `it.order.${randomUUID().replaceAll('-', '')}`;
  const aggregateId = randomUUID();
  const versions = [];
  let failFirstAttempt = true;
  t.after(async () => {
    await pool.query('DELETE FROM outbox_consumer_groups WHERE consumer_group=$1', [consumerGroup]).catch(() => {});
    await pool.query("DELETE FROM outbox_events WHERE aggregate_type='integration-delivery-order' AND aggregate_id=$1", [aggregateId]).catch(() => {});
    await pool.end();
  });

  const first = await pool.query(
    `INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload)
     VALUES('integration-delivery-order',$1,1,'integration.delivery.order',$2::jsonb)
     RETURNING id`,
    [aggregateId, JSON.stringify({ version: 1 })]
  );
  await pool.query(
    `INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload)
     VALUES('integration-delivery-order',$1,2,'integration.delivery.order',$2::jsonb)`,
    [aggregateId, JSON.stringify({ version: 2 })]
  );

  const { createOutboxDeliveryWorker, replayOutboxDeliveries } = require('../../packages/db/src/outbox-delivery');
  const worker = createOutboxDeliveryWorker({
    pool, consumerGroup, eventTypes: ['integration.delivery.order'], maxAttempts: 1, batchSize: 10, dispatchBatchSize: 20,
    handler: async ({ payload }) => {
      versions.push(payload.version);
      if (payload.version === 1 && failFirstAttempt) {
        failFirstAttempt = false;
        throw Object.assign(new Error('temporary poison fixture'), { code: 'ERR_TEST_ORDER_RETRY' });
      }
    }
  });

  const failed = await worker.runOnce();
  assert.equal(failed.claimed, 1, 'version 2 must wait for version 1');
  assert.equal(failed.results[0].dead, true);

  const blocked = await worker.runOnce();
  assert.equal(blocked.claimed, 0, 'a dead predecessor must block later aggregate versions');
  const states = await pool.query(
    `SELECT e.aggregate_version,d.status
       FROM outbox_deliveries d JOIN outbox_events e ON e.id=d.event_id
      WHERE d.consumer_group=$1 AND e.aggregate_id=$2
      ORDER BY e.aggregate_version`,
    [consumerGroup, aggregateId]
  );
  assert.deepEqual(states.rows.map(row => [row.aggregate_version, row.status]), [[1, 'dead'], [2, 'pending']]);

  const replay = await replayOutboxDeliveries({ pool, consumerGroup, eventIds: [first.rows[0].id] });
  assert.equal(replay.replayed, 1);
  const replayedFirst = await worker.runOnce();
  assert.equal(replayedFirst.results[0].ok, true);
  const second = await worker.runOnce();
  assert.equal(second.results[0].ok, true);
  assert.deepEqual(versions, [1, 1, 2]);

  const completed = await pool.query(
    "SELECT count(*)::int AS count FROM outbox_deliveries WHERE consumer_group=$1 AND status='processed'",
    [consumerGroup]
  );
  assert.equal(completed.rows[0].count, 2);
});

test('PostgreSQL integration: expired delivery leases are reclaimed after worker loss', { skip: !enabled }, async t => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: '4' });
  const consumerGroup = `it.lease.${randomUUID().replaceAll('-', '')}`;
  const aggregateId = randomUUID();
  t.after(async () => {
    await pool.query('DELETE FROM outbox_consumer_groups WHERE consumer_group=$1', [consumerGroup]).catch(() => {});
    await pool.query("DELETE FROM outbox_events WHERE aggregate_type='integration-delivery-lease' AND aggregate_id=$1", [aggregateId]).catch(() => {});
    await pool.end();
  });

  const inserted = await pool.query(
    `INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload)
     VALUES('integration-delivery-lease',$1,1,'integration.delivery.lease',$2::jsonb)
     RETURNING id`,
    [aggregateId, JSON.stringify({ simulated: 'worker-crash' })]
  );
  await pool.query(
    'INSERT INTO outbox_consumer_groups(consumer_group,event_types) VALUES($1,$2::text[])',
    [consumerGroup, ['integration.delivery.lease']]
  );
  await pool.query(
    `INSERT INTO outbox_deliveries(
       event_id,consumer_group,status,attempts,locked_by,locked_at,lease_expires_at
     ) VALUES($1,$2,'processing',1,'crashed-worker',now()-interval '2 minutes',now()-interval '1 minute')`,
    [inserted.rows[0].id, consumerGroup]
  );

  const { createOutboxDeliveryWorker } = require('../../packages/db/src/outbox-delivery');
  let handled = 0;
  const worker = createOutboxDeliveryWorker({
    pool, consumerGroup, eventTypes: ['integration.delivery.lease'], handler: async () => { handled++; }
  });
  const result = await worker.runOnce();
  assert.equal(result.claimed, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(handled, 1);
  const state = await pool.query(
    'SELECT status,attempts,locked_by FROM outbox_deliveries WHERE event_id=$1 AND consumer_group=$2',
    [inserted.rows[0].id, consumerGroup]
  );
  assert.deepEqual(state.rows[0], { status: 'processed', attempts: 2, locked_by: null });
});
