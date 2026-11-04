'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleCommunityWorkflowRoute, cleanRequiredText, constants } = require('../packages/community/src/workflows');

const siteId = 'cb289662-2ea5-4b43-92a9-cd2dce8f9310';
const actorId = '82c36ec0-4fd4-4c85-bb7d-dde7e6a61098';
const recipientId = '385ef0ad-d7d6-4ec1-a1f4-1f9230551ea7';

function createContext({ method = 'GET', path = `/api/v1/sites/${siteId}/community/conversations`, body = {}, query = '', pool } = {}) {
  const ctx = {
    req: { method },
    res: {},
    url: new URL(`http://virgoscorpio-hub.local${path}${query}`),
    actor: { user: { id: actorId, email: 'actor@example.test' } },
    localPool: pool || { async query() { return { rows: [] }; }, async connect() { throw new Error('connect should not be called'); } },
    maxBody: 64_000,
    requestId: 'test-request',
    async siteIdFor() { return siteId; },
    async requireCapability() { return true; },
    async readJson() { return body; },
    sendJson(res, status, payload) { res.statusCode = status; res.payload = payload; return true; },
    fail(statusCode, code, message, details) { return Object.assign(new Error(message), { statusCode, code, details }); }
  };
  return ctx;
}

test('community workflow helpers sanitize control characters and cap input length', () => {
  assert.equal(cleanRequiredText('  hello\r\nworld\u0000  ', 100), 'hello\nworld');
  assert.equal(cleanRequiredText('x'.repeat(20), 5), 'xxxxx');
  assert.equal(constants.MAX_MESSAGE_LENGTH, 10_000);
  assert.equal(constants.MESSAGES_PER_MINUTE, 30);
});

test('unrelated API paths are not consumed by community workflow routing', async () => {
  const ctx = createContext({ path: '/api/v1/sites/' + siteId + '/community/feed' });
  assert.equal(await handleCommunityWorkflowRoute(ctx), false);
});

test('direct conversation creation rejects malformed or self-recipient before database access', async () => {
  for (const recipient of ['', actorId, 'not-a-uuid']) {
    const ctx = createContext({ method: 'POST', body: { recipientId: recipient }, pool: {
      async query() { throw new Error('query should not be called'); },
      async connect() { throw new Error('connect should not be called'); }
    } });
    await assert.rejects(handleCommunityWorkflowRoute(ctx), error => error.code === 'ERR_VIRGOSCORPIO_HUB_CONVERSATION_RECIPIENT' && error.statusCode === 400);
  }
});

test('message creation rejects empty content before opening a transaction', async () => {
  const conversationId = 'e8e1c8c8-3523-4acd-a3f6-c4dfd3cdbb9b';
  const ctx = createContext({ method: 'POST', path: `/api/v1/sites/${siteId}/community/conversations/${conversationId}/messages`, body: { body: ' \n ' }, pool: {
    async query() { throw new Error('query should not be called for an invalid message'); },
    async connect() { throw new Error('connect should not be called for an invalid message'); }
  } });
  await assert.rejects(handleCommunityWorkflowRoute(ctx), error => error.code === 'ERR_VIRGOSCORPIO_HUB_MESSAGE_INVALID' && error.statusCode === 400);
});

test('report submission rejects unsupported target and category values', async () => {
  const ctx = createContext({ method: 'POST', path: `/api/v1/sites/${siteId}/community/reports`, body: { targetType: 'table', targetId: recipientId, category: 'spam' }, pool: {
    async query() { throw new Error('query should not be called for invalid report'); },
    async connect() { throw new Error('connect should not be called for invalid report'); }
  } });
  await assert.rejects(handleCommunityWorkflowRoute(ctx), error => error.code === 'ERR_VIRGOSCORPIO_HUB_REPORT_TARGET' && error.statusCode === 400);

  const ctx2 = createContext({ method: 'POST', path: `/api/v1/sites/${siteId}/community/reports`, body: { targetType: 'user', targetId: recipientId, category: 'wrong' }, pool: {
    async query() { throw new Error('query should not be called for invalid report'); },
    async connect() { throw new Error('connect should not be called for invalid report'); }
  } });
  await assert.rejects(handleCommunityWorkflowRoute(ctx2), error => error.code === 'ERR_VIRGOSCORPIO_HUB_REPORT_CATEGORY' && error.statusCode === 400);
});

test('notification read-all endpoint is recognized and scopes updates by user and site', async () => {
  let statement; let values;
  const ctx = createContext({ method: 'POST', path: `/api/v1/sites/${siteId}/community/notifications/read-all`, pool: {
    async query(sql, args) { statement = sql; values = args; return { rows: [{ id: 'n1' }, { id: 'n2' }] }; },
    async connect() { throw new Error('connect should not be called'); }
  } });
  assert.equal(await handleCommunityWorkflowRoute(ctx), true);
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.payload.markedRead, 2);
  assert.match(statement, /WHERE site_id=\$1 AND user_id=\$2 AND read_at IS NULL/);
  assert.deepEqual(values, [siteId, actorId]);
});

function transactionalDirectConversationPool({ blocked = false } = {}) {
  const state = { statements: [], commits: 0, rollbacks: 0, releases: 0 };
  const conversation = {
    id: 'd47bf4ed-2029-401c-8f31-4e0ec17199ef',
    site_id: siteId,
    conversation_type: 'direct',
    group_id: null
  };
  const client = {
    async query(sql) {
      state.statements.push(sql);
      if (sql === 'BEGIN') return { rows: [] };
      if (sql === 'COMMIT') { state.commits += 1; return { rows: [] }; }
      if (sql === 'ROLLBACK') { state.rollbacks += 1; return { rows: [] }; }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/SELECT 1 FROM social_blocks/.test(sql)) return { rows: blocked ? [{ present: 1 }] : [] };
      if (/SELECT c\.id FROM social_conversations/.test(sql)) return { rows: [] };
      if (/INSERT INTO social_conversations/.test(sql)) return { rows: [{ id: conversation.id }] };
      if (/SELECT c\.id,c\.site_id/.test(sql)) return { rows: [conversation] };
      if (/INSERT INTO social_conversation_members|INSERT INTO social_notifications/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release() { state.releases += 1; }
  };
  return {
    state,
    async query(sql) {
      assert.match(sql, /SELECT u\.id FROM users/);
      return { rows: [{ id: recipientId }] };
    },
    async connect() { return client; }
  };
}

test('direct conversation creation commits before returning and releases its transaction client', async () => {
  const pool = transactionalDirectConversationPool();
  const ctx = createContext({ method: 'POST', body: { recipientId }, pool });

  assert.equal(await handleCommunityWorkflowRoute(ctx), true);
  assert.equal(ctx.res.statusCode, 201);
  assert.equal(ctx.res.payload.created, true);
  assert.equal(ctx.res.payload.conversation.id, 'd47bf4ed-2029-401c-8f31-4e0ec17199ef');
  assert.equal(pool.state.commits, 1);
  assert.equal(pool.state.rollbacks, 0);
  assert.equal(pool.state.releases, 1);
  assert.equal(pool.state.statements[0], 'BEGIN');
  assert.equal(pool.state.statements.at(-1), 'COMMIT');
});

test('direct conversation policy denial rolls back and releases its transaction client', async () => {
  const pool = transactionalDirectConversationPool({ blocked: true });
  const ctx = createContext({ method: 'POST', body: { recipientId }, pool });

  await assert.rejects(
    handleCommunityWorkflowRoute(ctx),
    error => error.code === 'ERR_VIRGOSCORPIO_HUB_COMMUNITY_BLOCKED' && error.statusCode === 403
  );
  assert.equal(pool.state.commits, 0);
  assert.equal(pool.state.rollbacks, 1);
  assert.equal(pool.state.releases, 1);
});
