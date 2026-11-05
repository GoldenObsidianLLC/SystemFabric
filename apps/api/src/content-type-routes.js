'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  validateContentTypeDefinition,
  validateRecordValues,
  NAME_RE: CONTENT_TYPE_NAME_RE,
} = require('../../../packages/domain/src/content-types');
const { withTransaction } = require('../../../packages/db/src/transaction');
const { isBoundedJsonObject } = require('./request-validation');

function loadGitContentTypeDefinitions() {
  const directory = path.resolve(__dirname, '../../../config/cpt');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(file => /^[a-z0-9_-]+\.json$/i.test(file))
    .map(file => {
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      } catch {
        throw new Error('Invalid Git-managed content type definition: ' + file);
      }
    });
}

function createContentTypeRouteHandler({
  loadGitDefinitions = loadGitContentTypeDefinitions,
  normalizeSlug,
} = {}) {
  if (typeof loadGitDefinitions !== 'function') {
    throw new TypeError('A Git-managed content type definition loader is required.');
  }
  if (typeof normalizeSlug !== 'function') {
    throw new TypeError('A content record slug normalizer is required.');
  }

  // Git-managed definitions are immutable for the lifetime of an API process.
  // Cache their parsed files instead of hitting the filesystem on each request.
  let gitDefinitions;
  function getGitDefinitions() {
    if (!gitDefinitions) {
      const loaded = loadGitDefinitions();
      if (!Array.isArray(loaded)) throw new TypeError('Git-managed content type definitions must be an array.');
      gitDefinitions = loaded;
    }
    return gitDefinitions;
  }

  async function getContentTypeDefinition({ siteId, slug, localPool, fail }) {
    if (!CONTENT_TYPE_NAME_RE.test(slug)) {
      throw fail(400, 'ERR_VIRGOSCORPIO_HUB_CONTENT_TYPE_INVALID', 'Content type slug is invalid.');
    }
    const git = getGitDefinitions().find(item => item.name === slug);
    if (git) {
      const validation = validateContentTypeDefinition(git);
      if (!validation.valid) {
        throw new Error('Git-managed content type ' + slug + ' is invalid: ' + validation.errors.join('; '));
      }
      return git;
    }
    if (!localPool) return null;
    const result = await localPool.query(
      'SELECT definition FROM content_type_definitions WHERE site_id=$1 AND slug=$2 AND active=true ORDER BY version DESC LIMIT 1',
      [siteId, slug],
    );
    return result.rows[0]?.definition || null;
  }

  async function getContentReadScope({ actor, identity, siteId, fail }) {
    if (actor.isDeveloper) return { ownOnly: false };
    if (await identity.authorizeSite(actor.user.id, siteId, 'content:read')) {
      return { ownOnly: false };
    }
    if (await identity.authorizeSite(actor.user.id, siteId, 'content:read:own')) {
      return { ownOnly: true };
    }
    throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'Content read permission is required.');
  }

  /**
   * Handle the custom content-type registry and record route family.
   *
   * The API composition layer authenticates the actor, resolves site scope,
   * and supplies capability checks, bounded request parsing, response/error
   * helpers, PostgreSQL and the content store. This module owns Git/admin
   * definition precedence, version-locked registry writes, record schema
   * validation, and site-scoped record dispatch. It returns false only when
   * the path/method is not part of this route family.
   */
  return async function handleContentTypeRoute(ctx) {
    const {
      req,
      res,
      url,
      actor,
      siteIdFor,
      requireCapability,
      readJson,
      sendJson,
      fail,
      requestId,
      localPool,
      store,
      identity,
      maxBody,
    } = ctx;
    const method = req.method;
    const pathName = url.pathname;

    if (pathName === '/api/v1/content-types' && (method === 'GET' || method === 'POST')) {
      if (!localPool) {
        return sendJson(res, 503, {
          error: 'Content type registry requires PostgreSQL.',
          code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED',
          requestId,
        });
      }

      if (method === 'GET') {
        const siteId = await siteIdFor({ req, url, actor });
        await getContentReadScope({ actor, identity, siteId, fail });

        const git = getGitDefinitions();
        const db = await localPool.query(
          'SELECT slug,label,version,definition,source,updated_at FROM content_type_definitions WHERE site_id=$1 AND active=true ORDER BY slug,version DESC',
          [siteId],
        );
        const gitNames = new Set(git.map(item => item.name));
        const admin = db.rows
          .filter(row => !gitNames.has(row.slug))
          .map(row => ({ ...row.definition, source: row.source, updatedAt: row.updated_at }));
        const conflicts = db.rows.filter(row => gitNames.has(row.slug)).map(row => row.slug);
        return sendJson(res, 200, {
          definitions: [...git, ...admin],
          conflicts: [...new Set(conflicts)],
          precedence: 'Git-managed definitions are authoritative; name conflicts are rejected.',
          requestId,
        });
      }

      const body = await readJson(req, Math.min(maxBody, 256_000));
      if (!isBoundedJsonObject(body, Math.min(maxBody, 256_000))) {
        throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_JSON', 'Content type request must be a bounded JSON object.');
      }
      const siteId = await siteIdFor({ req, url, body, actor });
      await requireCapability(actor, siteId, 'site:manage');

      const definition = { ...body.definition, source: 'admin', apiVersion: 1 };
      const validation = validateContentTypeDefinition(definition);
      if (!validation.valid) {
        throw fail(422, 'ERR_VIRGOSCORPIO_HUB_CONTENT_TYPE_INVALID', 'Content type definition failed validation.', validation.errors);
      }
      if (getGitDefinitions().some(item => item.name === definition.name)) {
        throw fail(409, 'ERR_VIRGOSCORPIO_HUB_CONTENT_TYPE_CONFLICT', 'A Git-managed definition already owns this slug. Rename one definition rather than silently overriding it.');
      }

      const row = await withTransaction(localPool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [siteId, definition.name]);
        const old = await client.query(
          'SELECT COALESCE(max(version),0)::integer AS version FROM content_type_definitions WHERE site_id=$1 AND slug=$2',
          [siteId, definition.name],
        );
        definition.version = old.rows[0].version + 1;
        await client.query(
          'UPDATE content_type_definitions SET active=false,updated_at=now() WHERE site_id=$1 AND slug=$2 AND active=true',
          [siteId, definition.name],
        );
        const result = await client.query(
          "INSERT INTO content_type_definitions(site_id,slug,label,version,source,active,definition) VALUES($1,$2,$3,$4,'admin',true,$5::jsonb) RETURNING id,slug,label,version,source,active",
          [siteId, definition.name, definition.label, definition.version, JSON.stringify(definition)],
        );
        return result.rows[0];
      });

      return sendJson(res, 201, { definition: { ...definition, id: row.id }, requestId });
    }

    const recordsMatch = pathName.match(/^\/api\/v1\/content-types\/([a-z][a-z0-9_-]{0,62})\/records$/i);
    if (recordsMatch && (method === 'GET' || method === 'POST')) {
      if (!store) {
        return sendJson(res, 503, {
          error: 'Content storage requires PostgreSQL.',
          code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED',
          requestId,
        });
      }

      let body = {};
      if (method === 'POST') {
        body = await readJson(req, maxBody);
        if (!isBoundedJsonObject(body, maxBody)) {
          throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_JSON', 'Content record request must be a bounded JSON object.');
        }
      }
      const slug = recordsMatch[1];
      const siteId = await siteIdFor({ req, url, body, actor });

      if (method === 'GET') {
        const readScope = await getContentReadScope({ actor, identity, siteId, fail });
        const definition = await getContentTypeDefinition({ siteId, slug, localPool, fail });
        if (!definition) {
          return sendJson(res, 404, {
            error: 'Content type not found.',
            code: 'ERR_VIRGOSCORPIO_HUB_CONTENT_TYPE_NOT_FOUND',
            requestId,
          });
        }
        return sendJson(res, 200, {
          items: await store.listContent({
            siteId,
            contentType: slug,
            status: url.searchParams.get('status'),
            limit: url.searchParams.get('limit') || 50,
            offset: url.searchParams.get('offset') || 0,
            actorId: readScope.ownOnly ? actor.user.id : null,
          }),
          requestId,
        });
      }

      await requireCapability(actor, siteId, 'content:create');
      const definition = await getContentTypeDefinition({ siteId, slug, localPool, fail });
      if (!definition) {
        return sendJson(res, 404, {
          error: 'Content type not found.',
          code: 'ERR_VIRGOSCORPIO_HUB_CONTENT_TYPE_NOT_FOUND',
          requestId,
        });
      }
      const validation = validateRecordValues(definition, body.values);
      if (!validation.valid) {
        throw fail(422, 'ERR_VIRGOSCORPIO_HUB_CONTENT_VALUES_INVALID', 'Record values failed schema validation.', validation.errors);
      }

      const title = String(body.title || body.values.title || body.values.name || slug).slice(0, 500);
      const recordSlug = normalizeSlug(body.slug || title);
      if (!recordSlug) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SLUG', 'A valid record slug is required.');
      const record = { schemaVersion: 1, documentType: 'custom:' + slug, fields: body.values };
      const saved = await store.saveDraft({
        siteId,
        title,
        slug: recordSlug,
        locale: typeof body.locale === 'string' ? body.locale : 'en',
        contentType: slug,
        document: record,
        authorId: actor.user.id,
        correlationId: requestId,
      });
      return sendJson(res, 201, { status: 'draft', record: saved, requestId });
    }

    const recordMatch = pathName.match(/^\/api\/v1\/content-types\/([a-z][a-z0-9_-]{0,62})\/records\/([0-9a-f-]{36})$/i);
    if (method === 'GET' && recordMatch) {
      if (!store) {
        return sendJson(res, 503, {
          error: 'Content storage requires PostgreSQL.',
          code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED',
          requestId,
        });
      }

      const siteId = await siteIdFor({ req, url, actor });
      const readScope = await getContentReadScope({ actor, identity, siteId, fail });
      const definition = await getContentTypeDefinition({ siteId, slug: recordMatch[1], localPool, fail });
      if (!definition) return sendJson(res, 404, { error: 'Content type not found.', requestId });

      const record = readScope.ownOnly
        ? await store.getByIdForOwner({ siteId, id: recordMatch[2], actorId: actor.user.id })
        : await store.getById({ siteId, id: recordMatch[2] });
      if (!record || record.content_type !== recordMatch[1] ||
          (readScope.ownOnly && String(record.created_by || '').toLowerCase() !== String(actor.user.id).toLowerCase())) {
        return sendJson(res, 404, { error: 'Record not found.', requestId });
      }
      return sendJson(res, 200, { record, definition, requestId });
    }

    return false;
  };
}

module.exports = { createContentTypeRouteHandler, loadGitContentTypeDefinitions };
