'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiServer } = require('../apps/api/src/server');

async function withServer(fn, envExtra = {}) {
  const server = createApiServer({
    env: { NODE_ENV: 'test', SYSTEMFABRIC_API_TOKEN: 'test-secret-token', AI_PROVIDER: 'mock', MAX_REQUEST_BYTES: '16384', RATE_LIMIT_MAX_REQUESTS: '100', ...envExtra },
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); await server.systemfabric.close(); }
}

test('health endpoint is public and reports renderer and AI', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/health`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.service, 'systemfabric-api');
    assert.equal(data.version, require('../package.json').version);
    assert.equal(data.ai.provider, 'mock');
  });
});

test('API requires bearer token', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/api/v1/ai/status`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'ERR_SYSTEMFABRIC_UNAUTHORIZED');
  });
});

test('page-draft endpoint returns validated proposal, not a published record', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/api/v1/ai/page-draft`, {
      method: 'POST', headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Create a simple landing page' })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.status, 'draft-proposal');
    assert.equal(data.saved, false);
    assert.equal(data.published, false);
    assert.equal(data.document.type, 'page');
  });
});

test('preview endpoint returns HTML with restrictive CSP', async () => {
  await withServer(async base => {
    const draftRes = await fetch(`${base}/api/v1/ai/page-draft`, {
      method: 'POST', headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'A simple website' })
    });
    const draft = await draftRes.json();
    const res = await fetch(`${base}/api/v1/preview`, {
      method: 'POST', headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ document: draft.document })
    });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /script-src 'none'/);
    assert.match(html, /<!doctype html>/i);
  });
});

test('draft persistence is disabled when no database is configured', async () => {
  await withServer(async base => {
    const draftRes = await fetch(`${base}/api/v1/ai/page-draft`, {
      method: 'POST', headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'A simple website' })
    });
    const draft = await draftRes.json();
    const res = await fetch(`${base}/api/v1/pages/drafts`, {
      method: 'POST', headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ document: draft.document, reviewed: true })
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'ERR_SYSTEMFABRIC_DATABASE_DISABLED');
  });
});

test('production startup is intentionally blocked', () => {
  assert.throws(() => createApiServer({ env: { NODE_ENV: 'production' } }), /not production-ready/);
});


test('rejects bodies above configured byte limit', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/api/v1/ai/content-assist`, {
      method: 'POST', headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(3000), operation: 'rewrite' })
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, 'ERR_SYSTEMFABRIC_BODY_TOO_LARGE');
  }, { MAX_REQUEST_BYTES: '1024' });
});

test('rate limits failed authentication attempts before token verification', async () => {
  await withServer(async base => {
    const first = await fetch(`${base}/api/v1/ai/status`, { headers: { authorization: 'Bearer wrong-token' } });
    const second = await fetch(`${base}/api/v1/ai/status`, { headers: { authorization: 'Bearer test-secret-token' } });
    assert.equal(first.status, 401);
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers.get('retry-after')) >= 1);
  }, { RATE_LIMIT_MAX_REQUESTS: '1' });
});

test('draft validation rejects malformed IDs and locale tags', () => {
  const { validateSaveDraftBody } = require('../apps/api/src/server');
  const document = {
    schemaVersion: 1, documentId: 'doc-1', type: 'page', title: 'My page',
    children: [{ id: 'heading-1', type: 'widget.heading', props: { text: 'Hello', level: 1 }, children: [] }]
  };
  assert.throws(() => validateSaveDraftBody({ document, id: 'not-a-uuid', reviewed: true }), { code: 'ERR_SYSTEMFABRIC_INVALID_ID' });
  assert.throws(() => validateSaveDraftBody({ document, locale: 'en\nmalicious', reviewed: true }), { code: 'ERR_SYSTEMFABRIC_INVALID_LOCALE' });
  assert.equal(validateSaveDraftBody({ document, locale: 'en-US', reviewed: true }).locale, 'en-US');
});

test('session cookie writes require CSRF validation, same-origin context, and HttpOnly session cookie', async () => {
  const fakeIdentity = {
    async login() { return { token: 's'.repeat(43), csrf: 'c'.repeat(43), expiresAt: new Date(Date.now() + 3600_000), user: { id: 'u1', email: 'admin@example.com', displayName: 'Admin', status: 'active' } }; },
    async authenticate(token) { return token === 's'.repeat(43) ? { sessionId: 'sid', user: { id: 'u1', email: 'admin@example.com', displayName: 'Admin', status: 'active' }, memberships: [{ siteId: '11111111-1111-4111-8111-111111111111', siteSlug: 'main', siteName: 'Main', role: 'site-owner', roles: ['site-owner'], capabilities: ['*'] }] } : null; },
    async validateCsrf(_token, csrf) { return csrf === 'c'.repeat(43); },
    async logout() {},
    async listSites() { return []; }
  };
  const server = createApiServer({ env: { NODE_ENV: 'test', AI_PROVIDER: 'mock', RATE_LIMIT_MAX_REQUESTS: '100' }, identityService: fakeIdentity, logger: { error() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'Password1234' }) });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /sf_session=.*HttpOnly/i);
    const cookieHeader = 'sf_session=' + 's'.repeat(43) + '; sf_csrf=' + 'c'.repeat(43);
    const missingOrigin = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: cookieHeader, 'x-csrf-token': 'c'.repeat(43) } });
    assert.equal(missingOrigin.status, 403);
    assert.equal((await missingOrigin.json()).code, 'ERR_SYSTEMFABRIC_CSRF');
    const rejected = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: cookieHeader, origin: base } });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, 'ERR_SYSTEMFABRIC_CSRF');
    const accepted = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: cookieHeader, origin: base, 'x-csrf-token': 'c'.repeat(43) } });
    assert.equal(accepted.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.systemfabric.close();
  }
});


test('Platform Hub and its static assets are served without exposing database-backed data', async () => {
  await withServer(async base => {
    const page = await fetch(`${base}/platform`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /SystemFabric Platform Hub/);
    assert.match(html, /platform\.js/);
    const script = await fetch(`${base}/assets/platform.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
  });
});

test('icon library API returns curated icons and math endpoint escapes fallback output', async () => {
  await withServer(async base => {
    const headers = { authorization: 'Bearer test-secret-token' };
    const iconsResponse = await fetch(`${base}/api/v1/icon-library`, { headers });
    assert.equal(iconsResponse.status, 200);
    const icons = await iconsResponse.json();
    assert.ok(icons.icons.length >= 10);
    const mathResponse = await fetch(`${base}/api/v1/math/render`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ formula: '<script>alert(1)</script>', displayMode: false })
    });
    assert.equal(mathResponse.status, 200);
    const math = await mathResponse.json();
    assert.match(math.html, /&lt;script&gt;/);
    assert.doesNotMatch(math.html, /<script>/i);
  });
});


test('public commerce catalog paths are reachable without API credentials and fail clearly without a database', async () => {
  await withServer(async base => {
    const siteId = '11111111-1111-4111-8111-111111111111';
    const products = await fetch(`${base}/api/v1/public/sites/${siteId}/products`);
    assert.equal(products.status, 503);
    assert.equal((await products.json()).code, 'ERR_SYSTEMFABRIC_DATABASE_DISABLED');
    const plans = await fetch(`${base}/api/v1/public/sites/${siteId}/membership-plans`);
    assert.equal(plans.status, 503);
    assert.equal((await plans.json()).code, 'ERR_SYSTEMFABRIC_DATABASE_DISABLED');
  });
});
