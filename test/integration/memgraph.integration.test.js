'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMemgraphDriver, createMemgraphProjector } = require('../../packages/graph/src/memgraph-store');
const { createPostgresPool } = require('../../packages/db/src/postgres-store');
const { createGraphProjectionWorker, GRAPH_PROJECTION_EVENT_TYPES } = require('../../apps/worker/src/outbox-worker');
const { replayOutboxDeliveries } = require('../../packages/db/src/outbox-delivery');

const enabled = Boolean(process.env.MEMGRAPH_URL && process.env.SYSTEMFABRIC_RUN_MEMGRAPH_INTEGRATION === 'true');
const postgresEnabled = Boolean(process.env.DATABASE_URL && process.env.SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION === 'true');

test('Memgraph integration: monotonic graph projections, relationship tombstones, and tenant-scoped reads', { skip: !enabled }, async t => {
  const driver = createMemgraphDriver({ url: process.env.MEMGRAPH_URL, username: process.env.MEMGRAPH_USERNAME || '', password: process.env.MEMGRAPH_PASSWORD || '' });
  const projector = createMemgraphProjector({ driver });
  const siteId = randomUUID();
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const relationshipId = randomUUID();
  const session = driver.session();
  try {
    await session.run('RETURN 1 AS ready');
    await projector.apply({ type: 'content.upsert', payload: { id: sourceId, siteId, contentType: 'page', slug: 'source', locale: 'en', status: 'published', title: 'v1', version: 1 } });
    await projector.apply({ type: 'content.upsert', payload: { id: sourceId, siteId, contentType: 'page', slug: 'source', locale: 'en', status: 'published', title: 'v2', version: 2 } });
    await projector.apply({ type: 'content.upsert', payload: { id: sourceId, siteId, contentType: 'page', slug: 'stale', locale: 'en', status: 'draft', title: 'stale', version: 1 } });
    await projector.apply({ type: 'content.upsert', payload: { id: targetId, siteId, contentType: 'page', slug: 'target', locale: 'en', status: 'published', title: 'target', version: 1 } });

    const content = await session.run('MATCH (n:Content {id:$id, siteId:$siteId}) RETURN n.version AS version,n.slug AS slug,n.status AS status', { id: sourceId, siteId });
    assert.equal(content.records[0].get('version'), 2);
    assert.equal(content.records[0].get('slug'), 'source');
    assert.equal(content.records[0].get('status'), 'published');

    await projector.apply({ type: 'relationship.upsert', payload: { relationshipId, siteId, sourceId, targetId, sourceType: 'content', targetType: 'content', kind: 'RELATED_TO', version: 1 } });
    assert.equal((await projector.findRelated({ id: sourceId, siteId, kind: 'RELATED_TO' })).length, 1);
    assert.equal((await projector.findRelated({ id: sourceId, siteId: randomUUID(), kind: 'RELATED_TO' })).length, 0);
    await projector.apply({ type: 'relationship.delete', payload: { relationshipId, siteId, sourceId, targetId, sourceType: 'content', targetType: 'content', kind: 'RELATED_TO', version: 3 } });
    await projector.apply({ type: 'relationship.upsert', payload: { relationshipId, siteId, sourceId, targetId, sourceType: 'content', targetType: 'content', kind: 'RELATED_TO', version: 2 } });
    assert.equal((await projector.findRelated({ id: sourceId, siteId, kind: 'RELATED_TO' })).length, 0);
    const tombstone = await session.run('MATCH (r:RelationshipProjection {id:$id, siteId:$siteId}) RETURN r.version AS version,r.status AS status', { id: relationshipId, siteId });
    assert.equal(tombstone.records[0].get('version'), 3);
    assert.equal(tombstone.records[0].get('status'), 'deleted');
  } finally {
    await session.run('MATCH (n) WHERE n.siteId=$siteId DETACH DELETE n', { siteId }).catch(() => {});
    await session.close();
    await projector.close();
  }
});


test('Memgraph integration: durable graph consumer group projects in aggregate order and safely replays stale versions', { skip: !(enabled && postgresEnabled) }, async t => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: '6' });
  const driver = createMemgraphDriver({
    url: process.env.MEMGRAPH_URL,
    username: process.env.MEMGRAPH_USERNAME || '',
    password: process.env.MEMGRAPH_PASSWORD || ''
  });
  const projector = createMemgraphProjector({ driver });
  const siteId = randomUUID();
  const contentId = randomUUID();
  const consumerGroup = `it.graph.projection.${randomUUID().replaceAll('-', '')}`;
  const eventIds = [];

  t.after(async () => {
    await pool.query('DELETE FROM outbox_consumer_groups WHERE consumer_group=$1', [consumerGroup]).catch(() => {});
    await pool.query('DELETE FROM sites WHERE id=$1', [siteId]).catch(() => {});
    const session = driver.session();
    try {
      await session.run('MATCH (n:Content {id:$id,siteId:$siteId}) DETACH DELETE n', { id: contentId, siteId });
    } finally {
      await session.close();
      await projector.close();
      await pool.end();
    }
  });

  await driver.verifyConnectivity();
  const site = await pool.query(
    'INSERT INTO sites(id,slug,name) VALUES($1,$2,$3) RETURNING id',
    [siteId, `it-graph-delivery-${randomUUID().slice(0, 8)}`, 'Graph Delivery Integration Site']
  );
  assert.equal(site.rows[0].id, siteId);

  // Mark the pre-existing event history as already consumed for this new test
  // group, then append controlled versions for the end-to-end cutover check.
  await pool.query(
    'INSERT INTO outbox_consumer_groups(consumer_group,event_types) VALUES($1,$2::text[])',
    [consumerGroup, GRAPH_PROJECTION_EVENT_TYPES]
  );
  await pool.query(
    `INSERT INTO outbox_deliveries(event_id,consumer_group,status,processed_at)
     SELECT id,$1,'processed',now() FROM outbox_events
     ON CONFLICT (event_id,consumer_group) DO NOTHING`,
    [consumerGroup]
  );

  const projectionEvents = [
    {
      aggregateVersion: 1,
      type: 'content.upsert',
      payload: {
        id: contentId, siteId, contentType: 'page', slug: 'durable-projection',
        locale: 'en', status: 'draft', title: 'Durable Projection',
        version: 1
      }
    },
    {
      aggregateVersion: 2,
      type: 'content.publish',
      payload: { id: contentId, siteId, slug: 'durable-projection', locale: 'en', status: 'published', version: 1 }
    },
    {
      aggregateVersion: 3,
      type: 'content.unpublish',
      payload: { id: contentId, siteId, slug: 'durable-projection', locale: 'en', status: 'draft', version: 1 }
    }
  ];

  for (const event of projectionEvents) {
    const inserted = await pool.query(
      `INSERT INTO outbox_events(
         aggregate_type,aggregate_id,aggregate_version,event_type,payload,
         schema_version,site_id,classification
       )
       VALUES('content',$1,$2,$3,$4::jsonb,1,$5,'site-private')
       RETURNING id`,
      [contentId, event.aggregateVersion, event.type, JSON.stringify(event.payload), siteId]
    );
    eventIds.push(inserted.rows[0].id);
  }

  const worker = createGraphProjectionWorker({
    pool,
    projector,
    consumerGroup,
    workerId: `it-graph-projector-${randomUUID()}`,
    batchSize: 10,
    dispatchBatchSize: 20,
    maxAttempts: 3
  });

  const first = await worker.runOnce();
  assert.equal(first.dispatched, 3);
  assert.equal(first.claimed, 1, 'the first aggregate event must be acknowledged before the next version');
  assert.equal(first.results[0].ok, true);
  const second = await worker.runOnce();
  assert.equal(second.claimed, 1);
  assert.equal(second.results[0].ok, true);
  const third = await worker.runOnce();
  assert.equal(third.claimed, 1);
  assert.equal(third.results[0].ok, true);

  const session = driver.session();
  try {
    const current = await session.run(
      'MATCH (n:Content {id:$id,siteId:$siteId}) RETURN n.version AS version,n.projectionVersion AS projectionVersion,n.status AS status',
      { id: contentId, siteId }
    );
    assert.equal(current.records.length, 1);
    assert.equal(current.records[0].get('version'), 1, 'workflow transitions do not create a new content revision');
    assert.equal(current.records[0].get('projectionVersion'), 3);
    assert.equal(current.records[0].get('status'), 'draft');
  } finally {
    await session.close();
  }

  // Replaying the older publish transition after unpublish must not restore stale state.
  const replay = await replayOutboxDeliveries({
    pool, consumerGroup, eventIds: [eventIds[1]], statuses: ['processed']
  });
  assert.equal(replay.replayed, 1);
  const replayed = await worker.runOnce();
  assert.equal(replayed.claimed, 1);
  assert.equal(replayed.results[0].ok, true);

  const verify = driver.session();
  try {
    const unchanged = await verify.run(
      'MATCH (n:Content {id:$id,siteId:$siteId}) RETURN n.projectionVersion AS projectionVersion,n.status AS status',
      { id: contentId, siteId }
    );
    assert.equal(unchanged.records[0].get('projectionVersion'), 3);
    assert.equal(unchanged.records[0].get('status'), 'draft');
  } finally {
    await verify.close();
  }
});
