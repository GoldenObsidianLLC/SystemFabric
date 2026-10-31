'use strict';

const { validateCollaborationOperation, transformCollaborationOperation, applyCollaborationOperation } = require('../../packages/collaboration/src');

function makeId(number) {
  return '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
}

function initialDocument(documentId) {
  return {
    schemaVersion: 1,
    documentId,
    type: 'page',
    title: 'Initial cross-instance draft',
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

function createMemoryCollaborationStore({ sitesAndDocuments }) {
  const documents = new Map();
  for (const { siteId, contentId, createdBy = makeId(1) } of sitesAndDocuments) {
    documents.set(contentId, {
      siteId,
      contentId,
      createdBy,
      status: 'draft',
      contentType: 'page',
      version: 1,
      lockVersion: 1,
      sequence: 0,
      oldestReplaySequence: 0,
      document: initialDocument(contentId),
      operations: [],
      idempotency: new Map()
    });
  }

  function requireDocument(siteId, contentId) {
    const record = documents.get(contentId);
    if (!record || record.siteId !== siteId) {
      const error = new Error('Content not found.');
      error.statusCode = 404;
      error.code = 'ERR_SYSTEMFABRIC_CONTENT_NOT_FOUND';
      throw error;
    }
    return record;
  }

  return {
    async getById({ siteId, id }) {
      const record = documents.get(id);
      if (!record || record.siteId !== siteId) return null;
      return {
        id: record.contentId,
        site_id: record.siteId,
        content_type: record.contentType,
        status: record.status,
        created_by: record.createdBy,
        version: record.version,
        lock_version: record.lockVersion,
        title: record.document.title,
        body: structuredClone(record.document),
        published_snapshot: null
      };
    },

    async applyCollaborationOperation({ siteId, contentId, actorId, operation }) {
      const record = requireDocument(siteId, contentId);
      if (record.status !== 'draft') {
        const error = new Error('Collaborative editing is draft-only.');
        error.statusCode = 409;
        error.code = 'ERR_SYSTEMFABRIC_COLLABORATION_NOT_DRAFT';
        throw error;
      }
      const validation = validateCollaborationOperation(operation);
      if (!validation.valid) {
        const error = new Error(validation.errors.join('; '));
        error.statusCode = 400;
        error.code = 'ERR_SYSTEMFABRIC_INVALID_COLLABORATION_OPERATION';
        throw error;
      }
      const existing = record.idempotency.get(operation.opId);
      if (existing) {
        if (existing.actorId !== actorId || JSON.stringify(existing.operation) !== JSON.stringify(operation)) {
          const error = new Error('Operation ID reuse.');
          error.statusCode = 409;
          error.code = 'ERR_SYSTEMFABRIC_COLLABORATION_OP_ID_REUSE';
          throw error;
        }
        return { ...existing.result, operation: structuredClone(existing.appliedOperation), duplicate: true };
      }
      if (operation.baseSequence > record.sequence) {
        const error = new Error('Future collaboration sequence.');
        error.statusCode = 409;
        error.code = 'ERR_SYSTEMFABRIC_COLLABORATION_FUTURE_SEQUENCE';
        throw error;
      }
      if (operation.baseSequence < record.oldestReplaySequence) {
        return {
          reloadRequired: true,
          sequence: record.sequence,
          oldestReplaySequence: record.oldestReplaySequence,
          document: structuredClone(record.document),
          title: record.document.title,
          version: record.version,
          lockVersion: record.lockVersion
        };
      }
      const history = record.operations.filter(item => item.sequence > operation.baseSequence);
      const transformed = transformCollaborationOperation(operation, history);
      const applied = applyCollaborationOperation(record.document, transformed);
      record.document = applied.document;
      record.sequence += 1;
      record.version += 1;
      record.lockVersion += 1;
      const result = {
        sequence: record.sequence,
        oldestReplaySequence: record.oldestReplaySequence,
        version: record.version,
        lockVersion: record.lockVersion,
        title: record.document.title
      };
      record.operations.push({
        sequence: record.sequence,
        operation: structuredClone(operation),
        appliedOperation: structuredClone(transformed)
      });
      record.idempotency.set(operation.opId, {
        actorId,
        operation: structuredClone(operation),
        appliedOperation: structuredClone(transformed),
        result: structuredClone(result)
      });
      return {
        ...result,
        operation: structuredClone(transformed),
        appliedOperation: structuredClone(transformed),
        duplicate: false
      };
    },

    async getCollaborationSync({ siteId, contentId, afterSequence }) {
      const record = requireDocument(siteId, contentId);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        const error = new Error('Invalid sequence cursor.');
        error.statusCode = 400;
        error.code = 'ERR_SYSTEMFABRIC_INVALID_COLLABORATION_SEQUENCE';
        throw error;
      }
      if (afterSequence > record.sequence) {
        const error = new Error('Future sequence cursor.');
        error.statusCode = 409;
        error.code = 'ERR_SYSTEMFABRIC_COLLABORATION_FUTURE_SEQUENCE';
        throw error;
      }
      if (afterSequence < record.oldestReplaySequence) {
        return {
          reloadRequired: true,
          sequence: record.sequence,
          oldestReplaySequence: record.oldestReplaySequence,
          document: structuredClone(record.document),
          title: record.document.title,
          version: record.version,
          lockVersion: record.lockVersion
        };
      }
      return {
        reloadRequired: false,
        sequence: record.sequence,
        oldestReplaySequence: record.oldestReplaySequence,
        operations: record.operations
          .filter(item => item.sequence > afterSequence)
          .map(item => structuredClone(item))
      };
    },

    snapshot({ siteId, contentId }) {
      const record = requireDocument(siteId, contentId);
      return {
        sequence: record.sequence,
        document: structuredClone(record.document)
      };
    }
  };
}

function createIdentityService({ siteIds, sessionCount = 10 }) {
  const sessions = new Map();
  const activeSessions = new Set();
  for (let index = 1; index <= sessionCount; index += 1) {
    const token = 'f1-10-session-' + index;
    const userId = makeId(100 + index);
    const sessionId = makeId(200 + index);
    sessions.set(token, {
      userId,
      sessionId,
      email: 'f1-10-editor-' + index + '@example.test'
    });
    activeSessions.add(sessionId);
  }
  return {
    async authenticate(token) {
      const session = sessions.get(token);
      if (!session) return null;
      return {
        sessionId: session.sessionId,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        user: {
          id: session.userId,
          email: session.email,
          displayName: 'F1.10 Browser Editor',
          status: 'active'
        },
        memberships: siteIds.map(siteId => ({
          siteId,
          capabilities: ['content:read', 'content:edit']
        }))
      };
    },
    async isSessionActive({ userId, sessionId }) {
      const session = [...sessions.values()].find(item => item.userId === userId && item.sessionId === sessionId);
      return Boolean(session && activeSessions.has(sessionId));
    },
    async authorizeSite(userId, siteId, capability) {
      return sessions.size > 0 &&
        [...sessions.values()].some(item => item.userId === userId) &&
        siteIds.includes(siteId) &&
        ['content:read', 'content:edit'].includes(capability);
    }
  };
}

function createPresenceService() {
  const leases = new Map();
  return {
    async heartbeat({ siteId, principalId, sessionId, availability = 'active' }) {
      leases.set(siteId + ':' + sessionId, { siteId, principalId, sessionId, availability });
      return { availability };
    },
    async leave({ siteId, sessionId }) {
      return { left: leases.delete(siteId + ':' + sessionId) };
    },
    async list({ siteId }) {
      return [...leases.values()].filter(item => item.siteId === siteId);
    },
    async close() {
      leases.clear();
    }
  };
}


async function createRedisApiInstance({
  redisUrl,
  channelPrefix,
  siteIds,
  store,
  identityService,
  heartbeatMs = 5_000
}) {
  const { createClient } = require('redis');
  const { createApiServer } = require('../../apps/api/src/server');
  const { createRedisRealtimeBridge } = require('../../packages/realtime/src/redis-realtime');

  let dropNextDocumentRelay = false;
  let publisherCreated = false;
  const createFaultInjectingClient = options => {
    const client = createClient(options);
    if (!publisherCreated) {
      publisherCreated = true;
      const publish = client.publish.bind(client);
      client.publish = async (channel, message) => {
        if (dropNextDocumentRelay && channel.includes(':document:')) {
          dropNextDocumentRelay = false;
          const error = new Error('F1.10 test injected document relay drop.');
          error.code = 'ERR_F1_10_TEST_DOCUMENT_RELAY_DROP';
          throw error;
        }
        return publish(channel, message);
      };
    }
    return client;
  };

  const bridge = await createRedisRealtimeBridge({
    url: redisUrl,
    channelPrefix,
    createClient: createFaultInjectingClient,
    onError() {}
  });
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_DEFAULT_SITE_ID: siteIds[0],
      SYSTEMFABRIC_REALTIME_ENABLED: 'true',
      SYSTEMFABRIC_PRESENCE_STORE: 'memory',
      AI_PROVIDER: 'mock',
      RATE_LIMIT_MAX_REQUESTS: '1000'
    },
    contentStore: store,
    identityService,
    realtimeBridge: bridge,
    realtimeHeartbeatMs: heartbeatMs,
    logger: { error() {} }
  });

  await server.systemfabric.ready();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  let closed = false;
  return {
    server,
    bridge,
    baseUrl,
    dropNextDocumentRelay() {
      dropNextDocumentRelay = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      await server.systemfabric.close();
      if (server.listening) {
        await new Promise(resolve => server.close(resolve));
      }
    }
  };
}

module.exports = {
  makeId,
  initialDocument,
  createMemoryCollaborationStore,
  createIdentityService,
  createPresenceService,
  createRedisApiInstance
};
