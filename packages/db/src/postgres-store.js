'use strict';

const { randomUUID } = require('node:crypto');

function createPostgresPool(env = process.env) {
  if (!env.DATABASE_URL) return null;
  const { Pool } = require('pg');
  return new Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_MAX || 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: 'systemfabric-api' });
}

function extractPageText(document, maxChars = 200_000) {
  const parts = []; let size = 0;
  function add(value) {
    if (typeof value !== 'string' || !value.trim() || size >= maxChars) return;
    const bounded = value.slice(0, maxChars - size); parts.push(bounded); size += bounded.length + 1;
  }
  function visit(node) {
    if (!node || typeof node !== 'object' || size >= maxChars) return;
    if (node.props && typeof node.props === 'object') { add(node.props.text); add(node.props.alt); }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child);
  }
  if (document && Array.isArray(document.children)) for (const child of document.children) visit(child);
  if (document && typeof document.documentType === 'string' && document.documentType.startsWith('custom:') && document.fields && typeof document.fields === 'object') {
    const visitValue = value => { if (typeof value === 'string' && !/^[0-9a-f-]{36}$/i.test(value)) add(value); else if (Array.isArray(value)) value.forEach(visitValue); else if (value && typeof value === 'object') Object.values(value).forEach(visitValue); };
    Object.values(document.fields).forEach(visitValue);
  }
  return parts.join(' ').slice(0, maxChars);
}

function conflict(message, code = 'ERR_SYSTEMFABRIC_CONFLICT') {
  const error = new Error(message); error.statusCode = 409; error.code = code; return error;
}

function createPostgresStore({ pool }) {
  if (!pool) throw new TypeError('A PostgreSQL pool is required.');

  async function writeWorkflow(client, { siteId, id, version, action, fromStatus, toStatus, actorId, scheduledAt = null, note = null }) {
    await client.query(
      `INSERT INTO workflow_events(site_id,content_id,content_version,action,from_status,to_status,actor_id,scheduled_at,note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [siteId, id, version, action, fromStatus, toStatus, actorId || null, scheduledAt, typeof note === 'string' ? note.slice(0, 2000) : null]
    );
  }

  async function writeOutbox(client, { id, siteId, version, aggregateVersion = version, eventType, payload, actorId = null, correlationId = null, causationId = null }) {
    await client.query(
      `INSERT INTO outbox_events(
         aggregate_type,aggregate_id,aggregate_version,event_type,payload,
         site_id,actor_id,correlation_id,causation_id,classification
       )
       VALUES('content',$1,$2,$3,$4::jsonb,$5,$6,$7,$8,'site-private')
       ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`,
      [id, aggregateVersion, eventType, JSON.stringify({ id, siteId, version, ...payload }), siteId, actorId || null, correlationId || null, causationId || null]
    );
  }

  async function transition({ siteId, id, actorId, correlationId = null, action, fromStatuses, toStatus, expectedVersion, note, scheduledAt, publish = false, clearPublished = false }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT id,site_id,title,slug,locale,content_type,status,body,version,published_snapshot FROM content_items
         WHERE id=$1 AND site_id=$2 AND deleted_at IS NULL FOR UPDATE`, [id, siteId]
      );
      const row = selected.rows[0];
      if (!row) { const error = new Error('Content not found.'); error.statusCode = 404; error.code = 'ERR_SYSTEMFABRIC_CONTENT_NOT_FOUND'; throw error; }
      if (expectedVersion !== undefined && Number(expectedVersion) !== row.version) throw conflict('Content changed since it was loaded. Reload before retrying.', 'ERR_SYSTEMFABRIC_VERSION_CONFLICT');
      if (!fromStatuses.includes(row.status)) throw conflict(`Cannot ${action} content from status ${row.status}.`, 'ERR_SYSTEMFABRIC_INVALID_WORKFLOW_TRANSITION');
      let snapshot = row.published_snapshot;
      if (publish) {
        snapshot = { title: row.title, slug: row.slug, locale: row.locale, contentType: row.content_type, status: 'published', document: row.body, version: row.version };
      }
      const updated = await client.query(
        `UPDATE content_items SET status=$3, scheduled_at=$4,
           published_snapshot=CASE WHEN $5 THEN NULL WHEN $6 THEN $7::jsonb ELSE published_snapshot END,
           published_version=CASE WHEN $5 THEN NULL WHEN $6 THEN version ELSE published_version END,
           published_at=CASE WHEN $5 THEN NULL WHEN $6 THEN now() ELSE published_at END,
           published_search_vector=CASE WHEN $5 THEN ''::tsvector WHEN $6 THEN to_tsvector('simple',$8 || ' ' || $9) ELSE published_search_vector END,
           reviewed_by=CASE WHEN $10 THEN $11 ELSE reviewed_by END,
           reviewed_at=CASE WHEN $10 THEN now() ELSE reviewed_at END,
           lock_version=lock_version+1,updated_at=now()
         WHERE id=$1 AND site_id=$2
         RETURNING id,site_id,title,slug,locale,content_type,status,version,lock_version,scheduled_at,published_at,published_version,updated_at`,
        [id, siteId, toStatus, scheduledAt || null, clearPublished, publish, JSON.stringify(snapshot), row.title, extractPageText(row.body), action === 'approved', actorId || null]
      );
      await writeWorkflow(client, { siteId, id, version: row.version, action, fromStatus: row.status, toStatus, actorId, scheduledAt, note });
      await writeOutbox(client, { id, siteId, version: row.version, aggregateVersion: updated.rows[0].lock_version, eventType: publish ? 'content.publish' : clearPublished ? 'content.unpublish' : `content.${action}`, payload: { slug: row.slug, locale: row.locale, status: toStatus, action }, actorId, correlationId });
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw conflict('A page with that published route already exists.', 'ERR_SYSTEMFABRIC_ROUTE_CONFLICT'); throw error; }
    finally { client.release(); }
  }

  const store = {
    async saveDraft({ siteId, id, title, slug, locale = 'en', contentType = 'page', document, authorId = null, expectedVersion, note = null, correlationId = null }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = id ? await client.query('SELECT id,version,status FROM content_items WHERE id=$1 AND site_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, siteId]) : { rows: [] };
        const old = existing.rows[0];
        if (id && !old) { const error = new Error('Content not found.'); error.statusCode = 404; error.code = 'ERR_SYSTEMFABRIC_CONTENT_NOT_FOUND'; throw error; }
        if (old && expectedVersion !== undefined && Number(expectedVersion) !== old.version) throw conflict('Content changed since it was loaded. Reload before retrying.', 'ERR_SYSTEMFABRIC_VERSION_CONFLICT');
        const contentId = old?.id || id || randomUUID();
        const version = old ? old.version + 1 : 1;
        let committedRow;
        if (old) {
          const result = await client.query(
            `UPDATE content_items SET title=$3,slug=$4,locale=$5,content_type=$6,status='draft',body=$7::jsonb,schema_version=$8,version=$9,
               updated_by=$10,updated_at=now(),scheduled_at=NULL,reviewed_by=NULL,reviewed_at=NULL,
               search_vector=to_tsvector('simple',$3 || ' ' || $11),lock_version=lock_version+1
             WHERE id=$1 AND site_id=$2 RETURNING id,site_id,title,slug,locale,content_type,status,version,lock_version,body,published_version,updated_at`,
            [contentId, siteId, title, slug, locale, contentType, JSON.stringify(document), document.schemaVersion || 1, version, authorId, extractPageText(document)]
          );
          committedRow = result.rows[0];
        } else {
          const result = await client.query(
            `INSERT INTO content_items(id,site_id,content_type,slug,locale,title,status,body,schema_version,version,created_by,updated_by,search_vector)
             VALUES($1,$2,$3,$4,$5,$6,'draft',$7::jsonb,$8,$9,$10,$10,to_tsvector('simple',$6 || ' ' || $11))
             RETURNING id,site_id,title,slug,locale,content_type,status,version,lock_version,body,published_version,updated_at`,
            [contentId, siteId, contentType, slug, locale, title, JSON.stringify(document), document.schemaVersion || 1, version, authorId, extractPageText(document)]
          );
          committedRow = result.rows[0];
        }
        await client.query(
          'INSERT INTO content_revisions(content_id,version,snapshot,author_id,change_summary) VALUES($1,$2,$3::jsonb,$4,$5)',
          [committedRow.id, version, JSON.stringify({ title, slug, locale, contentType, status: 'draft', document }), authorId, typeof note === 'string' && note ? note.slice(0, 2000) : (old ? 'Draft updated' : 'Draft created')]
        );
        await writeWorkflow(client, { siteId, id: committedRow.id, version, action: 'draft_saved', fromStatus: old?.status || null, toStatus: 'draft', actorId: authorId, note });
        await writeOutbox(client, { id: committedRow.id, siteId, version, aggregateVersion: committedRow.lock_version, eventType: 'content.upsert', payload: { contentType, slug, locale, status: 'draft', title }, actorId: authorId, correlationId });
        await client.query('COMMIT'); return committedRow;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw conflict('That content route is already in use.', 'ERR_SYSTEMFABRIC_ROUTE_CONFLICT'); throw error; }
      finally { client.release(); }
    },

    async getPublishedBySlug({ siteId, slug, locale = 'en' }) {
      const result = await pool.query(
        `SELECT id,site_id,published_snapshot,version,published_version,published_at FROM content_items
         WHERE site_id=$1 AND published_snapshot->>'slug'=$2 AND COALESCE(published_snapshot->>'locale','en')=$3 AND deleted_at IS NULL LIMIT 1`, [siteId, slug, locale]
      );
      const row = result.rows[0];
      if (!row?.published_snapshot) return null;
      const snap = row.published_snapshot;
      return { id: row.id, site_id: row.site_id, title: snap.title, slug: snap.slug, locale: snap.locale, content_type: snap.contentType, status: 'published', body: snap.document, version: snap.version, published_version: row.published_version, published_at: row.published_at };
    },

    async listPublished({ siteId, contentType = 'post', locale = null, limit = 3, excludeId = null } = {}) {
      if (!siteId) throw new TypeError('siteId is required for published content queries.');
      const safeLimit = Math.min(12, Math.max(1, Number.isInteger(Number(limit)) ? Number(limit) : 3));
      const result = await pool.query(
        `SELECT id,site_id,content_type,published_snapshot,published_at
         FROM content_items
         WHERE site_id=$1 AND content_type=$2 AND published_snapshot IS NOT NULL AND deleted_at IS NULL
           AND ($3::text IS NULL OR COALESCE(published_snapshot->>'locale','en')=$3)
           AND ($4::uuid IS NULL OR id<>$4)
         ORDER BY published_at DESC NULLS LAST,updated_at DESC
         LIMIT $5`,
        [siteId, contentType, locale, excludeId, safeLimit]
      );
      return result.rows.map(row => {
        const snapshot = row.published_snapshot || {};
        const document = snapshot.document || {};
        return {
          id: row.id,
          siteId: row.site_id,
          contentType: row.content_type,
          slug: snapshot.slug,
          locale: snapshot.locale || 'en',
          title: snapshot.title || document.title || '',
          excerpt: extractPageText(document, 1200).replace(/\s+/g, ' ').trim().slice(0, 320),
          publishedAt: row.published_at
        };
      });
    },

    async getSiteBySlug(slug) {
      const result = await pool.query('SELECT id,slug,name,default_locale FROM sites WHERE slug=$1 LIMIT 1', [slug]);
      return result.rows[0] || null;
    },

    async getById({ siteId, id }) {
      const result = await pool.query(
        `SELECT id,site_id,content_type,slug,locale,title,status,body,schema_version,version,published_snapshot,published_version,published_at,scheduled_at,created_by,updated_by,created_at,updated_at,reviewed_by,reviewed_at
         FROM content_items WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL`, [siteId, id]
      );
      return result.rows[0] || null;
    },

    async listContent({ siteId, status = null, contentType = null, limit = 50, offset = 0, actorId = null }) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
      const safeOffset = Math.max(0, Number(offset) || 0);
      const result = await pool.query(
        `SELECT id,content_type,slug,locale,title,status,version,published_version,published_at,scheduled_at,created_by,updated_by,updated_at
         FROM content_items WHERE site_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR content_type=$3) AND ($6::uuid IS NULL OR created_by=$6)
         ORDER BY updated_at DESC LIMIT $4 OFFSET $5`, [siteId, status, contentType, safeLimit, safeOffset, actorId]
      );
      return result.rows;
    },

    async listRevisions({ siteId, contentId, limit = 50 }) {
      const result = await pool.query(
        `SELECT r.id,r.version,r.author_id,r.change_summary,r.created_at
         FROM content_revisions r JOIN content_items c ON c.id=r.content_id
         WHERE c.site_id=$1 AND c.id=$2 ORDER BY r.version DESC LIMIT $3`, [siteId, contentId, Math.min(100, Math.max(1, Number(limit) || 50))]
      );
      return result.rows;
    },

    async getRevision({ siteId, contentId, version }) {
      const result = await pool.query(
        `SELECT r.id,r.version,r.snapshot,r.author_id,r.change_summary,r.created_at
         FROM content_revisions r JOIN content_items c ON c.id=r.content_id
         WHERE c.site_id=$1 AND c.id=$2 AND r.version=$3 LIMIT 1`, [siteId, contentId, version]
      );
      return result.rows[0] || null;
    },

    async submitForReview({ siteId, id, actorId, expectedVersion, note }) {
      return transition({ siteId, id, actorId, action: 'submitted_for_review', fromStatuses: ['draft'], toStatus: 'in_review', expectedVersion, note });
    },
    async approve({ siteId, id, actorId, expectedVersion, note }) {
      return transition({ siteId, id, actorId, action: 'approved', fromStatuses: ['in_review'], toStatus: 'approved', expectedVersion, note });
    },
    async rejectReview({ siteId, id, actorId, expectedVersion, note }) {
      return transition({ siteId, id, actorId, action: 'rejected', fromStatuses: ['in_review'], toStatus: 'draft', expectedVersion, note });
    },
    async publishContent({ siteId, id, actorId, expectedVersion, note }) {
      return transition({ siteId, id, actorId, action: 'published', fromStatuses: ['approved'], toStatus: 'published', expectedVersion, note, publish: true });
    },
    async scheduleContent({ siteId, id, actorId, scheduledAt, expectedVersion, note }) {
      const when = new Date(scheduledAt);
      if (!Number.isFinite(when.getTime()) || when.getTime() < Date.now() + 60_000 || when.getTime() > Date.now() + 366 * 24 * 60 * 60_000) {
        const error = new Error('scheduledAt must be between one minute and one year in the future.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_SCHEDULE'; throw error;
      }
      return transition({ siteId, id, actorId, action: 'scheduled', fromStatuses: ['approved'], toStatus: 'scheduled', expectedVersion, note, scheduledAt: when });
    },
    async archiveContent({ siteId, id, actorId, expectedVersion, note }) {
      return transition({ siteId, id, actorId, action: 'archived', fromStatuses: ['draft','in_review','approved','scheduled','published'], toStatus: 'archived', expectedVersion, note, clearPublished: true });
    },
    async unpublishContent({ siteId, id, actorId, expectedVersion, note }) {
      return transition({ siteId, id, actorId, action: 'unpublished', fromStatuses: ['published'], toStatus: 'draft', expectedVersion, note, clearPublished: true });
    },

    async publishDue({ limit = 20 } = {}) {
      const client = await pool.connect(); const published = [];
      try {
        await client.query('BEGIN');
        const due = await client.query(
          `SELECT id,site_id,title,slug,locale,content_type,body,version,lock_version FROM content_items
           WHERE status='scheduled' AND scheduled_at<=now() AND deleted_at IS NULL
           ORDER BY scheduled_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [Math.min(100, Math.max(1, Number(limit) || 20))]
        );
        for (const row of due.rows) {
          const snapshot = { title: row.title, slug: row.slug, locale: row.locale, contentType: row.content_type, status: 'published', document: row.body, version: row.version };
          const result = await client.query(
            `UPDATE content_items SET status='published',published_snapshot=$2::jsonb,published_version=version,published_at=now(),scheduled_at=NULL,
             published_search_vector=to_tsvector('simple',$3 || ' ' || $4),lock_version=lock_version+1,updated_at=now()
             WHERE id=$1 RETURNING id,site_id,slug,locale,version,lock_version`, [row.id, JSON.stringify(snapshot), row.title, extractPageText(row.body)]
          );
          await writeWorkflow(client, { siteId: row.site_id, id: row.id, version: row.version, action: 'published', fromStatus: 'scheduled', toStatus: 'published', actorId: null, note: 'Published by scheduler' });
          await writeOutbox(client, { id: row.id, siteId: row.site_id, version: row.version, aggregateVersion: result.rows[0].lock_version, eventType: 'content.publish', payload: { slug: row.slug, locale: row.locale, status: 'published', source: 'scheduler' } });
          published.push(result.rows[0]);
        }
        await client.query('COMMIT'); return published;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async search({ siteId, query, limit = 20, locale = null }) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
      const result = await pool.query(
        `SELECT id,content_type,published_snapshot->>'slug' AS slug,published_snapshot->>'locale' AS locale,
           published_snapshot->>'title' AS title,ts_rank(published_search_vector,plainto_tsquery('simple',$2)) AS rank
         FROM content_items WHERE site_id=$1 AND published_snapshot IS NOT NULL AND deleted_at IS NULL
         AND published_search_vector @@ plainto_tsquery('simple',$2) AND ($4::text IS NULL OR published_snapshot->>'locale'=$4)
         ORDER BY rank DESC,updated_at DESC LIMIT $3`, [siteId, query, safeLimit, locale]
      );
      return result.rows;
    },

    async close() { await pool.end(); }
  };
  return Object.freeze(store);
}

module.exports = { createPostgresPool, createPostgresStore, extractPageText };
