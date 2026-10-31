'use strict';

const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const {
  makeId,
  initialDocument,
  createMemoryCollaborationStore,
  createIdentityService,
  createRedisApiInstance
} = require('../fixtures/collaboration-multinode');
const {
  connectCollaborationClient,
  sendCollaborationCommand,
  waitForCollaborationMessage,
  waitForAnyCollaborationMessage,
  readCollaborativeDocument
} = require('../fixtures/collaboration-client');

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '99999999-9999-4999-8999-999999999999';
const CONTENT_A = '22222222-2222-4222-8222-222222222222';
const CONTENT_B = '33333333-3333-4333-8333-333333333333';
const CONTENT_C = '44444444-4444-4444-8444-444444444444';
const REDIS_URL = process.env.SYSTEMFABRIC_TEST_REDIS_URL || '';

function assertApprovedRedisUrl(raw) {
  const url = new URL(raw);
  expect(['redis:', 'rediss:']).toContain(url.protocol);
  expect(['localhost', '127.0.0.1', '::1']).toContain(url.hostname.toLowerCase());
  expect(url.username).toBe('');
  expect(url.password).toBe('');
  expect(url.search).toBe('');
  expect(url.hash).toBe('');
}

function titleOperation({ number, clientId, baseSequence, title }) {
  return {
    schemaVersion: 1,
    opId: makeId(number),
    clientId,
    baseSequence,
    type: 'document.set_title',
    payload: { title }
  };
}

async function openClient(browser, { baseUrl, siteId, contentId, sessionNumber, clientId, afterSequence = 0 }) {
  const context = await browser.newContext();
  const token = 'f1-10-session-' + sessionNumber;
  await context.addCookies([{
    name: 'sf_session',
    value: token,
    url: baseUrl,
    httpOnly: true,
    sameSite: 'Lax'
  }]);
  const page = await context.newPage();
  const joined = await connectCollaborationClient(page, {
    baseUrl,
    siteId,
    contentId,
    clientId,
    initialDocument: initialDocument(contentId),
    afterSequence
  });
  return { context, page, joined, baseUrl, siteId, contentId, sessionNumber, clientId };
}

async function closeClients(clients) {
  for (const client of clients) {
    await client.page.evaluate(() => window.__systemfabricCollaboration?.close()).catch(() => {});
    await client.context.close().catch(() => {});
  }
}

async function startTwoNodes({ siteIds = [SITE_A], dropNextOnA = false } = {}) {
  assertApprovedRedisUrl(REDIS_URL);
  const channelPrefix = 'systemfabric:test:f1-10:' + randomUUID();
  const store = createMemoryCollaborationStore({
    sitesAndDocuments: [
      { siteId: SITE_A, contentId: CONTENT_A, createdBy: makeId(101) },
      { siteId: SITE_A, contentId: CONTENT_B, createdBy: makeId(101) },
      { siteId: SITE_B, contentId: CONTENT_C, createdBy: makeId(101) }
    ]
  });
  const identityService = createIdentityService({ siteIds, sessionCount: 12 });
  const nodeA = await createRedisApiInstance({
    redisUrl: REDIS_URL,
    channelPrefix,
    siteIds,
    store,
    identityService,
    heartbeatMs: 5_000
  });
  const nodeB = await createRedisApiInstance({
    redisUrl: REDIS_URL,
    channelPrefix,
    siteIds,
    store,
    identityService,
    heartbeatMs: 5_000
  });
  return { store, identityService, nodeA, nodeB, dropNextOnA };
}

test('two API instances fan out only within document scope and heartbeat repairs a dropped Redis hint', async ({ browser }) => {
  test.setTimeout(45_000);
  const runtime = await startTwoNodes({ siteIds: [SITE_A, SITE_B] });
  const clients = [];
  try {
    const pageA = await openClient(browser, {
      baseUrl: runtime.nodeA.baseUrl, siteId: SITE_A, contentId: CONTENT_A,
      sessionNumber: 1, clientId: 'editor-a'
    });
    const pageB = await openClient(browser, {
      baseUrl: runtime.nodeB.baseUrl, siteId: SITE_A, contentId: CONTENT_A,
      sessionNumber: 2, clientId: 'editor-b'
    });
    const otherDocument = await openClient(browser, {
      baseUrl: runtime.nodeB.baseUrl, siteId: SITE_A, contentId: CONTENT_B,
      sessionNumber: 11, clientId: 'other-document'
    });
    const otherSite = await openClient(browser, {
      baseUrl: runtime.nodeB.baseUrl, siteId: SITE_B, contentId: CONTENT_C,
      sessionNumber: 12, clientId: 'other-site'
    });
    clients.push(pageA, pageB, otherDocument, otherSite);
    expect(pageA.joined.sequence).toBe(0);
    expect(pageB.joined.sequence).toBe(0);

    const opA = titleOperation({
      number: 30001, clientId: 'editor-a', baseSequence: 0, title: 'Node A committed title'
    });
    await sendCollaborationCommand(pageA.page, {
      type: 'document.operation', contentId: CONTENT_A, operation: opA
    });
    const ackA = await waitForCollaborationMessage(pageA.page, 'document.operation.ack');
    expect(ackA.sequence).toBe(1);
    expect(ackA.fanoutDegraded).toBe(false);
    const deliveredToB = await waitForAnyCollaborationMessage(pageB.page);
    expect(deliveredToB.sequence).toBe(1);
    expect(deliveredToB.operation.payload.title).toBe('Node A committed title');

    const opB = titleOperation({
      number: 30002, clientId: 'editor-b', baseSequence: 1, title: 'Node B committed title'
    });
    await sendCollaborationCommand(pageB.page, {
      type: 'document.operation', contentId: CONTENT_A, operation: opB
    });
    const ackB = await waitForCollaborationMessage(pageB.page, 'document.operation.ack');
    expect(ackB.sequence).toBe(2);
    const deliveredToA = await waitForAnyCollaborationMessage(pageA.page);
    expect(deliveredToA.sequence).toBe(2);
    expect(deliveredToA.operation.payload.title).toBe('Node B committed title');

    await expect(async () => waitForAnyCollaborationMessage(otherDocument.page, 250)).rejects.toThrow(/Timed out/);
    await expect(async () => waitForAnyCollaborationMessage(otherSite.page, 250)).rejects.toThrow(/Timed out/);

    runtime.nodeA.dropNextDocumentRelay();
    const droppedAt = Date.now();
    const opC = titleOperation({
      number: 30003, clientId: 'editor-a', baseSequence: 2, title: 'Heartbeat recovered title'
    });
    await sendCollaborationCommand(pageA.page, {
      type: 'document.operation', contentId: CONTENT_A, operation: opC
    });
    const ackC = await waitForCollaborationMessage(pageA.page, 'document.operation.ack');
    expect(ackC.sequence).toBe(3);
    expect(ackC.fanoutDegraded).toBe(true);
    await expect(async () => waitForAnyCollaborationMessage(pageB.page, 350)).rejects.toThrow(/Timed out/);
    const repaired = await waitForCollaborationMessage(pageB.page, 'document.sync.operation', 8_000);
    expect(repaired.sequence).toBe(3);
    expect(repaired.operation.payload.title).toBe('Heartbeat recovered title');
    console.log(JSON.stringify({
      scenario: 'dropped-redis-hint-heartbeat-repair',
      recoveryLatencyMs: Date.now() - droppedAt,
      sequence: repaired.sequence
    }));

    for (const client of [pageA, pageB]) {
      const document = await readCollaborativeDocument(client.page);
      expect(document.title).toBe('Heartbeat recovered title');
    }
    await expect(async () => waitForAnyCollaborationMessage(otherDocument.page, 250)).rejects.toThrow(/Timed out/);
    await expect(async () => waitForAnyCollaborationMessage(otherSite.page, 250)).rejects.toThrow(/Timed out/);
  } finally {
    await closeClients(clients);
    await runtime.nodeA.close();
    await runtime.nodeB.close();
  }
});

test('two-instance PostgreSQL reconciliation repairs reordered and duplicate hints and reconnects after node loss', async ({ browser }) => {
  test.setTimeout(45_000);
  const runtime = await startTwoNodes({ siteIds: [SITE_A] });
  const clients = [];
  try {
    const pageA = await openClient(browser, {
      baseUrl: runtime.nodeA.baseUrl, siteId: SITE_A, contentId: CONTENT_A,
      sessionNumber: 1, clientId: 'reorder-a'
    });
    const pageB = await openClient(browser, {
      baseUrl: runtime.nodeB.baseUrl, siteId: SITE_A, contentId: CONTENT_A,
      sessionNumber: 2, clientId: 'reorder-b'
    });
    clients.push(pageA, pageB);

    const op1 = titleOperation({
      number: 31001, clientId: 'direct-seed-1', baseSequence: 0, title: 'Accepted one'
    });
    const op2 = titleOperation({
      number: 31002, clientId: 'direct-seed-2', baseSequence: 1, title: 'Accepted two'
    });
    const committed1 = await runtime.store.applyCollaborationOperation({
      siteId: SITE_A, contentId: CONTENT_A, actorId: makeId(101), operation: op1
    });
    const committed2 = await runtime.store.applyCollaborationOperation({
      siteId: SITE_A, contentId: CONTENT_A, actorId: makeId(102), operation: op2
    });
    expect(committed1.sequence).toBe(1);
    expect(committed2.sequence).toBe(2);

    // Deliver sequence 2 before sequence 1. Both WebSocket instances must
    // reconcile from the in-memory canonical store in sequence order.
    await runtime.nodeA.bridge.publishDocumentOperation({
      siteId: SITE_A,
      contentId: CONTENT_A,
      sequence: 2,
      originConnectionId: null,
      operation: committed2.operation
    });
    for (const client of [pageA, pageB]) {
      const first = await waitForAnyCollaborationMessage(client.page);
      const second = await waitForAnyCollaborationMessage(client.page);
      expect([first.sequence, second.sequence]).toEqual([1, 2]);
      expect([first.type, second.type].every(type => ['document.sync.operation', 'document.operation'].includes(type))).toBe(true);
    }

    // Duplicate and stale hints arrive after both sockets have advanced to two.
    await runtime.nodeB.bridge.publishDocumentOperation({
      siteId: SITE_A,
      contentId: CONTENT_A,
      sequence: 1,
      originConnectionId: null,
      operation: committed1.operation
    });
    await runtime.nodeB.bridge.publishDocumentOperation({
      siteId: SITE_A,
      contentId: CONTENT_A,
      sequence: 2,
      originConnectionId: null,
      operation: committed2.operation
    });
    for (const client of [pageA, pageB]) {
      await expect(async () => waitForAnyCollaborationMessage(client.page, 300)).rejects.toThrow(/Timed out/);
    }

    // Lose one API instance and rejoin its former client to the surviving node.
    await runtime.nodeA.close();
    pageA.page.evaluate(() => window.__systemfabricCollaboration?.close()).catch(() => {});
    const reconnected = await openClient(browser, {
      baseUrl: runtime.nodeB.baseUrl, siteId: SITE_A, contentId: CONTENT_A,
      sessionNumber: 1, clientId: 'reconnected-a', afterSequence: 0
    });
    clients.push(reconnected);
    expect(reconnected.joined.sequence).toBe(2);
    await waitForAnyCollaborationMessage(reconnected.page);
    await waitForAnyCollaborationMessage(reconnected.page);
    expect((await readCollaborativeDocument(reconnected.page)).title).toBe('Accepted two');
    const op3 = titleOperation({
      number: 31003, clientId: 'reconnected-a', baseSequence: 2, title: 'After node loss'
    });
    await sendCollaborationCommand(reconnected.page, {
      type: 'document.operation', contentId: CONTENT_A, operation: op3
    });
    const ack = await waitForCollaborationMessage(reconnected.page, 'document.operation.ack');
    expect(ack.sequence).toBe(3);
    const peer = await waitForAnyCollaborationMessage(pageB.page);
    expect(peer.sequence).toBe(3);
    expect(peer.operation.payload.title).toBe('After node loss');
  } finally {
    await closeClients(clients);
    await runtime.nodeA.close().catch(() => {});
    await runtime.nodeB.close();
  }
});

test('2/5/10 editor matrix across two API instances converges without duplicate sequence delivery', async ({ browser }) => {
  test.setTimeout(90_000);
  const runtime = await startTwoNodes({ siteIds: [SITE_A] });
  const clients = [];
  const deliveryLatencies = [];
  try {
    for (let index = 1; index <= 10; index += 1) {
      clients.push(await openClient(browser, {
        baseUrl: index % 2 === 1 ? runtime.nodeA.baseUrl : runtime.nodeB.baseUrl,
        siteId: SITE_A,
        contentId: CONTENT_A,
        sessionNumber: index,
        clientId: 'matrix-editor-' + index
      }));
    }

    let opNumber = 32000;
    for (const editorCount of [2, 5, 10]) {
      const baseSequence = runtime.store.snapshot({ siteId: SITE_A, contentId: CONTENT_A }).sequence;
      const active = clients.slice(0, editorCount);
      const submissions = active.map((client, index) => ({
        client,
        operation: titleOperation({
          number: opNumber + index,
          clientId: client.clientId,
          baseSequence,
          title: 'Editor ' + (index + 1) + ' phase ' + editorCount
        }),
        startedAt: Date.now()
      }));
      opNumber += 100;
      await Promise.all(submissions.map(({ client, operation }) =>
        sendCollaborationCommand(client.page, {
          type: 'document.operation', contentId: CONTENT_A, operation
        })
      ));
      const acknowledgements = await Promise.all(submissions.map(({ client }) =>
        waitForCollaborationMessage(client.page, 'document.operation.ack')
      ));
      const sequenceByClient = new Map(submissions.map((item, index) => [
        item.client.sessionNumber,
        acknowledgements[index].sequence
      ]));
      const startedBySequence = new Map(submissions.map((item, index) => [
        acknowledgements[index].sequence,
        item.startedAt
      ]));
      const acceptedSequences = acknowledgements.map(ack => ack.sequence).sort((a, b) => a - b);
      expect(acceptedSequences).toEqual(
        Array.from({ length: editorCount }, (_, index) => baseSequence + index + 1)
      );

      for (const client of clients) {
        const ownSequence = sequenceByClient.get(client.sessionNumber);
        const expectedSequences = acceptedSequences.filter(sequence => sequence !== ownSequence);
        const delivered = [];
        for (let index = 0; index < expectedSequences.length; index += 1) {
          const message = await waitForAnyCollaborationMessage(client.page, 8_000);
          delivered.push(message.sequence);
          deliveryLatencies.push(Date.now() - startedBySequence.get(message.sequence));
        }
        expect(delivered).toEqual(expectedSequences);
        await expect(async () => waitForAnyCollaborationMessage(client.page, 200)).rejects.toThrow(/Timed out/);
      }

      const canonical = runtime.store.snapshot({ siteId: SITE_A, contentId: CONTENT_A }).document;
      for (const client of clients) {
        expect(await readCollaborativeDocument(client.page)).toEqual(canonical);
      }
      console.log(JSON.stringify({
        scenario: 'two-instance-editor-matrix',
        editors: editorCount,
        sequenceStart: baseSequence + 1,
        sequenceEnd: baseSequence + editorCount
      }));
    }

    const sorted = [...deliveryLatencies].sort((a, b) => a - b);
    const percentile = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
    console.log(JSON.stringify({
      scenario: 'two-instance-delivery-latency-ms',
      samples: sorted.length,
      p50: percentile(0.50),
      p95: percentile(0.95),
      p99: percentile(0.99)
    }));
  } finally {
    await closeClients(clients);
    await runtime.nodeA.close();
    await runtime.nodeB.close();
  }
});
