'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleLibraryRoute } = require('../apps/api/src/library-routes');
const { handlePlatformRoute } = require('../apps/api/src/platform-routes');

const siteId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const requestId = 'req-library-test-01';

function fail(statusCode, code, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function createContext({
  path = '/api/v1/unmatched',
  method = 'GET',
  body = {},
  events = [],
  pool = {},
  libraryStore = {},
  identity = { async audit(entry) { events.push({ type: 'audit', entry }); } }
} = {}) {
  const res = {
    statusCode: 0,
    payload: null,
    headers: null,
    data: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
      events.push({ type: 'writeHead', statusCode, headers });
    },
    end(data) {
      this.data = data;
      events.push({ type: 'end', data });
    }
  };

  return {
    req: { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    res,
    url: new URL(`http://localhost${path}`),
    actor: { user: { id: actorId, email: 'library-user@example.test' } },
    requestId,
    localPool: pool,
    libraryStore,
    identity,
    firewall: { clearCache() {} },
    env: {},
    maxBody: 1_000_000,
    maxLibraryBody: 750_000,
    maxOptimizerBytes: 8_000_000,
    async siteIdFor(input) {
      events.push({ type: 'site', siteId: input.routeSiteId || null });
      return input.routeSiteId;
    },
    async requireCapability(_actor, targetSiteId, capability) {
      events.push({ type: 'capability', siteId: targetSiteId, capability });
    },
    async readJson(_req, maxBytes) {
      events.push({ type: 'readJson', maxBytes });
      return body;
    },
    sendJson(response, statusCode, payload) {
      response.statusCode = statusCode;
      response.payload = payload;
      events.push({ type: 'sendJson', statusCode });
      return true;
    },
    fail
  };
}

test('library router declines unrelated paths without touching dependencies', async () => {
  const events = [];
  const ctx = createContext({ events });

  assert.equal(await handleLibraryRoute(ctx), false);
  assert.deepEqual(events, []);
  assert.equal(ctx.res.statusCode, 0);
});

test('library listing resolves site and capability before reading the tenant-scoped store', async () => {
  const events = [];
  const items = [{ id: assetId, site_id: siteId, asset_kind: 'image' }];
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/library/items?category=image&q=logo&limit=12&offset=3`,
    events,
    libraryStore: {
      async list(input) {
        events.push({ type: 'list', input });
        return items;
      }
    }
  });

  assert.equal(await handleLibraryRoute(ctx), true);
  assert.equal(ctx.res.statusCode, 200);
  assert.deepEqual(ctx.res.payload.items, items);
  assert.deepEqual(events.map(event => event.type), ['site', 'capability', 'list', 'sendJson']);
  assert.deepEqual(events[2].input, {
    siteId,
    category: 'image',
    query: 'logo',
    limit: '12',
    offset: '3'
  });
  assert.equal(events[1].capability, 'library:manage');
});

test('library upload uses the library body limit and records a metadata-only audit event', async () => {
  const events = [];
  const body = {
    category: 'image',
    dataBase64: 'cG5n',
    mimeType: 'image/png',
    fileName: 'brand.png',
    displayName: 'Brand mark',
    isPublic: false,
    metadata: { source: 'test' }
  };
  const asset = {
    id: assetId,
    asset_kind: 'image',
    mime_type: 'image/png',
    byte_size: 3,
    sha256: 'a'.repeat(64),
    is_public: false
  };
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/library/items`,
    method: 'POST',
    body,
    events,
    libraryStore: {
      async upload(input) {
        events.push({ type: 'upload', input });
        return asset;
      }
    }
  });

  assert.equal(await handleLibraryRoute(ctx), true);
  assert.equal(ctx.res.statusCode, 201);
  assert.deepEqual(ctx.res.payload.item, asset);
  assert.equal(ctx.res.payload.url, null);
  assert.deepEqual(events.map(event => event.type), [
    'readJson', 'site', 'capability', 'upload', 'audit', 'sendJson'
  ]);
  assert.equal(events[0].maxBytes, 750_000);
  assert.equal(events[3].input.siteId, siteId);
  assert.equal(events[3].input.actorId, actorId);
  assert.equal(events[4].entry.action, 'library.asset_uploaded');
  assert.equal(events[4].entry.details.sha256, 'a'.repeat(64));
  assert.equal(JSON.stringify(events[4]).includes('cG5n'), false, 'audit must not contain uploaded file data');
});

test('cross-site rejection happens before library capability checks or storage access', async () => {
  const events = [];
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/library/items`,
    events,
    libraryStore: {
      async list() {
        events.push({ type: 'list' });
        throw new Error('cross-site request must not reach storage');
      }
    }
  });
  ctx.siteIdFor = async input => {
    events.push({ type: 'site-reject', siteId: input.routeSiteId });
    throw fail(403, 'ERR_VIRGOSCORPIO_HUB_SITE_SCOPE_MISMATCH', 'Site scope mismatch.');
  };

  await assert.rejects(
    handleLibraryRoute(ctx),
    error => error.statusCode === 403 && error.code === 'ERR_VIRGOSCORPIO_HUB_SITE_SCOPE_MISMATCH'
  );
  assert.deepEqual(events.map(event => event.type), ['site-reject']);
});

test('private asset download sends hardened no-store headers and a sanitized attachment name', async () => {
  const events = [];
  const data = Buffer.from('private asset');
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/library/items/${assetId}/download`,
    events,
    libraryStore: {
      async getBufferById(input) {
        events.push({ type: 'getBufferById', input });
        return {
          asset: { original_name: 'report\r\n"unsafe".pdf', mime_type: 'application/pdf' },
          data
        };
      }
    }
  });

  assert.equal(await handleLibraryRoute(ctx), true);
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.data, data);
  assert.deepEqual(events.map(event => event.type), [
    'site', 'capability', 'getBufferById', 'writeHead', 'end'
  ]);
  assert.equal(events[2].input.siteId, siteId);
  assert.equal(events[2].input.id, assetId);
  assert.equal(ctx.res.headers['cache-control'], 'private, no-store');
  assert.equal(ctx.res.headers['x-content-type-options'], 'nosniff');
  assert.equal(ctx.res.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(ctx.res.headers['content-type'], 'application/pdf');
  assert.equal(ctx.res.headers['content-disposition'], 'attachment; filename="report___unsafe_.pdf"');
});

test('asset version replacement is audited after the versioned store operation', async () => {
  const events = [];
  const body = { expectedVersion: 2, dataBase64: 'cG5n', mimeType: 'image/png', fileName: 'new.png' };
  const item = { id: assetId, version: 3, mime_type: 'image/png', sha256: 'b'.repeat(64) };
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/library/items/${assetId}`,
    method: 'PUT',
    body,
    events,
    libraryStore: {
      async replaceVersion(input) {
        events.push({ type: 'replaceVersion', input });
        return item;
      }
    }
  });

  assert.equal(await handleLibraryRoute(ctx), true);
  assert.equal(ctx.res.statusCode, 200);
  assert.deepEqual(ctx.res.payload.item, item);
  assert.deepEqual(events.map(event => event.type), [
    'readJson', 'site', 'capability', 'replaceVersion', 'audit', 'sendJson'
  ]);
  assert.equal(events[0].maxBytes, 750_000);
  assert.equal(events[3].input.expectedVersion, 2);
  assert.equal(events[4].entry.action, 'library.asset_version_replaced');
  assert.equal(events[4].entry.details.version, 3);
});

test('library route-level errors use the established Hub error namespace', async t => {
  await t.test('configured storage is required', async () => {
    const ctx = createContext({
      path: `/api/v1/sites/${siteId}/library/items`,
      libraryStore: null,
    });
    await assert.rejects(
      handleLibraryRoute(ctx),
      error => error.statusCode === 503 && error.code === 'ERR_VIRGOSCORPIO_HUB_LIBRARY_DISABLED',
    );
  });

  await t.test('missing private asset preserves its established error code', async () => {
    const ctx = createContext({
      path: `/api/v1/sites/${siteId}/library/items/${assetId}/download`,
      libraryStore: { async getBufferById() { return null; } },
    });
    await assert.rejects(
      handleLibraryRoute(ctx),
      error => error.statusCode === 404 && error.code === 'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND',
    );
  });
});

test('unsupported optimization is recorded as skipped without invoking a media provider', async () => {
  const events = [];
  const statuses = [];
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/library/items/${assetId}/optimize`,
    method: 'POST',
    events,
    libraryStore: {
      async getBufferById(input) {
        events.push({ type: 'getBufferById', input });
        return {
          asset: { asset_kind: 'document', mime_type: 'application/pdf' },
          data: Buffer.from('%PDF')
        };
      },
      async markOptimization(input) {
        statuses.push(input);
        events.push({ type: 'markOptimization', input });
      }
    }
  });

  assert.equal(await handleLibraryRoute(ctx), true);
  assert.equal(ctx.res.statusCode, 200);
  assert.deepEqual(ctx.res.payload.optimization, {
    status: 'skipped',
    reason: 'no-optimizer-for-this-media-type'
  });
  assert.deepEqual(statuses.map(entry => entry.status), ['processing', 'skipped']);
  assert.equal(statuses.every(entry => entry.siteId === siteId && entry.id === assetId), true);
});


test('platform composition delegates library requests to the dedicated route family', async () => {
  const events = [];
  const items = [{ id: assetId, site_id: siteId, asset_kind: 'image' }];
  const ctx = createContext({
    path: `/api/v1/sites/${siteId}/library/items`,
    events,
    libraryStore: {
      async list(input) {
        events.push({ type: 'list', input });
        return items;
      }
    }
  });

  assert.equal(await handlePlatformRoute(ctx), true);
  assert.equal(ctx.res.statusCode, 200);
  assert.deepEqual(ctx.res.payload.items, items);
  assert.deepEqual(events.map(event => event.type), ['site', 'capability', 'list', 'sendJson']);
});
