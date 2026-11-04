'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiServer } = require('../apps/api/src/server');

const siteId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const pageId = '33333333-3333-4333-8333-333333333333';

async function withServer(fn, { identityService, contentStore, aiService, pool, aiTaskStore } = {}) {
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      VIRGOSCORPIO_HUB_API_TOKEN: 'local-test-token',
      AI_PROVIDER: 'mock',
      MAX_REQUEST_BYTES: '16384',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    logger: { error() {} },
    identityService,
    contentStore,
    aiService,
    pool,
    aiTaskStore
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.virgoScorpioHub.close();
  }
}

function createIdentityService(capabilities = []) {
  const grants = new Set(capabilities);
  return {
    async authenticate(token) {
      if (token !== 'member-session-token') return null;
      return {
        sessionId: '44444444-4444-4444-8444-444444444444',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        user: { id: userId, email: 'member@example.test', displayName: 'Member', status: 'active' },
        memberships: [{ siteId, capabilities: [...grants] }]
      };
    },
    async audit() {},
    async authorizeSite(actorId, requestedSiteId, capability) {
      return actorId === userId && requestedSiteId === siteId && grants.has(capability);
    }
  };
}

function createPolicyPool(maxDataClassification = 'confidential') {
  const policy = {
    site_id: siteId,
    enabled: true,
    allow_external_content: false,
    allowed_providers: ['mock'],
    max_data_classification: maxDataClassification,
    daily_request_limit: 100,
    daily_input_chars_limit: 100_000,
    require_human_review: true
  };
  return {
    async query(sql) {
      if (sql.startsWith('INSERT INTO site_ai_policies')) return { rows: [] };
      if (sql.startsWith('SELECT site_id,enabled,allow_external_content')) return { rows: [policy] };
      if (sql.startsWith('INSERT INTO ai_usage_daily')) return { rows: [{ requests: 1, input_chars: 100 }] };
      if (sql.startsWith('INSERT INTO ai_run_audit')) return { rows: [] };
      throw new Error('Unexpected test database query: ' + sql);
    }
  };
}

function createAIService(calls) {
  return {
    providerInfo() {
      return { provider: 'mock', model: 'context-test-model', mock: true, publishToolsEnabled: false };
    },
    async generatePageDraft(input) {
      calls.push(input);
      return { status: 'draft-proposal', saved: false, published: false, document: { type: 'page' } };
    }
  };
}

function pageStore({ ownerRow = null, readableRow = null, calls = [] } = {}) {
  return {
    async getById(input) {
      calls.push({ method: 'getById', input });
      return readableRow;
    },
    async getByIdForOwner(input) {
      calls.push({ method: 'getByIdForOwner', input });
      return ownerRow;
    }
  };
}

async function postPageDraft(base, body) {
  return fetch(base + '/api/v1/ai/page-draft', {
    method: 'POST',
    headers: { authorization: 'Bearer member-session-token', 'content-type': 'application/json' },
    body: JSON.stringify({ siteId, prompt: 'Create a draft using this context.', ...body })
  });
}

test('page-draft assembles selected pages through owner-scoped access and classifies them as confidential', async () => {
  const storeCalls = [];
  const aiCalls = [];
  const source = {
    id: pageId,
    site_id: siteId,
    created_by: userId,
    content_type: 'page',
    title: 'Private launch plan',
    body: {
      children: [
        { type: 'widget.heading', props: { text: 'Launch priorities' }, children: [] },
        { type: 'widget.text', props: { text: 'Do not publish the internal schedule.' }, children: [] }
      ]
    }
  };
  const store = pageStore({ ownerRow: source, calls: storeCalls });
  const ai = createAIService(aiCalls);
  const taskStore = { async isAvailable() { return false; } };

  await withServer(async base => {
    const response = await postPageDraft(base, {
      contextContentIds: [pageId],
      siteContext: 'Keep the tone concise.',
      dataClassification: 'public'
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'draft-proposal');
    assert.equal(aiCalls.length, 1);
    assert.match(aiCalls[0].siteContext, /Private launch plan/);
    assert.match(aiCalls[0].siteContext, /Launch priorities/);
    assert.match(aiCalls[0].siteContext, /Do not publish the internal schedule/);
    assert.match(aiCalls[0].siteContext, /Keep the tone concise/);
    assert.deepEqual(storeCalls, [{
      method: 'getByIdForOwner',
      input: { siteId, id: pageId, actorId: userId }
    }]);
  }, {
    identityService: createIdentityService(['ai:use', 'content:read:own']),
    contentStore: store,
    aiService: ai,
    pool: createPolicyPool('confidential'),
    aiTaskStore: taskStore
  });
});

test('page-draft denies saved-page context without content read or read-own capability before storage or model access', async () => {
  const storeCalls = [];
  const aiCalls = [];
  await withServer(async base => {
    const response = await postPageDraft(base, { contextContentIds: [pageId] });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN');
    assert.equal(storeCalls.length, 0);
    assert.equal(aiCalls.length, 0);
  }, {
    identityService: createIdentityService(['ai:use']),
    contentStore: pageStore({ calls: storeCalls }),
    aiService: createAIService(aiCalls),
    pool: createPolicyPool()
  });
});

test('page-draft hides missing or non-owned sources and does not invoke the model', async () => {
  const storeCalls = [];
  const aiCalls = [];
  await withServer(async base => {
    const response = await postPageDraft(base, { contextContentIds: [pageId] });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_SOURCE_NOT_FOUND');
    assert.equal(storeCalls.length, 1);
    assert.equal(storeCalls[0].method, 'getByIdForOwner');
    assert.equal(aiCalls.length, 0);
  }, {
    identityService: createIdentityService(['ai:use', 'content:read:own']),
    contentStore: pageStore({ ownerRow: null, calls: storeCalls }),
    aiService: createAIService(aiCalls),
    pool: createPolicyPool()
  });
});

test('page-draft requires the site AI policy to permit confidential selected-page context', async () => {
  const aiCalls = [];
  await withServer(async base => {
    const response = await postPageDraft(base, {
      contextContentIds: [pageId],
      dataClassification: 'public'
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ERR_VIRGOSCORPIO_HUB_AI_CLASSIFICATION_BLOCKED');
    assert.equal(aiCalls.length, 0);
  }, {
    identityService: createIdentityService(['ai:use', 'content:read:own']),
    contentStore: pageStore({
      ownerRow: {
        id: pageId,
        site_id: siteId,
        created_by: userId,
        content_type: 'page',
        title: 'Private launch plan',
        body: { children: [{ props: { text: 'Secret' }, children: [] }] }
      }
    }),
    aiService: createAIService(aiCalls),
    pool: createPolicyPool('public'),
    aiTaskStore: { async isAvailable() { return false; } }
  });
});

test('page-draft uses site-wide content:read without requiring ownership lookup', async () => {
  const storeCalls = [];
  const aiCalls = [];
  await withServer(async base => {
    const response = await postPageDraft(base, { contextContentIds: [pageId] });
    assert.equal(response.status, 200);
    assert.equal(storeCalls.length, 1);
    assert.equal(storeCalls[0].method, 'getById');
    assert.equal(aiCalls.length, 1);
  }, {
    identityService: createIdentityService(['ai:use', 'content:read']),
    contentStore: pageStore({
      readableRow: {
        id: pageId,
        site_id: siteId,
        content_type: 'page',
        title: 'Shared page',
        body: { children: [{ props: { text: 'Approved shared text' }, children: [] }] }
      },
      calls: storeCalls
    }),
    aiService: createAIService(aiCalls),
    pool: createPolicyPool('confidential'),
    aiTaskStore: { async isAvailable() { return false; } }
  });
});


test('page-draft rejects a content-store result outside the selected site', async () => {
  const aiCalls = [];
  const otherSiteId = '99999999-9999-4999-8999-999999999999';
  await withServer(async base => {
    const response = await postPageDraft(base, { contextContentIds: [pageId] });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_SOURCE_NOT_FOUND');
    assert.equal(aiCalls.length, 0);
  }, {
    identityService: createIdentityService(['ai:use', 'content:read']),
    contentStore: pageStore({
      readableRow: {
        id: pageId,
        site_id: otherSiteId,
        content_type: 'page',
        title: 'Cross-site page',
        body: { children: [{ props: { text: 'must never be sent' }, children: [] }] }
      }
    }),
    aiService: createAIService(aiCalls),
    pool: createPolicyPool('confidential'),
    aiTaskStore: { async isAvailable() { return false; } }
  });
});
