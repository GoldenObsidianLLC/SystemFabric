'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { loadEnvFile } = require('./load-env');
const { createPostgresPool } = require('../packages/db/src/postgres-store');
const {
  createMemgraphDriver,
  createMemgraphProjector,
} = require('../packages/graph/src/memgraph-store');
const {
  rebuildGraphProjection,
} = require('../packages/graph/src/rebuild-projection');

const EXPECTED_IMAGE = 'memgraph/memgraph:3.13.1';

function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      `Docker ${args[0]} failed: ${
        result.error?.message ||
        result.stderr?.trim() ||
        `exit code ${result.status}`
      }`
    );
  }

  return result.stdout.trim();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function asNumber(value) {
  return typeof value === 'number'
    ? value
    : typeof value?.toNumber === 'function'
      ? value.toNumber()
      : Number(value);
}

async function waitForGraph(driver, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await driver.verifyConnectivity();
      return;
    } catch (error) {
      lastError = error;
      await delay(1000);
    }
  }

  throw new Error(
    `Temporary Memgraph did not become ready: ${
      lastError?.message || 'timeout'
    }`
  );
}

async function graphCount(session, query, params = {}) {
  const result = await session.run(query, params);
  return asNumber(result.records[0].get('count'));
}

async function seedFixtures(pool) {
  const ids = {
    source: randomUUID(),
    target: randomUUID(),
    deletedContent: randomUUID(),
    liveTerm: randomUUID(),
    relatedRelationship: randomUUID(),
    termRelationship: randomUUID(),
    deletedRelationship: randomUUID(),
  };

  const client = await pool.connect();
  let siteId;

  try {
    await client.query('BEGIN');

    const site = await client.query(
      `INSERT INTO sites(slug, name)
       VALUES($1, $2)
       RETURNING id`,
      [
        `graph-rebuild-${randomUUID().slice(0, 8)}`,
        'Graph Rebuild Integration Fixture',
      ]
    );

    siteId = site.rows[0].id;

    const deletedAt = new Date();
    const body = JSON.stringify({ schemaVersion: 1 });

    const contents = [
      {
        id: ids.source,
        slug: `rebuild-source-${randomUUID().slice(0, 8)}`,
        title: 'Rebuild Source',
        status: 'published',
        deletedAt: null,
      },
      {
        id: ids.target,
        slug: `rebuild-target-${randomUUID().slice(0, 8)}`,
        title: 'Rebuild Target',
        status: 'published',
        deletedAt: null,
      },
      {
        id: ids.deletedContent,
        slug: `rebuild-deleted-${randomUUID().slice(0, 8)}`,
        title: 'Deleted Rebuild Fixture',
        status: 'deleted',
        deletedAt,
      },
    ];

    for (const row of contents) {
      await client.query(
        `INSERT INTO content_items(
           id, site_id, content_type, slug, locale, title,
           status, body, version, deleted_at
         )
         VALUES($1, $2, 'page', $3, 'en', $4, $5, $6::jsonb, 1, $7)`,
        [
          row.id,
          siteId,
          row.slug,
          row.title,
          row.status,
          body,
          row.deletedAt,
        ]
      );
    }

    // taxonomy_terms has no deleted_at column in the current schema.
    await client.query(
      `INSERT INTO taxonomy_terms(
         id, site_id, taxonomy, slug, label, version, metadata
       )
       VALUES($1, $2, 'topic', $3, $4, 1, '{}'::jsonb)`,
      [
        ids.liveTerm,
        siteId,
        `rebuild-term-${randomUUID().slice(0, 8)}`,
        'Live Rebuild Term',
      ]
    );

    const relationships = [
      {
        id: ids.relatedRelationship,
        sourceId: ids.source,
        targetId: ids.target,
        kind: 'RELATED_TO',
        version: 1,
        deletedAt: null,
      },
      {
        id: ids.termRelationship,
        sourceId: ids.source,
        targetId: ids.liveTerm,
        kind: 'HAS_TERM',
        version: 1,
        deletedAt: null,
      },
      {
        id: ids.deletedRelationship,
        sourceId: ids.source,
        targetId: ids.target,
        kind: 'NAVIGATES_TO',
        version: 2,
        deletedAt,
      },
    ];

    for (const relation of relationships) {
      await client.query(
        `INSERT INTO content_relationships(
           id, site_id, source_id, target_id, kind,
           metadata, version, deleted_at
         )
         VALUES($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7)`,
        [
          relation.id,
          siteId,
          relation.sourceId,
          relation.targetId,
          relation.kind,
          relation.version,
          relation.deletedAt,
        ]
      );
    }

    await client.query('COMMIT');

    return { siteId, ids };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));

  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  assert.ok(
    testDatabaseUrl,
    'TEST_DATABASE_URL is required; refusing to use DATABASE_URL implicitly'
  );

  const databaseUrl = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(
    databaseUrl.pathname.replace(/^\/+/, '')
  );

  assert.match(
    databaseName,
    /(?:^|[_-])test$/i,
    'Safety stop: the database name must end in test'
  );

  assert.ok(
    new Set([
      '127.0.0.1',
      'localhost',
      '[::1]',
      '::1',
      'postgres',
    ]).has(databaseUrl.hostname.toLowerCase()),
    'Safety stop: PostgreSQL must use an allowed local/test endpoint'
  );

  let pool;
  let driver;
  let containerId;
  let siteId;
  let cleanupError;

  try {
    pool = createPostgresPool({
      DATABASE_URL: testDatabaseUrl,
      DATABASE_POOL_MAX: '4',
    });

    assert.ok(pool, 'Could not create PostgreSQL test pool');

    // Confirm migrations have created the required canonical tables.
    await pool.query('SELECT id FROM content_items LIMIT 0');
    await pool.query('SELECT id FROM taxonomy_terms LIMIT 0');
    await pool.query('SELECT id FROM content_relationships LIMIT 0');

    // Use a separate, disposable Memgraph container.
    containerId = docker([
      'run',
      '--detach',
      '--publish',
      '127.0.0.1::7687',
      EXPECTED_IMAGE,
    ]);

    assert.match(
      containerId,
      /^[a-f0-9]{12,64}$/i,
      'Docker did not return a valid temporary container ID'
    );

    const image = docker([
      'inspect',
      '--format={{.Config.Image}}',
      containerId,
    ]);

    assert.equal(
      image,
      EXPECTED_IMAGE,
      'Safety stop: unexpected temporary Memgraph image'
    );

    const portMapping = docker([
      'port',
      containerId,
      '7687/tcp',
    ]);

    const portMatch = portMapping.match(/127\.0\.0\.1:(\d+)/);

    assert.ok(
      portMatch,
      `Could not resolve temporary Memgraph port: ${portMapping}`
    );

    driver = createMemgraphDriver({
      url: `bolt://127.0.0.1:${portMatch[1]}`,
    });

    const projector = createMemgraphProjector({ driver });

    await waitForGraph(driver);

    const fixture = await seedFixtures(pool);
    siteId = fixture.siteId;
    const ids = fixture.ids;

    const session = driver.session();

    try {
      const staleIds = {
        content: randomUUID(),
        term: randomUUID(),
        relationship: randomUUID(),
      };

      // Seed stale nodes so we can verify that the rebuild removes them.
      await session.run(
        `CREATE
          (c:Content {
            id: $contentId, siteId: $siteId, status: 'stale'
          }),
          (t:TaxonomyTerm {
            id: $termId, siteId: $siteId, status: 'stale'
          }),
          (r:RelationshipProjection {
            id: $relationshipId, siteId: $siteId, status: 'active'
          })`,
        {
          contentId: staleIds.content,
          termId: staleIds.term,
          relationshipId: staleIds.relationship,
          siteId,
        }
      );

      // A safety-limit failure must happen before graph state is cleared.
      await assert.rejects(
        rebuildGraphProjection({
          pool,
          driver,
          projector,
          maxRows: 1,
        }),
        /Graph rebuild safety limit exceeded/i
      );

      assert.equal(
        await graphCount(
          session,
          `MATCH (n:Content {id: $id, siteId: $siteId})
           RETURN count(n) AS count`,
          { id: staleIds.content, siteId }
        ),
        1,
        'Safety-limit failure must preserve the existing graph'
      );

      const progress = [];

      const first = await rebuildGraphProjection({
        pool,
        driver,
        projector,
        onProgress: update => progress.push(update),
      });

      assert.deepEqual(first, {
        content: 3,
        deletedContent: 1,
        taxonomy: 1,
        deletedTaxonomy: 0,
        relationships: 3,
        deletedRelationships: 1,
        total: 7,
      });

      assert.equal(progress.at(-1)?.phase, 'complete');
      assert.equal(progress.at(-1)?.completed, 7);
      assert.equal(progress.at(-1)?.total, 7);

      assert.equal(
        await graphCount(
          session,
          'MATCH (n:Content) RETURN count(n) AS count'
        ),
        3
      );

      assert.equal(
        await graphCount(
          session,
          'MATCH (n:TaxonomyTerm) RETURN count(n) AS count'
        ),
        1
      );

      assert.equal(
        await graphCount(
          session,
          'MATCH (n:RelationshipProjection) RETURN count(n) AS count'
        ),
        3
      );

      assert.equal(
        await graphCount(
          session,
          `MATCH ()-[r]->()
           WHERE r.status = $status
           RETURN count(r) AS count`,
          { status: 'active' }
        ),
        2,
        'Only the two live relationships should be active'
      );

      for (const [label, id] of [
        ['Content', staleIds.content],
        ['TaxonomyTerm', staleIds.term],
        ['RelationshipProjection', staleIds.relationship],
      ]) {
        assert.equal(
          await graphCount(
            session,
            `MATCH (n:${label} {id: $id, siteId: $siteId})
             RETURN count(n) AS count`,
            { id, siteId }
          ),
          0,
          `Stale ${label} node should have been removed`
        );
      }

      const deletedContent = await session.run(
        `MATCH (n:Content {id: $id, siteId: $siteId})
         RETURN n.status AS status, n.version AS version`,
        { id: ids.deletedContent, siteId }
      );

      assert.equal(deletedContent.records.length, 1);
      assert.equal(deletedContent.records[0].get('status'), 'deleted');
      assert.equal(
        asNumber(deletedContent.records[0].get('version')),
        1
      );

      const tombstone = await session.run(
        `MATCH (r:RelationshipProjection {id: $id, siteId: $siteId})
         RETURN r.status AS status, r.version AS version`,
        { id: ids.deletedRelationship, siteId }
      );

      assert.equal(tombstone.records.length, 1);
      assert.equal(tombstone.records[0].get('status'), 'deleted');
      assert.equal(
        asNumber(tombstone.records[0].get('version')),
        2
      );

      const related = await projector.findRelated({
        id: ids.source,
        siteId,
        kind: 'RELATED_TO',
      });

      assert.equal(related.length, 1);
      assert.equal(related[0].id, ids.target);

      const termRelationCount = await graphCount(
        session,
        `MATCH (:Content {id: $sourceId, siteId: $siteId})
              -[r:HAS_TERM]->
              (:TaxonomyTerm {id: $termId, siteId: $siteId})
         WHERE r.status = 'active'
         RETURN count(r) AS count`,
        {
          sourceId: ids.source,
          termId: ids.liveTerm,
          siteId,
        }
      );

      assert.equal(termRelationCount, 1);

      // A second rebuild should yield the same projection summary and counts.
      const second = await rebuildGraphProjection({
        pool,
        driver,
        projector,
      });

      assert.deepEqual(second, first);

      assert.equal(
        await graphCount(
          session,
          'MATCH (n:Content) RETURN count(n) AS count'
        ),
        3
      );

      assert.equal(
        await graphCount(
          session,
          'MATCH (n:TaxonomyTerm) RETURN count(n) AS count'
        ),
        1
      );

      assert.equal(
        await graphCount(
          session,
          'MATCH (n:RelationshipProjection) RETURN count(n) AS count'
        ),
        3
      );
    } finally {
      await session.close();
    }

    console.log('PASS: safety limit preserves existing graph state.');
    console.log('PASS: canonical content, taxonomy, and relationships rebuilt.');
    console.log('PASS: deleted content and relationship tombstone preserved.');
    console.log('PASS: stale graph nodes removed.');
    console.log('PASS: second rebuild produced the same summary.');
    console.log('GRAPH REBUILD LIVE RESULT: PASS');
  } finally {
    if (siteId && pool) {
      await pool.query(
        'DELETE FROM sites WHERE id = $1',
        [siteId]
      ).catch(error => {
        cleanupError ||= error;
        console.error(`Fixture cleanup failed: ${error.message}`);
      });
    }

    if (driver) {
      await driver.close().catch(error => {
        cleanupError ||= error;
      });
    }

    if (containerId) {
      try {
        docker(['rm', '--force', containerId]);
      } catch (error) {
        cleanupError ||= error;
        console.error(`Temporary Memgraph cleanup failed: ${error.message}`);
      }
    }

    if (pool) {
      await pool.end().catch(error => {
        cleanupError ||= error;
      });
    }

    if (cleanupError) {
      throw cleanupError;
    }
  }
}

main().catch(error => {
  console.error(
    `GRAPH REBUILD LIVE TEST FAILED: ${error.stack || error.message}`
  );
  process.exitCode = 1;
});
