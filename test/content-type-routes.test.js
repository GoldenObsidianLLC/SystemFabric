'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContentTypeRouteHandler } = require('../apps/api/src/content-type-routes');

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECORD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ARTICLE = {
  apiVersion: 1,
  name: 'article',
  label: 'Articles',
  source: 'git',
  version: 1,
  fields: [{ name: 'title', type: 'string', required: true, maxLength: 180 }],
  capabilities: ['read', 'create', 'edit', 'publish'],
  publicationPolicy: 'review-required',
};

const JOB = {
  apiVersion: 1,
  name: 'job',
  label: 'Jobs',
  source: 'admin',
  version: 2,
  fields: [{ name: 'title', type: 'string', required: true, maxLength: 180 }],
  capabilities: ['read', 'create', 'edit'],
  publicationPolicy: 'owner-only',
};

function normalizeSlug(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}

function createHandler(gitDefinitions = [ARTICLE]) {
  let loads = 0;
  const handler = createContentTypeRouteHandler({
    loadGitDefinitions() { loads += 1; return gitDefinitions; },
    normalizeSlug,
  });
  return { handler, loadCount: () => loads };
}

function createPool({ rows = [], latestVersion = 0, insertError = null } = {}) {
  const events = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      events.push({ type: 'client.query', sql: normalized, params });
      if (normalized.startsWith('SELECT COALESCE(max(version)')) return { rows: [{ version: latestVersion }] };
      if (normalized.startsWith('INSERT INTO content_type_definitions')) {
        if (insertError) throw insertError;
        return { rows: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', slug: 'careers', label: 'Careers', version: latestVersion + 1, source: 'admin', active: true }] };
      }
      return { rows: [] };
    },
    release() { events.push({ type: 'client.release' }); },
  };
  const pool = {
    async query(sql, params = []) {
      events.push({ type: 'pool.query', sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rows };
    },
    async connect() { events.push({ type: 'pool.connect' }); return client; },
  };
  return { pool, events };
}

function createContext({
  path,
  method = 'GET',
  body = {},
  localPool = null,
  store = null,
  capabilities = ['content:read', 'content:create', 'site:manage'],
  identityOverrides = {},
} = {}) {
  const events = [];
  const result = {};
  const res = { result };
  const identity = {
    async authorizeSite(userId, siteId, capability) {
      events.push({ type: 'authorizeSite', userId, siteId, capability });
      return capabilities.includes(capability);
    },
    ...identityOverrides,
  };
  const ctx = {
    req: { method },
    res,
    url: new URL('http://localhost' + path),
    actor: { user: { id: ACTOR_ID }, isDeveloper: false },
    siteIdFor: async input => { events.push({ type: 'siteIdFor', input }); return SITE_ID; },
    requireCapability: async (...args) => {
      events.push({ type: 'requireCapability', args });
      if (!capabilities.includes(args[2])) throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN' });
      return true;
    },
    readJson: async (req, maxBytes) => { events.push({ type: 'readJson', maxBytes }); return body; },
    sendJson: (response, statusCode, payload) => {
      events.push({ type: 'sendJson', statusCode });
      response.result.statusCode = statusCode;
      response.result.payload = payload;
      return true;
    },
    fail: (statusCode, code, message, details) => Object.assign(new Error(message), { statusCode, code, details }),
    requestId: 'request-content-types',
    localPool,
    store,
    identity,
    maxBody: 128_000,
    events,
  };
  return ctx;
}

test('unmatched content-type paths and methods decline without side effects', async () => {
  const { handler } = createHandler();
  const ctx = createContext({ path: '/api/v1/content-types/article/records', method: 'PUT' });
  assert.equal(await handler(ctx), false);
  assert.deepEqual(ctx.events, []);
});

test('registry reports PostgreSQL unavailable before reading a request or resolving a site', async () => {
  const { handler } = createHandler();
  const ctx = createContext({ path: '/api/v1/content-types', method: 'POST', body: { definition: JOB } });
  assert.equal(await handler(ctx), true);
  assert.equal(ctx.res.result.statusCode, 503);
  assert.equal(ctx.res.result.payload.code, 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED');
  assert.deepEqual(ctx.events.map(event => event.type), ['sendJson']);
});

test('registry read authorizes before querying and preserves Git-managed precedence', async () => {
  const { handler } = createHandler([ARTICLE]);
  const { pool, events: poolEvents } = createPool({
    rows: [
      { slug: 'article', label: 'Database override', version: 4, definition: { ...JOB, name: 'article', label: 'Database override' }, source: 'admin', updated_at: '2026-11-05T00:00:00.000Z' },
      { slug: 'job', label: 'Jobs', version: 2, definition: JOB, source: 'admin', updated_at: '2026-11-04T00:00:00.000Z' },
    ],
  });
  const ctx = createContext({ path: '/api/v1/content-types', localPool: pool });

  assert.equal(await handler(ctx), true);
  assert.equal(ctx.res.result.statusCode, 200);
  assert.deepEqual(ctx.res.result.payload.definitions.map(item => item.name), ['article', 'job']);
  assert.equal(ctx.res.result.payload.definitions[0].source, 'git');
  assert.equal(ctx.res.result.payload.definitions[1].source, 'admin');
  assert.deepEqual(ctx.res.result.payload.conflicts, ['article']);
  assert.deepEqual(poolEvents.map(event => event.type), ['pool.query']);
  assert.deepEqual(poolEvents[0].params, [SITE_ID]);
  assert.deepEqual(ctx.events.map(event => event.type), ['siteIdFor', 'authorizeSite', 'sendJson']);
  assert.equal(ctx.events[1].capability, 'content:read');
});

test('registry read denies access before loading database definitions', async () => {
  const { handler } = createHandler([]);
  const { pool, events: poolEvents } = createPool();
  const ctx = createContext({ path: '/api/v1/content-types', localPool: pool, capabilities: [] });

  await assert.rejects(handler(ctx), error => error.statusCode === 403);
  assert.deepEqual(poolEvents, []);
  assert.deepEqual(ctx.events.map(event => event.type), ['siteIdFor', 'authorizeSite', 'authorizeSite']);
});

test('admin definition creation assigns the next version under the advisory transaction lock', async () => {
  const { handler } = createHandler([ARTICLE]);
  const { pool, events } = createPool({ latestVersion: 3 });
  const ctx = createContext({
    path: '/api/v1/content-types',
    method: 'POST',
    localPool: pool,
    body: {
      definition: {
        apiVersion: 1,
        name: 'careers',
        label: 'Careers',
        version: 1,
        fields: [{ name: 'title', type: 'string', required: true, maxLength: 180 }],
        capabilities: ['read', 'create', 'edit'],
        publicationPolicy: 'review-required',
      },
    },
  });

  assert.equal(await handler(ctx), true);
  assert.equal(ctx.res.result.statusCode, 201);
  assert.equal(ctx.res.result.payload.definition.version, 4);
  assert.equal(ctx.res.result.payload.definition.source, 'admin');
  const sql = events.filter(event => event.type === 'client.query').map(event => event.sql);
  assert.equal(sql[0], 'BEGIN');
  assert.match(sql[1], /pg_advisory_xact_lock/);
  assert.match(sql[2], /SELECT COALESCE\(max\(version\),0\)/);
  assert.match(sql[3], /UPDATE content_type_definitions SET active=false/);
  assert.match(sql[4], /INSERT INTO content_type_definitions/);
  assert.equal(sql[5], 'COMMIT');
  assert.equal(events.at(-1).type, 'client.release');
  assert.deepEqual(events[2].params, [SITE_ID, 'careers']);
  assert.deepEqual(ctx.events.map(event => event.type), ['readJson', 'siteIdFor', 'requireCapability', 'sendJson']);
});

test('admin definition creation rejects Git-managed slug conflicts before opening a transaction', async () => {
  const { handler } = createHandler([ARTICLE]);
  const { pool, events } = createPool();
  const ctx = createContext({
    path: '/api/v1/content-types',
    method: 'POST',
    localPool: pool,
    body: { definition: { ...ARTICLE, label: 'Admin article' } },
  });

  await assert.rejects(handler(ctx), error => error.statusCode === 409 && error.code === 'ERR_VIRGOSCORPIO_HUB_CONTENT_TYPE_CONFLICT');
  assert.deepEqual(events, []);
  assert.deepEqual(ctx.events.map(event => event.type), ['readJson', 'siteIdFor', 'requireCapability']);
});

test('admin definition persistence rolls back and releases its client on failure', async () => {
  const { handler } = createHandler([]);
  const { pool, events } = createPool({ insertError: new Error('database unavailable') });
  const ctx = createContext({
    path: '/api/v1/content-types',
    method: 'POST',
    localPool: pool,
    body: {
      definition: {
        apiVersion: 1,
        name: 'careers',
        label: 'Careers',
        version: 1,
        fields: [{ name: 'title', type: 'string', required: true, maxLength: 180 }],
        capabilities: ['read', 'create'],
        publicationPolicy: 'review-required',
      },
    },
  });

  await assert.rejects(handler(ctx), /database unavailable/);
  assert.equal(events.filter(event => event.type === 'client.query').at(-1).sql, 'ROLLBACK');
  assert.ok(events.some(event => event.type === 'client.release'));
  assert.ok(!ctx.events.some(event => event.type === 'sendJson'));
});

test('record listing checks content read before querying admin definitions or reading records', async () => {
  const { handler } = createHandler([]);
  const { pool, events: poolEvents } = createPool();
  const store = { async listContent() { throw new Error('record store must not be read after denied authorization'); } };
  const ctx = createContext({ path: '/api/v1/content-types/job/records', localPool: pool, store, capabilities: [] });

  await assert.rejects(handler(ctx), error => error.statusCode === 403);
  assert.deepEqual(poolEvents, []);
  assert.deepEqual(ctx.events.map(event => event.type), ['siteIdFor', 'authorizeSite', 'authorizeSite']);
});

test('record listing is site-scoped and applies status and pagination filters', async () => {
  const { handler } = createHandler([ARTICLE]);
  const listed = [];
  const store = { async listContent(input) { listed.push(input); return [{ id: RECORD_ID, content_type: 'article', status: 'draft' }]; } };
  const ctx = createContext({ path: '/api/v1/content-types/article/records?status=draft&limit=10&offset=3', store });

  assert.equal(await handler(ctx), true);
  assert.equal(ctx.res.result.statusCode, 200);
  assert.deepEqual(listed, [{
    siteId: SITE_ID, contentType: 'article', status: 'draft', limit: '10', offset: '3', actorId: null,
  }]);
  assert.equal(ctx.res.result.payload.items[0].id, RECORD_ID);
  assert.deepEqual(ctx.events.map(event => event.type), ['siteIdFor', 'authorizeSite', 'sendJson']);
});

test('record creation validates values and persists the custom document envelope', async () => {
  const { handler } = createHandler([ARTICLE]);
  const saved = [];
  const store = { async saveDraft(input) { saved.push(input); return { id: RECORD_ID, version: 1, status: 'draft' }; } };
  const ctx = createContext({
    path: '/api/v1/content-types/article/records',
    method: 'POST',
    store,
    body: { title: 'Résumé', values: { title: 'Résumé' } },
  });

  assert.equal(await handler(ctx), true);
  assert.equal(ctx.res.result.statusCode, 201);
  assert.deepEqual(saved, [{
    siteId: SITE_ID,
    title: 'Résumé',
    slug: 'resume',
    locale: 'en',
    contentType: 'article',
    document: { schemaVersion: 1, documentType: 'custom:article', fields: { title: 'Résumé' } },
    authorId: ACTOR_ID,
    correlationId: 'request-content-types',
  }]);
});

test('record creation checks content:create before resolving an admin definition', async () => {
  const { handler } = createHandler([]);
  const { pool, events: poolEvents } = createPool();
  const store = { async saveDraft() { throw new Error('must not save'); } };
  const ctx = createContext({
    path: '/api/v1/content-types/job/records',
    method: 'POST',
    localPool: pool,
    store,
    capabilities: ['content:read'],
    body: { title: 'Denied', values: { title: 'Denied' } },
  });

  await assert.rejects(handler(ctx), error => error.statusCode === 403);
  assert.deepEqual(poolEvents, []);
  assert.deepEqual(ctx.events.map(event => event.type), ['readJson', 'siteIdFor', 'requireCapability']);
});

test('record creation rejects unknown fields before persistence', async () => {
  const { handler } = createHandler([ARTICLE]);
  const saved = [];
  const store = { async saveDraft(input) { saved.push(input); } };
  const ctx = createContext({
    path: '/api/v1/content-types/article/records',
    method: 'POST',
    store,
    body: { values: { title: 'Allowed', unexpected: true } },
  });

  await assert.rejects(handler(ctx), error => error.statusCode === 422 && error.code === 'ERR_VIRGOSCORPIO_HUB_CONTENT_VALUES_INVALID');
  assert.deepEqual(saved, []);
});

test('record creation rejects non-object JSON instead of returning an internal error', async () => {
  const { handler } = createHandler([ARTICLE]);
  const store = { async saveDraft() { throw new Error('must not save'); } };
  const ctx = createContext({
    path: '/api/v1/content-types/article/records',
    method: 'POST',
    store,
    body: null,
  });

  await assert.rejects(handler(ctx), error => error.statusCode === 400 && error.code === 'ERR_VIRGOSCORPIO_HUB_INVALID_JSON');
});

test('record lookup authorizes before resolving definitions or reading records', async () => {
  const { handler } = createHandler([]);
  const { pool, events: poolEvents } = createPool();
  const store = { async getById() { throw new Error('record store must not be read after denied authorization'); } };
  const ctx = createContext({
    path: '/api/v1/content-types/job/records/' + RECORD_ID,
    store,
    localPool: pool,
    capabilities: [],
  });

  await assert.rejects(handler(ctx), error => error.statusCode === 403);
  assert.deepEqual(poolEvents, []);
  assert.deepEqual(ctx.events.map(event => event.type), ['siteIdFor', 'authorizeSite', 'authorizeSite']);
});

test('record lookup passes site scope to storage and hides records with another content type', async () => {
  const { handler } = createHandler([ARTICLE]);
  const lookedUp = [];
  const store = { async getById(input) { lookedUp.push(input); return { id: RECORD_ID, content_type: 'job', status: 'draft' }; } };
  const ctx = createContext({ path: '/api/v1/content-types/article/records/' + RECORD_ID, store });

  assert.equal(await handler(ctx), true);
  assert.equal(ctx.res.result.statusCode, 404);
  assert.deepEqual(lookedUp, [{ siteId: SITE_ID, id: RECORD_ID }]);
  assert.equal(ctx.res.result.payload.error, 'Record not found.');
});

test('missing content type returns not-found without reading the record store', async () => {
  const { handler } = createHandler([]);
  const { pool } = createPool({ rows: [] });
  let recordReads = 0;
  const store = { async getById() { recordReads += 1; return null; } };
  const ctx = createContext({
    path: '/api/v1/content-types/missing/records/' + RECORD_ID,
    store,
    localPool: pool,
  });

  assert.equal(await handler(ctx), true);
  assert.equal(ctx.res.result.statusCode, 404);
  assert.equal(ctx.res.result.payload.error, 'Content type not found.');
  assert.equal(recordReads, 0);
});


test('Git-managed definitions are loaded once per route-handler lifetime', async () => {
  const { handler, loadCount } = createHandler([ARTICLE]);
  const { pool } = createPool();
  for (let index = 0; index < 2; index += 1) {
    const ctx = createContext({ path: '/api/v1/content-types', localPool: pool });
    assert.equal(await handler(ctx), true);
    assert.equal(ctx.res.result.statusCode, 200);
  }
  assert.equal(loadCount(), 1);
});


test('content:read:own lists only the current actor’s records at the database boundary', async () => {
  const { handler } = createHandler([ARTICLE]);
  const listed = [];
  const store = {
    async listContent(input) {
      listed.push(input);
      return [{ id: RECORD_ID, content_type: 'article', created_by: ACTOR_ID }];
    },
  };
  const ctx = createContext({
    path: '/api/v1/content-types/article/records',
    store,
    capabilities: ['content:read:own'],
  });

  assert.equal(await handler(ctx), true);
  assert.equal(ctx.res.result.statusCode, 200);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].actorId, ACTOR_ID);
  assert.deepEqual(ctx.events.filter(event => event.type === 'authorizeSite').map(event => event.capability), [
    'content:read',
    'content:read:own',
  ]);
});

test('content:read:own uses the database owner-scoped detail lookup', async () => {
  const { handler } = createHandler([ARTICLE]);
  const ownerLookups = [];
  const ctx = createContext({
    path: '/api/v1/content-types/article/records/' + RECORD_ID,
    store: {
      async getById() {
        throw new Error('unscoped record lookup must not run for content:read:own');
      },
      async getByIdForOwner(input) {
        ownerLookups.push(input);
        return null;
      },
    },
    capabilities: ['content:read:own'],
  });

  assert.equal(await handler(ctx), true);
  assert.equal(ctx.res.result.statusCode, 404);
  assert.equal(ctx.res.result.payload.error, 'Record not found.');
  assert.deepEqual(ownerLookups, [{ siteId: SITE_ID, id: RECORD_ID, actorId: ACTOR_ID }]);
});
