'use strict';

const ALLOWED_RELATIONSHIPS = new Set(['HAS_TERM', 'PARENT_OF', 'RELATED_TO', 'LOCALIZED_AS', 'NAVIGATES_TO']);
const NODE_LABELS = new Set(['content', 'term']);
const CONTENT_STATUS_EVENT_TYPES = new Set([
  'content.publish',
  'content.unpublish',
  'content.submitted_for_review',
  'content.approved',
  'content.rejected',
  'content.scheduled',
  'content.archived',
  'content.unpublished'
]);

function nodeLabel(value) {
  if (!NODE_LABELS.has(value)) throw Object.assign(new Error('Unknown graph node type.'), { code: 'ERR_GRAPH_NODE_TYPE' });
  return value === 'term' ? 'TaxonomyTerm' : 'Content';
}

function createMemgraphDriver({ url, username = '', password = '' }) {
  if (!url) throw new Error('MEMGRAPH_URL is required.');
  const neo4j = require('neo4j-driver');
  const auth = username ? neo4j.auth.basic(username, password) : neo4j.auth.none();
  return neo4j.driver(url, auth, { maxConnectionPoolSize: 20, connectionAcquisitionTimeout: 5000 });
}

function createMemgraphProjector({ driver }) {
  if (!driver) throw new TypeError('Memgraph driver is required.');

  async function execute(cypher, params) {
    const session = driver.session();
    try { return await session.executeWrite(tx => tx.run(cypher, params)); }
    finally { await session.close(); }
  }

  return Object.freeze({
    async apply({ type, payload, envelope }) {
      const projectionVersion = Number(
        envelope?.resource?.version ?? payload.projectionVersion ?? payload.version
      );
      if (!Number.isSafeInteger(projectionVersion) || projectionVersion < 1) {
        throw Object.assign(new Error('Graph projection requires a positive aggregate version.'), {
          code: 'ERR_GRAPH_PROJECTION_VERSION'
        });
      }

      if (type === 'content.upsert') {
        await execute(
          `MERGE (n:Content {id:$id})
           ON CREATE SET n.version=0,n.projectionVersion=0
           WITH n
           WHERE coalesce(n.projectionVersion,n.version,0) < $projectionVersion
           SET n.siteId=$siteId,n.contentType=$contentType,n.slug=$slug,n.locale=$locale,n.status=$status,n.title=$title,
               n.version=$version,n.projectionVersion=$projectionVersion,n.updatedAt=$updatedAt
           RETURN n.id AS id,n.version AS version`,
          { ...payload, projectionVersion, updatedAt: new Date().toISOString() }
        );
        return;
      }

      if (type === 'content.delete') {
        await execute(
          `MERGE (n:Content {id:$id})
           ON CREATE SET n.version=0,n.projectionVersion=0
           WITH n
           WHERE coalesce(n.projectionVersion,n.version,0) < $projectionVersion
           SET n.siteId=$siteId,n.status='deleted',n.version=$version,n.projectionVersion=$projectionVersion,n.updatedAt=$updatedAt`,
          { ...payload, projectionVersion, updatedAt: new Date().toISOString() }
        );
        return;
      }

      if (CONTENT_STATUS_EVENT_TYPES.has(type)) {
        const statuses = new Set(['draft', 'in_review', 'approved', 'scheduled', 'published', 'archived', 'deleted']);
        if (typeof payload.status !== 'string' || !statuses.has(payload.status)) {
          throw Object.assign(new Error('Content workflow projection has an unsupported status.'), {
            code: 'ERR_GRAPH_CONTENT_STATUS'
          });
        }
        await execute(
          `MATCH (n:Content {id:$id,siteId:$siteId})
           WHERE coalesce(n.projectionVersion,n.version,0) < $projectionVersion
           SET n.status=$status,n.projectionVersion=$projectionVersion,n.updatedAt=$updatedAt`,
          { ...payload, projectionVersion, updatedAt: new Date().toISOString() }
        );
        return;
      }

      if (type === 'taxonomy.upsert' || type === 'taxonomy.delete') {
        await execute(
          `MERGE (n:TaxonomyTerm {id:$id,siteId:$siteId})
           ON CREATE SET n.version=0
           WITH n
           WHERE n.version < $version
           SET n.taxonomy=$taxonomy,n.slug=$slug,n.label=$label,n.metadataJson=$metadataJson,n.status=$status,n.version=$version,n.updatedAt=$updatedAt`,
          { ...payload, metadataJson: JSON.stringify(payload.metadata || {}), status: type === 'taxonomy.delete' ? 'deleted' : 'active', updatedAt: new Date().toISOString() }
        );
        return;
      }

      if (type === 'relationship.upsert') {
        if (!ALLOWED_RELATIONSHIPS.has(payload.kind)) throw Object.assign(new Error('Unknown graph relation kind.'), { code: 'ERR_GRAPH_RELATION_KIND' });
        const relation = payload.kind;
        const sourceLabel = nodeLabel(payload.sourceType || 'content');
        const targetLabel = nodeLabel(payload.targetType || (relation === 'HAS_TERM' ? 'term' : 'content'));
        if (relation === 'HAS_TERM' && (sourceLabel !== 'Content' || targetLabel !== 'TaxonomyTerm')) throw Object.assign(new Error('HAS_TERM must connect content to a taxonomy term.'), { code: 'ERR_GRAPH_RELATION_TYPE' });
        await execute(
          `MERGE (state:RelationshipProjection {id:$relationshipId,siteId:$siteId})
           ON CREATE SET state.version=0,state.status='deleted'
           WITH state
           WHERE state.version < $version
           SET state.version=$version,state.status='active',state.kind=$kind
           WITH state
           MERGE (s:${sourceLabel} {id:$sourceId,siteId:$siteId})
           ON CREATE SET s.version=0,s.status='projection-placeholder'
           MERGE (t:${targetLabel} {id:$targetId,siteId:$siteId})
           ON CREATE SET t.version=0,t.status='projection-placeholder'
           MERGE (s)-[r:${relation} {id:$relationshipId}]->(t)
           SET r.siteId=$siteId,r.version=$version,r.status='active',r.updatedAt=$updatedAt`,
          { ...payload, updatedAt: new Date().toISOString() }
        );
        return;
      }

      if (type === 'relationship.delete') {
        if (!ALLOWED_RELATIONSHIPS.has(payload.kind)) throw Object.assign(new Error('Unknown graph relation kind.'), { code: 'ERR_GRAPH_RELATION_KIND' });
        const relation = payload.kind;
        const sourceLabel = nodeLabel(payload.sourceType || 'content');
        const targetLabel = nodeLabel(payload.targetType || (relation === 'HAS_TERM' ? 'term' : 'content'));
        if (relation === 'HAS_TERM' && (sourceLabel !== 'Content' || targetLabel !== 'TaxonomyTerm')) throw Object.assign(new Error('HAS_TERM must connect content to a taxonomy term.'), { code: 'ERR_GRAPH_RELATION_TYPE' });
        await execute(
          `MERGE (state:RelationshipProjection {id:$relationshipId,siteId:$siteId})
           ON CREATE SET state.version=0,state.status='active'
           WITH state
           WHERE state.version < $version
           SET state.version=$version,state.status='deleted',state.kind=$kind
           WITH state
           OPTIONAL MATCH (s:${sourceLabel} {id:$sourceId,siteId:$siteId})-[r:${relation} {id:$relationshipId}]->(t:${targetLabel} {id:$targetId,siteId:$siteId})
           FOREACH (edge IN CASE WHEN r IS NULL THEN [] ELSE [r] END | SET edge.version=$version,edge.status='deleted')`,
          payload
        );
        return;
      }

      throw Object.assign(new Error(`Unsupported outbox projection event: ${type}`), { code: 'ERR_GRAPH_EVENT_UNSUPPORTED' });
    },

    async findRelated({ id, siteId, kind = 'RELATED_TO', limit = 20 }) {
      if (!ALLOWED_RELATIONSHIPS.has(kind)) throw new Error('Unsupported relationship kind.');
      const requestedLimit = Number(limit);
      const safeLimit = Number.isFinite(requestedLimit)
        ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
        : 20;
      const session = driver.session();
      try {
        const result = await session.run(
          `MATCH (s:Content {id:$id,siteId:$siteId})-[r:${kind}]->(t:Content {siteId:$siteId}) WHERE s.status='published' AND t.status='published' AND coalesce(r.status,'active') <> 'deleted' RETURN t.id AS id,t.slug AS slug,t.contentType AS contentType,t.locale AS locale,t.status AS status,t.version AS version LIMIT ${safeLimit}`,
          { id, siteId }
        );
        return result.records.map(record => Object.fromEntries(['id','slug','contentType','locale','status','version'].map(key => [key, record.get(key)])));
      } finally { await session.close(); }
    },

    async close() { await driver.close(); }
  });
}

module.exports = {
  createMemgraphDriver,
  createMemgraphProjector,
  ALLOWED_RELATIONSHIPS,
  NODE_LABELS,
  CONTENT_STATUS_EVENT_TYPES,
  nodeLabel
};
