'use strict';

const { test, expect } = require('@playwright/test');
const { createApiServer } = require('../../apps/api/src/server');
const {
  transformCollaborationOperation,
  applyCollaborationOperation,
  validateCollaborationOperation
} = require('../../packages/collaboration/src');
const {
  connectCollaborationClient,
  sendCollaborationCommand,
  waitForCollaborationMessage,
  readCollaborativeDocument,
  closeCollaborationClient
} = require('../fixtures/collaboration-client');

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const CONTENT_ID = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_A = 'browser-session-a';
const TOKEN_B = 'browser-session-b';

function initialPageDocument() {
  return {
    schemaVersion: 1,
    documentId: 'f1-9-browser-proof',
    type: 'page',
    title: 'Collaborative draft',
    children: [{
      id: 'section-1',
      type: 'section',
      props: {},
      children: [{
        id: 'heading-1',
        type: 'widget.heading',
        props: { text: 'Initial heading', level: 1 },
        children: []
      }]
    }]
  };
}

function createMemoryCollaborationStore() {
  let document = initialPageDocument();
  let sequence = 0;
  let oldestReplaySequence = 0;
  const operations = [];
  const idempotency = new Map();

  const content = () => ({
    id: CONTENT_ID,
    site_id: SITE_ID,
    content_type: 'page',
    status: 'draft',
    created_by: USER_A,
    version: sequence + 1,
    lock_version: sequence + 1,
    title: document.title,
    body: structuredClone(document),
    published_snapshot: null
  });

  return {
    async getById({ siteId, id }) {
      if (siteId !== SITE_ID || id !== CONTENT_ID) return null;
      return content();
    },

    async applyCollaborationOperation({ siteId, contentId, actorId, operation }) {
      if (siteId !== SITE_ID || contentId !== CONTENT_ID) {
        const error = new Error('Content not found.');
        error.statusCode = 404;
        error.code = 'ERR_SYSTEMFABRIC_CONTENT_NOT_FOUND';
        throw error;
      }
      const validation = validateCollaborationOperation(operation);
      if (!validation.valid) {
        const error = new Error(validation.errors.join('; '));
        error.statusCode = 400;
        error.code = 'ERR_SYSTEMFABRIC_INVALID_COLLABORATION_OPERATION';
        throw error;
      }

      const key = operation.opId.toLowerCase();
      const existing = idempotency.get(key);
      if (existing) {
        const samePayload = JSON.stringify(existing.operation) === JSON.stringify(operation);
        if (existing.actorId !== actorId || !samePayload) {
          const error = new Error('The collaboration opId was already used.');
          error.statusCode = 409;
          error.code = 'ERR_SYSTEMFABRIC_COLLABORATION_OP_ID_REUSE';
          throw error;
        }
        return { ...existing.result, duplicate: true };
      }
      if (operation.baseSequence > sequence) {
        const error = new Error('The base sequence is ahead of the server.');
        error.statusCode = 409;
        error.code = 'ERR_SYSTEMFABRIC_COLLABORATION_FUTURE_SEQUENCE';
        throw error;
      }
      if (operation.baseSequence < oldestReplaySequence) {
        return {
          reloadRequired: true,
          sequence,
          oldestReplaySequence,
          document: structuredClone(document),
          title: document.title,
          version: sequence + 1,
          lockVersion: sequence + 1
        };
      }

      const history = operations.filter(item => item.sequence > operation.baseSequence);
      const transformed = transformCollaborationOperation(operation, history);
      const applied = applyCollaborationOperation(document, transformed);
      document = applied.document;
      sequence += 1;
      const result = {
        sequence,
        oldestReplaySequence,
        version: sequence + 1,
        lockVersion: sequence + 1,
        title: document.title,
        operation: transformed
      };
      const accepted = {
        sequence,
        operation: structuredClone(operation),
        appliedOperation: structuredClone(transformed)
      };
      operations.push(accepted);
      idempotency.set(key, { actorId, operation: structuredClone(operation), result: structuredClone(result) });
      return { ...result, duplicate: false };
    },

    async getCollaborationSync({ siteId, contentId, afterSequence }) {
      if (siteId !== SITE_ID || contentId !== CONTENT_ID) {
        const error = new Error('Content not found.');
        error.statusCode = 404;
        error.code = 'ERR_SYSTEMFABRIC_CONTENT_NOT_FOUND';
        throw error;
      }
      if (afterSequence > sequence) {
        const error = new Error('The requested sequence is ahead of the server.');
        error.statusCode = 409;
        error.code = 'ERR_SYSTEMFABRIC_COLLABORATION_FUTURE_SEQUENCE';
        throw error;
      }
      if (afterSequence < oldestReplaySequence) {
        return {
          reloadRequired: true,
          sequence,
          oldestReplaySequence,
          document: structuredClone(document),
          title: document.title,
          version: sequence + 1,
          lockVersion: sequence + 1
        };
      }
      return {
        reloadRequired: false,
        sequence,
        oldestReplaySequence,
        operations: operations
          .filter(item => item.sequence > afterSequence)
          .map(item => structuredClone(item))
      };
    },

    expireReplayHistory() {
      oldestReplaySequence = sequence;
      operations.length = 0;
    },

    snapshot() {
      return structuredClone(document);
    }
  };
}

function createFakeIdentityService() {
  const sessions = new Map([
    [TOKEN_A, { userId: USER_A, sessionId: 'browser-session-a-id' }],
    [TOKEN_B, { userId: USER_B, sessionId: 'browser-session-b-id' }]
  ]);
  const activeSessions = new Set(['browser-session-a-id', 'browser-session-b-id']);

  return {
    async authenticate(token) {
      const session = sessions.get(token);
      if (!session) return null;
      return {
        sessionId: session.sessionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        user: {
          id: session.userId,
          email: session.userId + '@example.test',
          displayName: 'Browser editor',
          status: 'active'
        },
        memberships: [{
          siteId: SITE_ID,
          capabilities: ['content:read', 'content:edit']
        }]
      };
    },

    async isSessionActive({ sessionId }) {
      return activeSessions.has(sessionId);
    },

    async authorizeSite(userId, siteId, capability) {
      return [USER_A, USER_B].includes(userId) &&
        siteId === SITE_ID &&
        ['content:read', 'content:edit'].includes(capability);
    }
  };
}

test('two real browser sessions converge, retry a lost acknowledgement, reconnect, and reload expired history', async ({ browser }) => {
  const store = createMemoryCollaborationStore();
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      SYSTEMFABRIC_DEFAULT_SITE_ID: SITE_ID,
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      AI_PROVIDER: 'mock',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    identityService: createFakeIdentityService(),
    contentStore: store,
    logger: { error() {} }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const initialDocument = initialPageDocument();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  let pageA;
  let pageB;
  let pageAReconnected;
  let pageBReloaded;

  try {
    await contextA.addCookies([{
      name: 'sf_session',
      value: TOKEN_A,
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax'
    }]);
    await contextB.addCookies([{
      name: 'sf_session',
      value: TOKEN_B,
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax'
    }]);
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();

    await Promise.all([
      connectCollaborationClient(pageA, {
        baseUrl, siteId: SITE_ID, contentId: CONTENT_ID,
        clientId: 'browser-a', initialDocument, afterSequence: 0
      }),
      connectCollaborationClient(pageB, {
        baseUrl, siteId: SITE_ID, contentId: CONTENT_ID,
        clientId: 'browser-b', initialDocument, afterSequence: 0
      })
    ]);

    const operationA = {
      schemaVersion: 1,
      opId: '33333333-3333-4333-8333-333333333333',
      clientId: 'browser-a',
      baseSequence: 0,
      type: 'node.set_prop',
      payload: { nodeId: 'heading-1', key: 'level', value: 2 }
    };
    const operationB = {
      schemaVersion: 1,
      opId: '44444444-4444-4444-8444-444444444444',
      clientId: 'browser-b',
      baseSequence: 0,
      type: 'node.set_prop',
      payload: { nodeId: 'heading-1', key: 'text', value: 'Shared across browsers' }
    };

    // Leave client A's acknowledgement unread to simulate a lost acknowledgement.
    await sendCollaborationCommand(pageA, {
      type: 'document.operation', contentId: CONTENT_ID, operation: operationA
    });
    const firstCommitSeenByB = await waitForCollaborationMessage(pageB, 'document.operation');
    expect(firstCommitSeenByB.sequence).toBe(1);
    await closeCollaborationClient(pageA);

    // The same authenticated editor reconnects from sequence zero and receives
    // the accepted operation from durable sync before retrying its original opId.
    pageAReconnected = await contextA.newPage();
    const reconnectJoin = await connectCollaborationClient(pageAReconnected, {
      baseUrl, siteId: SITE_ID, contentId: CONTENT_ID,
      clientId: 'browser-a', initialDocument, afterSequence: 0
    });
    expect(reconnectJoin.sequence).toBe(1);
    const replay = await waitForCollaborationMessage(pageAReconnected, 'document.sync.operation');
    expect(replay.sequence).toBe(1);

    await sendCollaborationCommand(pageAReconnected, {
      type: 'document.operation', contentId: CONTENT_ID, operation: operationA
    });
    const duplicateAck = await waitForCollaborationMessage(pageAReconnected, 'document.operation.ack');
    expect(duplicateAck.duplicate).toBe(true);
    expect(duplicateAck.sequence).toBe(1);

    // Both edits were authored against base sequence zero and touch distinct
    // properties, so the later operation merges instead of overwriting level.
    await sendCollaborationCommand(pageB, {
      type: 'document.operation', contentId: CONTENT_ID, operation: operationB
    });
    const secondAck = await waitForCollaborationMessage(pageB, 'document.operation.ack');
    expect(secondAck.sequence).toBe(2);
    expect(secondAck.duplicate).toBe(false);
    const secondCommitSeenByA = await waitForCollaborationMessage(pageAReconnected, 'document.operation');
    expect(secondCommitSeenByA.sequence).toBe(2);

    const browserADocument = await readCollaborativeDocument(pageAReconnected);
    const browserBDocument = await readCollaborativeDocument(pageB);
    for (const document of [browserADocument, browserBDocument, store.snapshot()]) {
      const heading = document.children[0].children[0];
      expect(heading.props.level).toBe(2);
      expect(heading.props.text).toBe('Shared across browsers');
    }

    // Force the bounded replay floor forward: a client that presents an
    // expired cursor must install the canonical current document, not guess.
    store.expireReplayHistory();
    pageBReloaded = await contextB.newPage();
    const expiredJoin = await connectCollaborationClient(pageBReloaded, {
      baseUrl, siteId: SITE_ID, contentId: CONTENT_ID,
      clientId: 'browser-b', initialDocument, afterSequence: 0
    });
    expect(expiredJoin.reloadRequired).toBe(true);
    const reload = await waitForCollaborationMessage(pageBReloaded, 'document.reload');
    expect(reload.sequence).toBe(2);
    const reloadedDocument = await readCollaborativeDocument(pageBReloaded);
    expect(reloadedDocument.children[0].children[0].props.level).toBe(2);
    expect(reloadedDocument.children[0].children[0].props.text).toBe('Shared across browsers');
    expect(store.snapshot()).toEqual(reloadedDocument);
  } finally {
    for (const page of [pageA, pageB, pageAReconnected, pageBReloaded]) {
      if (page && !page.isClosed()) {
        await page.evaluate(() => window.__systemfabricCollaboration?.close()).catch(() => {});
      }
    }
    await contextA.close();
    await contextB.close();
    await server.systemfabric.close();
    await new Promise(resolve => server.close(resolve));
  }
});
