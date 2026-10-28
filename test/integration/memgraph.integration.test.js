'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMemgraphDriver, createMemgraphProjector } = require('../../packages/graph/src/memgraph-store');

const enabled = Boolean(process.env.MEMGRAPH_URL && process.env.SYSTEMFABRIC_RUN_MEMGRAPH_INTEGRATION === 'true');

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
