'use strict';

const { randomUUID } = require('node:crypto');
const ALLOWED_KINDS = new Set(['HAS_TERM', 'PARENT_OF', 'RELATED_TO', 'LOCALIZED_AS', 'NAVIGATES_TO']);

function createRelationshipStore({ pool }) {
  if (!pool) throw new TypeError('PostgreSQL pool is required.');
  return Object.freeze({
    async upsert({ siteId, sourceId, targetId, kind, metadata = {} }) {
      if (!ALLOWED_KINDS.has(kind)) throw Object.assign(new Error('Unsupported relation kind.'), { code: 'ERR_SYSTEMFABRIC_RELATION_KIND' });
      if (sourceId === targetId) throw Object.assign(new Error('Self relationships are not allowed.'), { code: 'ERR_SYSTEMFABRIC_RELATION_SELF' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The partial unique index and UPSERT serialize concurrent creates of the same live relationship.
        const result = await client.query(
          `INSERT INTO content_relationships(id,site_id,source_id,target_id,kind,metadata,version)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,1)
           ON CONFLICT (site_id,source_id,target_id,kind) WHERE deleted_at IS NULL
           DO UPDATE SET metadata=EXCLUDED.metadata,version=content_relationships.version+1
           RETURNING id,site_id,source_id,target_id,kind,metadata,version`,
          [randomUUID(), siteId, sourceId, targetId, kind, JSON.stringify(metadata)]
        );
        const row = result.rows[0];
        const event = { relationshipId: row.id, siteId, sourceId, targetId, kind, version: row.version, metadata: row.metadata };
        await client.query(`INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('relationship',$1,$2,'relationship.upsert',$3::jsonb) ON CONFLICT (aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`, [row.id, row.version, JSON.stringify(event)]);
        await client.query('COMMIT');
        return row;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async delete({ siteId, sourceId, targetId, kind }) {
      if (!ALLOWED_KINDS.has(kind)) throw Object.assign(new Error('Unsupported relation kind.'), { code: 'ERR_SYSTEMFABRIC_RELATION_KIND' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT id,version FROM content_relationships WHERE site_id=$1 AND source_id=$2 AND target_id=$3 AND kind=$4 AND deleted_at IS NULL FOR UPDATE', [siteId, sourceId, targetId, kind]);
        if (!result.rows[0]) { await client.query('COMMIT'); return { deleted: false }; }
        const row = result.rows[0];
        const version = row.version + 1;
        await client.query('UPDATE content_relationships SET deleted_at=now(),version=$2 WHERE id=$1', [row.id, version]);
        const event = { relationshipId: row.id, siteId, sourceId, targetId, kind, version };
        await client.query(`INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('relationship',$1,$2,'relationship.delete',$3::jsonb) ON CONFLICT (aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`, [row.id, version, JSON.stringify(event)]);
        await client.query('COMMIT');
        return { deleted: true, id: row.id, version };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    }
  });
}

module.exports = { createRelationshipStore, ALLOWED_KINDS };
