'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemgraphProjector } = require('../packages/graph/src/memgraph-store');
const { createWidgetRegistry } = require('../packages/widgets/src/registry');

function fakeDriver() {
  const calls = [];
  return {
    calls,
    session() { return { async executeWrite(fn) { return fn({ async run(cypher, params) { calls.push({ cypher, params }); return { records: [] }; } }); }, async run(cypher, params) { calls.push({ cypher, params }); return { records: [] }; }, async close() {} }; },
    async close() {}
  };
}

test('Memgraph projector only interpolates allow-listed relationship types', async () => {
  const driver = fakeDriver();
  const projector = createMemgraphProjector({ driver });
  await projector.apply({ type: 'relationship.upsert', payload: { relationshipId: 'r1', siteId: 's1', sourceId: 'a', targetId: 'b', kind: 'RELATED_TO', version: 1 } });
  assert.ok(driver.calls[0].cypher.includes(':RELATED_TO'));
  await assert.rejects(() => projector.apply({ type: 'relationship.upsert', payload: { relationshipId: 'r2', siteId: 's1', sourceId: 'a', targetId: 'b', kind: 'BAD) MATCH (n) DELETE n //', version: 1 } }), { code: 'ERR_GRAPH_RELATION_KIND' });
});

test('core widget registry lists required widget types', () => {
  const widgets = createWidgetRegistry();
  assert.equal(widgets.has('widget.heading'), true);
  assert.equal(widgets.has('widget.button'), true);
  assert.ok(widgets.list().length >= 7);
});

test('relationship reads exclude draft content even when a relationship exists', async () => {
  const driver = fakeDriver();
  const projector = createMemgraphProjector({ driver });
  await projector.findRelated({ id: 'source', siteId: 'site' });
  assert.match(driver.calls[0].cypher, /s\.status='published'/);
  assert.match(driver.calls[0].cypher, /t\.status='published'/);
});

test('related-content limits use a bounded integer literal accepted by Memgraph', async () => {
  const driver = fakeDriver();
  const projector = createMemgraphProjector({ driver });
  await projector.findRelated({ id: 'source', siteId: 'site', limit: 12.8 });
  assert.match(driver.calls[0].cypher, /LIMIT 12$/);
  assert.equal(Object.hasOwn(driver.calls[0].params, 'limit'), false);

  await projector.findRelated({ id: 'source', siteId: 'site', limit: 1000 });
  assert.match(driver.calls[1].cypher, /LIMIT 100$/);

  await projector.findRelated({ id: 'source', siteId: 'site', limit: 'invalid' });
  assert.match(driver.calls[2].cypher, /LIMIT 20$/);
});


test('taxonomy graph projection stores metadata as bounded scalar JSON text', async () => {
  const driver = fakeDriver();
  const projector = createMemgraphProjector({ driver });
  await projector.apply({ type: 'taxonomy.upsert', payload: { id: 'term-1', siteId: 'site-1', taxonomy: 'category', slug: 'news', label: 'News', metadata: { description: 'Example' }, version: 1 } });
  assert.ok(driver.calls[0].cypher.includes(':TaxonomyTerm'));
  assert.ok(driver.calls[0].cypher.includes('n.metadataJson=$metadataJson'));
  assert.equal(typeof driver.calls[0].params.metadataJson, 'string');
  assert.deepEqual(JSON.parse(driver.calls[0].params.metadataJson), { description: 'Example' });
});
