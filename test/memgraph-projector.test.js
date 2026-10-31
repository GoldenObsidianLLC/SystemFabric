'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemgraphProjector } = require('../packages/graph/src/memgraph-store');

function makeDriver() {
  const statements = [];
  return {
    statements,
    session() {
      return {
        async executeWrite(callback) {
          return callback({
            async run(statement, params) {
              statements.push({ statement, params });
              return { records: [] };
            }
          });
        },
        async close() {}
      };
    },
    async close() {}
  };
}

test('content workflow events update graph status using aggregate projection version', async () => {
  const driver = makeDriver();
  const projector = createMemgraphProjector({ driver });
  const payload = {
    id: '44444444-4444-4444-8444-444444444444',
    siteId: '11111111-1111-4111-8111-111111111111',
    status: 'published',
    version: 7
  };
  await projector.apply({
    type: 'content.publish',
    payload,
    envelope: { resource: { version: 12 } }
  });
  assert.equal(driver.statements.length, 1);
  assert.match(driver.statements[0].statement, /projectionVersion/);
  assert.match(driver.statements[0].statement, /< \$projectionVersion/);
  assert.equal(driver.statements[0].params.projectionVersion, 12);
  assert.equal(driver.statements[0].params.version, 7);
  assert.equal(driver.statements[0].params.status, 'published');
});

test('content status projection rejects unknown states and invalid aggregate versions', async () => {
  const driver = makeDriver();
  const projector = createMemgraphProjector({ driver });
  const payload = {
    id: '44444444-4444-4444-8444-444444444444',
    siteId: '11111111-1111-4111-8111-111111111111',
    status: 'unsafe',
    version: 1
  };
  await assert.rejects(() => projector.apply({
    type: 'content.publish',
    payload,
    envelope: { resource: { version: 2 } }
  }), { code: 'ERR_GRAPH_CONTENT_STATUS' });
  await assert.rejects(() => projector.apply({
    type: 'content.publish',
    payload: { ...payload, status: 'published' },
    envelope: { resource: { version: 0 } }
  }), { code: 'ERR_GRAPH_PROJECTION_VERSION' });
  assert.equal(driver.statements.length, 0);
});

test('content draft projection preserves editorial version separately from projection sequence', async () => {
  const driver = makeDriver();
  const projector = createMemgraphProjector({ driver });
  await projector.apply({
    type: 'content.upsert',
    payload: {
      id: '44444444-4444-4444-8444-444444444444',
      siteId: '11111111-1111-4111-8111-111111111111',
      contentType: 'page',
      slug: 'draft',
      locale: 'en',
      title: 'Draft',
      status: 'draft',
      version: 7
    },
    envelope: { resource: { version: 12 } }
  });
  assert.equal(driver.statements[0].params.version, 7);
  assert.equal(driver.statements[0].params.projectionVersion, 12);
});
