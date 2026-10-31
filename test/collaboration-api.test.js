

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiServer } = require('../apps/api/src/server');

test('collaboration REST endpoints require an editable draft and return committed operation and sync state', async t => {
  const contentId = '22222222-2222-4222-8222-222222222222';
  const operation = {
    schemaVersion: 1,
    opId: '33333333-3333-4333-8333-333333333333',
    clientId: 'api-test',
    baseSequence: 0,
    type: 'document.set_title',
    payload: { title: 'REST title' }
  };
  const calls = [];
  const publishedOperations = [];
  const content = {
    id: contentId,
    site_id: '11111111-1111-4111-8111-111111111111',
    content_type: 'page',
    status: 'draft',
    created_by: null,
    body: { schemaVersion: 1, type: 'page', title: 'Before', children: [] }
  };
  const store = {
    async getById({ siteId, id }) {
      return siteId === content.site_id && id === content.id ? content : null;
    },
    async applyCollaborationOperation(input) {
      calls.push(input);
      return { sequence: 1, version: 2, lockVersion: 2, operation, duplicate: false };
    },
    async getCollaborationSync(input) {
      calls.push(input);
      return { reloadRequired: false, sequence: 1, oldestReplaySequence: 0, operations: [{ sequence: 1, operation }] };
    }
  };
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_API_TOKEN: 'collab-api-token',
      SYSTEMFABRIC_DEFAULT_SITE_ID: content.site_id,
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      AI_PROVIDER: 'mock',
      MAX_REQUEST_BYTES: '16384',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    contentStore: store,
    publishDocumentOperation: async input => {
      publishedOperations.push(input);
      return { relayPublished: false, degraded: true };
    },
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { authorization: 'Bearer collab-api-token', 'content-type': 'application/json' };
  try {
    const write = await fetch(base + '/api/v1/pages/' + contentId + '/collaboration/operations', {
      method: 'POST', headers, body: JSON.stringify({ operation })
    });
    assert.equal(write.status, 200);
    const ack = await write.json();
    assert.equal(ack.sequence, 1);
    assert.equal(ack.fanoutDegraded, true, 'a committed operation remains acknowledged when Redis fan-out is degraded');
    assert.equal(calls[0].actorId, null, 'actor identity must come from the authenticated session, not request JSON');
    assert.equal(publishedOperations.length, 1);
    assert.deepEqual(publishedOperations[0], {
      siteId: content.site_id,
      contentId,
      sequence: 1,
      originConnectionId: null,
      operation
    });

    const sync = await fetch(base + '/api/v1/pages/' + contentId + '/collaboration/sync?afterSequence=0', {
      headers: { authorization: 'Bearer collab-api-token' }
    });
    assert.equal(sync.status, 200);
    const state = await sync.json();
    assert.equal(state.sequence, 1);
    assert.equal(state.operations[0].sequence, 1);
    assert.equal(calls[1].afterSequence, 0);
  } finally {
    await server.systemfabric.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('collaboration REST routes enforce site, draft, cursor, and operation-size boundaries', async () => {
  const siteId = '11111111-1111-4111-8111-111111111111';
  const contentId = '22222222-2222-4222-8222-222222222222';
  let status = 'draft';
  const store = {
    async getById({ siteId: requestedSite, id }) {
      return requestedSite === siteId && id === contentId
        ? { id, site_id: siteId, content_type: 'page', status, created_by: null }
        : null;
    },
    async applyCollaborationOperation() {
      return { sequence: 1, version: 2, lockVersion: 2, duplicate: false };
    },
    async getCollaborationSync() {
      return { reloadRequired: false, sequence: 0, oldestReplaySequence: 0, operations: [] };
    }
  };
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_API_TOKEN: 'collab-boundary-token',
      SYSTEMFABRIC_DEFAULT_SITE_ID: siteId,
      AI_PROVIDER: 'mock',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    contentStore: store,
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const auth = { authorization: 'Bearer collab-boundary-token' };
  try {
    const crossSite = await fetch(base + '/api/v1/pages/' + contentId + '/collaboration/sync?afterSequence=0', {
      headers: { ...auth, 'x-systemfabric-site-id': '99999999-9999-4999-8999-999999999999' }
    });
    assert.equal(crossSite.status, 404);

    const invalidCursor = await fetch(base + '/api/v1/pages/' + contentId + '/collaboration/sync?afterSequence=-1', { headers: auth });
    assert.equal(invalidCursor.status, 400);

    status = 'published';
    const notDraft = await fetch(base + '/api/v1/pages/' + contentId + '/collaboration/sync?afterSequence=0', { headers: auth });
    assert.equal(notDraft.status, 409);
    assert.equal((await notDraft.json()).code, 'ERR_SYSTEMFABRIC_COLLABORATION_NOT_DRAFT');

    status = 'draft';
    const tooLarge = await fetch(base + '/api/v1/pages/' + contentId + '/collaboration/operations', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: { padding: 'x'.repeat(13_000) } })
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await server.systemfabric.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('collaboration REST writes enforce content:edit or own-content ownership from the authenticated session', async () => {
  const siteId = '11111111-1111-4111-8111-111111111111';
  const contentId = '22222222-2222-4222-8222-222222222222';
  const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const writes = [];
  const identityService = {
    async authenticate(token) {
      const userId = token === 'owner-session' ? ownerId : token === 'other-session' ? otherId : null;
      if (!userId) return null;
      return {
        sessionId: 'session-' + userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        user: { id: userId, email: userId + '@example.test', status: 'active' },
        memberships: [{ siteId, capabilities: ['content:read', 'content:edit:own'] }]
      };
    },
    async isSessionActive({ userId, sessionId }) {
      return sessionId === 'session-' + userId;
    },
    async authorizeSite(_userId, _siteId, capability) {
      return capability === 'content:read' || capability === 'content:edit:own';
    }
  };
  const store = {
    async getById({ siteId: requestedSite, id }) {
      return requestedSite === siteId && id === contentId
        ? { id, site_id: siteId, content_type: 'page', status: 'draft', created_by: ownerId }
        : null;
    },
    async applyCollaborationOperation(input) {
      writes.push(input);
      return { sequence: 1, version: 2, lockVersion: 2, duplicate: false };
    },
    async getCollaborationSync() {
      return { reloadRequired: false, sequence: 0, oldestReplaySequence: 0, operations: [] };
    }
  };
  const server = createApiServer({
    env: { NODE_ENV: 'test', AI_PROVIDER: 'mock', RATE_LIMIT_MAX_REQUESTS: '100' },
    identityService,
    contentStore: store,
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const operation = {
    schemaVersion: 1,
    opId: '33333333-3333-4333-8333-333333333333',
    clientId: 'rest-owner',
    baseSequence: 0,
    type: 'document.set_title',
    payload: { title: 'Owner edit' }
  };
  try {
    const ownerWrite = await fetch(base + '/api/v1/pages/' + contentId + '/collaboration/operations', {
      method: 'POST',
      headers: { authorization: 'Bearer owner-session', 'content-type': 'application/json' },
      body: JSON.stringify({ operation })
    });
    assert.equal(ownerWrite.status, 200);
    assert.equal(writes[0].actorId, ownerId);

    const otherWrite = await fetch(base + '/api/v1/pages/' + contentId + '/collaboration/operations', {
      method: 'POST',
      headers: { authorization: 'Bearer other-session', 'content-type': 'application/json' },
      body: JSON.stringify({ operation: { ...operation, opId: '44444444-4444-4444-8444-444444444444' } })
    });
    assert.equal(otherWrite.status, 403);
    assert.equal((await otherWrite.json()).code, 'ERR_SYSTEMFABRIC_FORBIDDEN');
    assert.equal(writes.length, 1, 'unauthorized edits must never reach the store');
  } finally {
    await server.systemfabric.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('Redis-backed realtime rejects a bridge that lacks document publication', () => {
  const presence = { heartbeat() {}, leave() {} };
  const limiter = { acquire() { return Promise.resolve({ release() {} }); } };
  const bridge = { async attach() {}, async close() {} };

  assert.throws(() => createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      SYSTEMFABRIC_PRESENCE_STORE: 'redis',
      AI_PROVIDER: 'mock'
    },
    presenceService: presence,
    realtimeBridge: bridge,
    realtimeConnectionLimiter: limiter,
    publishDocumentOperation: async () => ({ degraded: false }),
    logger: { error() {} }
  }), /publishDocumentOperation/);
});
