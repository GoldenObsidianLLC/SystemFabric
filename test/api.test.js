'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiServer, sameSecret } = require('../apps/api/src/server');

test('shared secret comparison is byte-safe, constant-time for equal lengths, and rejects mismatches', () => {
  assert.equal(sameSecret('test-secret', 'test-secret'), true);
  assert.equal(sameSecret('test-secret', 'wrong-secret'), false);
  assert.equal(sameSecret('short', 'longer-secret'), false);
  assert.equal(sameSecret('', 'non-empty'), false);
  assert.equal(sameSecret('expected', ''), false);
  assert.equal(sameSecret('high-entropy-token-01', 'high-entropy-token-01'), true);
  assert.equal(sameSecret('high-entropy-token-01', 'high-entropy-token-02'), false);
  const unicodeSecret = 'h' + String.fromCharCode(0x00e9) + 'llo';
  assert.equal(sameSecret(unicodeSecret, unicodeSecret), true);
  assert.equal(sameSecret('🔐token', '🔐token'), true);
});

async function withServer(fn, envExtra = {}, serverOptions = {}) {
  const server = createApiServer({
    env: { NODE_ENV: 'test', SYSTEMFABRIC_API_TOKEN: 'test-secret-token', AI_PROVIDER: 'mock', MAX_REQUEST_BYTES: '16384', RATE_LIMIT_MAX_REQUESTS: '100', ...envExtra },
    logger: { error() {} },
    ...serverOptions
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

test('client disconnect cancels the governed AI task and releases the request handler', async () => {
  let startedResolve;
  let cancelledResolve;
  let providerSignal = null;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const cancelled = new Promise(resolve => { cancelledResolve = resolve; });
  const siteId = '11111111-1111-4111-8111-111111111111';
  const taskId = '55555555-5555-4555-8555-555555555555';
  let taskRecord = null;
  let taskTerminalResolve;
  const taskTerminal = new Promise(resolve => { taskTerminalResolve = resolve; });
  const aiTaskStore = {
    async create(input) {
      taskRecord = { id: taskId, siteId: input.siteId, actorId: input.actorId, status: 'queued', requestId: input.requestId };
      return taskRecord;
    },
    async start(input) {
      Object.assign(taskRecord, { status: 'running', provider: input.provider, model: input.model });
      return taskRecord;
    },
    async finish(input) {
      Object.assign(taskRecord, { status: input.status, errorCode: input.errorCode || null });
      taskTerminalResolve();
      return taskRecord;
    }
  };
  const aiService = {
    providerInfo() {
      return { provider: 'mock', model: 'disconnect-test-model', mock: true, publishToolsEnabled: false };
    },
    async generatePageDraft({ signal }) {
      providerSignal = signal;
      startedResolve();
      return new Promise((resolve, reject) => {
        const abort = () => {
          cancelledResolve();
          reject(Object.assign(new Error('cancelled by client disconnect'), {
            code: 'ERR_SYSTEMFABRIC_AI_CANCELLED',
            statusCode: 499
          }));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
  };

  await withServer(async base => {
    const controller = new AbortController();
    const pending = fetch(`${base}/api/v1/ai/page-draft`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'A request that will be cancelled.' })
    });

    await started;
    assert.ok(providerSignal instanceof AbortSignal);
    controller.abort(new Error('test client disconnected'));

    await assert.rejects(pending);
    await cancelled;
    await taskTerminal;
    assert.equal(providerSignal.aborted, true);
    assert.equal(taskRecord.status, 'cancelled');
    assert.equal(taskRecord.errorCode, 'ERR_SYSTEMFABRIC_AI_CANCELLED');
  }, { SYSTEMFABRIC_DEFAULT_SITE_ID: siteId }, { aiService, aiTaskStore });
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
    const invalidBearerWithCookie = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: cookieHeader, authorization: 'Bearer invalid-token', 'x-csrf-token': 'c'.repeat(43) } });
    assert.equal(invalidBearerWithCookie.status, 403, 'an invalid bearer header must not bypass cookie CSRF validation');
    assert.equal((await invalidBearerWithCookie.json()).code, 'ERR_SYSTEMFABRIC_CSRF');
    const rejected = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: cookieHeader, origin: base } });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, 'ERR_SYSTEMFABRIC_CSRF');
    const accepted = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: cookieHeader, origin: base, 'x-csrf-token': 'c'.repeat(43) } });
    assert.equal(accepted.status, 200);
    const bearerAccepted = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${'s'.repeat(43)}` } });
    assert.equal(bearerAccepted.status, 200, 'valid explicit bearer credentials remain usable without cookie CSRF headers');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.systemfabric.close();
  }
});


test('secure-cookie configuration marks the session and CSRF cookies Secure', async () => {
  const fakeIdentity = {
    async login() {
      return {
        token: 's'.repeat(43), csrf: 'c'.repeat(43),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', email: 'admin@example.com', displayName: 'Admin', status: 'active' }
      };
    }
  };
  const server = createApiServer({
    env: { NODE_ENV: 'test', SESSION_COOKIE_SECURE: 'true', AI_PROVIDER: 'mock', RATE_LIMIT_MAX_REQUESTS: '100' },
    identityService: fakeIdentity,
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'not-used-by-fake-identity' })
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie') || '';
    const sessionCookie = setCookie.split(/,\s*(?=[A-Za-z0-9_-]+=)/).find(value => value.trim().startsWith('sf_session='));
    const csrfCookie = setCookie.split(/,\s*(?=[A-Za-z0-9_-]+=)/).find(value => value.trim().startsWith('sf_csrf='));
    assert.ok(sessionCookie);
    assert.ok(csrfCookie);
    assert.match(sessionCookie, /; HttpOnly/i);
    assert.match(sessionCookie, /; Secure/i);
    assert.match(csrfCookie, /; Secure/i);
    assert.doesNotMatch(csrfCookie, /; HttpOnly/i, 'CSRF token remains readable for the double-submit header');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.systemfabric.close();
  }
});

test('MFA challenge cookie is HttpOnly, Secure when configured, path-limited and short-lived', async () => {
  const fakeIdentity = {
    async login() {
      return {
        mfaRequired: true, challengeToken: 'm'.repeat(43),
        expiresAt: new Date(Date.now() + 300_000),
        user: { id: 'u2', email: 'mfa@example.com', displayName: 'MFA User', status: 'active' }
      };
    }
  };
  const server = createApiServer({
    env: { NODE_ENV: 'test', SESSION_COOKIE_SECURE: 'true', AI_PROVIDER: 'mock', RATE_LIMIT_MAX_REQUESTS: '100' },
    identityService: fakeIdentity,
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mfa@example.com', password: 'not-used-by-fake-identity' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mfaRequired, true);
    const challengeCookie = response.headers.get('set-cookie') || '';
    assert.match(challengeCookie, /sf_mfa_challenge=/);
    assert.match(challengeCookie, /; HttpOnly/i);
    assert.match(challengeCookie, /; Secure/i);
    assert.match(challengeCookie, /; SameSite=Strict/i);
    assert.match(challengeCookie, /; Path=\/api\/v1\/auth\/mfa/i);
    assert.match(challengeCookie, /; Max-Age=300/i);
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


test('governed AI generation returns a tenant-scoped task ID and status endpoint hides other sites', async () => {
  const siteA = '11111111-1111-4111-8111-111111111111';
  const siteB = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';
  const tasks = new Map();
  const aiTaskStore = {
    async create(input) {
      const task = {
        id: taskId,
        siteId: input.siteId,
        actorId: input.actorId,
        requestId: input.requestId,
        taskType: input.taskType,
        status: 'queued',
        provider: null,
        model: null,
        inputChars: input.inputChars,
        outputChars: 0,
        latencyMs: 0,
        errorCode: null,
        version: 1,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date().toISOString()
      };
      tasks.set(taskId, task);
      return task;
    },
    async start(input) {
      const task = tasks.get(input.taskId);
      task.status = 'running';
      task.provider = input.provider;
      task.model = input.model;
      task.startedAt = new Date().toISOString();
      task.version += 1;
      return task;
    },
    async finish(input) {
      const task = tasks.get(input.taskId);
      task.status = input.status;
      task.outputChars = input.outputChars || 0;
      task.latencyMs = input.latencyMs || 0;
      task.errorCode = input.errorCode || null;
      task.completedAt = new Date().toISOString();
      task.version += 1;
      return task;
    },
    async get(input) {
      const task = tasks.get(input.taskId);
      return task && task.siteId === input.siteId && task.actorId === input.actorId ? task : null;
    }
  };

  await withServer(async base => {
    const response = await fetch(base + '/api/v1/ai/page-draft', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: siteA, prompt: 'Create a task-tracked landing page.' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.taskId, taskId);
    assert.equal(result.status, 'draft-proposal');
    assert.equal(tasks.get(taskId).status, 'succeeded');
    assert.equal(tasks.get(taskId).taskType, 'page_draft');
    const aiStatusResponse = await fetch(base + '/api/v1/ai/status', {
      headers: { authorization: 'Bearer test-secret-token' }
    });
    const aiStatus = await aiStatusResponse.json();
    assert.equal(aiStatus.durableTaskStatus, true);
    assert.equal(aiStatus.capabilities.includes('task-status'), true);

    const statusResponse = await fetch(base + '/api/v1/ai/tasks/' + taskId + '?siteId=' + siteA, {
      headers: { authorization: 'Bearer test-secret-token' }
    });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.task.status, 'succeeded');
    assert.equal(status.task.provider, 'mock');
    assert.equal(Object.hasOwn(status.task, 'prompt'), false);

    const crossSiteResponse = await fetch(base + '/api/v1/ai/tasks/' + taskId + '?siteId=' + siteB, {
      headers: { authorization: 'Bearer test-secret-token' }
    });
    assert.equal(crossSiteResponse.status, 404);
    assert.equal((await crossSiteResponse.json()).code, 'ERR_SYSTEMFABRIC_AI_TASK_NOT_FOUND');
  }, {}, { aiTaskStore });
});

test('governed AI remains available when the task lifecycle migration has not been applied', async () => {
  const siteId = '11111111-1111-4111-8111-111111111111';
  const taskId = '33333333-3333-4333-8333-333333333333';
  let createCalls = 0;
  const aiTaskStore = {
    async isAvailable() { return false; },
    async create() { createCalls += 1; throw new Error('task table must not be accessed'); },
    async get() { throw new Error('task table must not be accessed'); }
  };

  await withServer(async base => {
    const response = await fetch(base + '/api/v1/ai/page-draft', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Generate a simple landing page.' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(Object.hasOwn(result, 'taskId'), false);
    assert.equal(createCalls, 0);

    const aiStatusResponse = await fetch(base + '/api/v1/ai/status', {
      headers: { authorization: 'Bearer test-secret-token' }
    });
    const aiStatus = await aiStatusResponse.json();
    assert.equal(aiStatus.durableTaskStatus, false);
    assert.equal(aiStatus.capabilities.includes('task-status'), false);

    const taskResponse = await fetch(base + '/api/v1/ai/tasks/' + taskId + '?siteId=' + siteId, {
      headers: { authorization: 'Bearer test-secret-token' }
    });
    assert.equal(taskResponse.status, 503);
    assert.equal((await taskResponse.json()).code, 'ERR_SYSTEMFABRIC_AI_TASKS_DISABLED');
  }, { SYSTEMFABRIC_DEFAULT_SITE_ID: siteId }, { aiTaskStore });
});

test('a task-status persistence failure does not discard a completed AI proposal', async () => {
  const siteId = '11111111-1111-4111-8111-111111111111';
  const taskId = '66666666-6666-4666-8666-666666666666';
  const terminalAttempts = [];
  const task = { id: taskId, siteId, status: 'queued' };
  const aiTaskStore = {
    async create() { return task; },
    async start() { task.status = 'running'; return task; },
    async finish(input) {
      terminalAttempts.push(input.status);
      throw Object.assign(new Error('simulated task metadata write failure'), { code: 'ERR_TEST_TASK_STORE_WRITE' });
    }
  };

  await withServer(async base => {
    const response = await fetch(base + '/api/v1/ai/page-draft', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ siteId, prompt: 'Create a simple, useful landing page.' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'draft-proposal');
    assert.equal(Object.hasOwn(result, 'taskId'), false);
    assert.deepEqual(terminalAttempts, ['succeeded']);
    assert.equal(task.status, 'running', 'the API must not falsely overwrite an unknown persistence outcome as failed');
  }, {}, { aiTaskStore });
});

test('AI task state records provider failures without retaining prompt or response content', async () => {
  const siteId = '11111111-1111-4111-8111-111111111111';
  const taskId = '44444444-4444-4444-8444-444444444444';
  let task = null;
  const aiTaskStore = {
    async create(input) {
      task = { id: taskId, siteId: input.siteId, actorId: input.actorId, status: 'queued', taskType: input.taskType };
      return task;
    },
    async start(input) {
      task.status = 'running';
      task.provider = input.provider;
      task.model = input.model;
      return task;
    },
    async finish(input) {
      Object.assign(task, { status: input.status, errorCode: input.errorCode || null });
      return task;
    }
  };
  const aiService = {
    providerInfo() {
      return { provider: 'mock', model: 'failure-test-model', mock: true, publishToolsEnabled: false };
    },
    async generatePageDraft() {
      throw Object.assign(new Error('simulated provider outage'), {
        code: 'ERR_SYSTEMFABRIC_TEST_PROVIDER_UNAVAILABLE',
        statusCode: 503
      });
    }
  };

  await withServer(async base => {
    const response = await fetch(base + '/api/v1/ai/page-draft', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ siteId, prompt: 'This prompt must not be persisted.' })
    });
    assert.equal(response.status, 503);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorCode, 'ERR_SYSTEMFABRIC_TEST_PROVIDER_UNAVAILABLE');
    assert.equal(Object.hasOwn(task, 'prompt'), false);
    assert.equal(Object.hasOwn(task, 'response'), false);
  }, {}, { aiTaskStore, aiService });
});
