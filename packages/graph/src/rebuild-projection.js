'use strict';

/**
 * Rebuild the Memgraph projection from canonical PostgreSQL records.
 *
 * SAFETY:
 * - Maintenance/test use only. Pause application writes and outbox workers.
 * - This function clears all Content, TaxonomyTerm, and RelationshipProjection
 *   nodes in the connected graph before rebuilding it.
 * - A failure after clearing may leave a partial graph; this is not an
 *   unattended production-recovery mechanism.
 * - The canonical taxonomy_terms table has no deleted_at column, so taxonomy
 *   terms are projected as active records; taxonomy deletion is not inferred.
 */
async function readCanonicalSnapshot(pool, maxRows) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const countsResult = await client.query(`
      SELECT
        (SELECT count(*) FROM content_items) AS content_count,
        (SELECT count(*) FROM taxonomy_terms) AS taxonomy_count,
        (SELECT count(*) FROM content_relationships) AS relationship_count
    `);

    const counts = countsResult.rows[0];
    const total =
      Number(counts.content_count) +
      Number(counts.taxonomy_count) +
      Number(counts.relationship_count);

    if (!Number.isSafeInteger(total) || total > maxRows) {
      throw new Error(
        `Graph rebuild safety limit exceeded: ${total} canonical rows, ` +
        `maximum ${maxRows}. Increase the limit only after reviewing ` +
        'memory use and rebuild duration.'
      );
    }

    // Read sequentially on the same client and repeatable-read snapshot.
    const contentResult = await client.query(`
      SELECT id, site_id, content_type, slug, locale, title,
             status, version, lock_version, deleted_at
        FROM content_items
       ORDER BY id
    `);

    const taxonomyResult = await client.query(`
      SELECT id, site_id, taxonomy, slug, label,
             version, metadata
        FROM taxonomy_terms
       ORDER BY id
    `);

    const relationshipResult = await client.query(`
      SELECT id, site_id, source_id, target_id, kind,
             metadata, version, deleted_at
        FROM content_relationships
       ORDER BY id
    `);

    await client.query('COMMIT');

    const snapshot = {
      content: contentResult.rows,
      taxonomy: taxonomyResult.rows,
      relationships: relationshipResult.rows,
    };

    const actualTotal =
      snapshot.content.length +
      snapshot.taxonomy.length +
      snapshot.relationships.length;

    if (actualTotal !== total) {
      throw new Error(
        `Graph rebuild snapshot count mismatch: counted ${total}, ` +
        `read ${actualTotal}.`
      );
    }

    return snapshot;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function clearProjection(driver) {
  const session = driver.session();

  try {
    // Remove projection state first, followed by projected entities.
    await session.run(
      'MATCH (n:RelationshipProjection) DETACH DELETE n'
    );

    await session.run(
      'MATCH (n:Content) DETACH DELETE n'
    );

    await session.run(
      'MATCH (n:TaxonomyTerm) DETACH DELETE n'
    );
  } finally {
    await session.close();
  }
}

async function rebuildGraphProjection({
  pool,
  driver,
  projector,
  maxRows = 10_000,
  onProgress = () => {},
}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required.');
  }

  if (!driver || typeof driver.session !== 'function') {
    throw new TypeError('A Memgraph driver is required.');
  }

  if (!projector || typeof projector.apply !== 'function') {
    throw new TypeError('A graph projector with apply() is required.');
  }

  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new TypeError('maxRows must be a positive safe integer.');
  }

  if (typeof onProgress !== 'function') {
    throw new TypeError('onProgress must be a function.');
  }

  // Fail before modifying Memgraph if the snapshot cannot be read or
  // exceeds the safety limit.
  const snapshot = await readCanonicalSnapshot(pool, maxRows);

  const summary = {
    content: 0,
    deletedContent: 0,
    taxonomy: 0,
    deletedTaxonomy: 0,
    relationships: 0,
    deletedRelationships: 0,
  };

  const total =
    snapshot.content.length +
    snapshot.taxonomy.length +
    snapshot.relationships.length;

  let completed = 0;

  const reportProgress = phase => {
    onProgress({ phase, completed, total });
  };

  await clearProjection(driver);
  reportProgress('cleared');

  for (const row of snapshot.content) {
    const deleted =
      row.deleted_at != null || row.status === 'deleted';

    await projector.apply({
      type: deleted ? 'content.delete' : 'content.upsert',
      payload: {
        id: row.id,
        siteId: row.site_id,
        contentType: row.content_type,
        slug: row.slug,
        locale: row.locale,
        title: row.title,
        status: row.status,
        version: row.version,
        projectionVersion: row.lock_version,
      },
    });

    summary.content += 1;

    if (deleted) {
      summary.deletedContent += 1;
    }

    completed += 1;
    reportProgress('content');
  }

  for (const row of snapshot.taxonomy) {
    await projector.apply({
      type: 'taxonomy.upsert',
      payload: {
        id: row.id,
        siteId: row.site_id,
        taxonomy: row.taxonomy,
        slug: row.slug,
        label: row.label,
        metadata: row.metadata || {},
        version: row.version,
      },
    });

    summary.taxonomy += 1;
    completed += 1;
    reportProgress('taxonomy');
  }

  for (const row of snapshot.relationships) {
    const deleted = row.deleted_at != null;
    const isTermRelation = row.kind === 'HAS_TERM';

    await projector.apply({
      type: deleted
        ? 'relationship.delete'
        : 'relationship.upsert',
      payload: {
        relationshipId: row.id,
        siteId: row.site_id,
        sourceId: row.source_id,
        targetId: row.target_id,
        kind: row.kind,
        version: row.version,
        metadata: row.metadata || {},
        sourceType: 'content',
        targetType: isTermRelation ? 'term' : 'content',
      },
    });

    summary.relationships += 1;

    if (deleted) {
      summary.deletedRelationships += 1;
    }

    completed += 1;
    reportProgress('relationships');
  }

  reportProgress('complete');

  return {
    ...summary,
    total,
  };
}

module.exports = {
  readCanonicalSnapshot,
  clearProjection,
  rebuildGraphProjection,
};