'use strict';

async function connectCollaborationClient(page, { baseUrl, siteId, contentId, clientId, initialDocument, afterSequence = 0 }) {
  await page.goto(baseUrl + '/health');
  return page.evaluate(async config => {
    const messages = [];
    const waiters = [];
    const pendingOperations = new Map();
    let lastSequence = Number(config.afterSequence) || 0;
    const applyOperation = operation => {
      const payload = operation?.payload || {};
      if (operation?.type === 'document.set_title') {
        client.document.title = payload.title;
        return;
      }
      if (operation?.type === 'node.set_prop') {
        const visit = nodes => {
          for (const node of nodes || []) {
            if (node.id === payload.nodeId) {
              node.props[payload.key] = structuredClone(payload.value);
              return true;
            }
            if (visit(node.children)) return true;
          }
          return false;
        };
        visit(client.document.children);
      }
    };
    const client = {
      document: structuredClone(config.initialDocument),
      socket: null,
      messages,
      waitFor(type, timeoutMs = 3_000) {
        const matches = message => type === 'document.operation.any'
          ? ['document.operation', 'document.sync.operation'].includes(message.type)
          : message.type === type;
        const index = messages.findIndex(matches);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = { type, resolve, timer: null };
          waiter.timer = setTimeout(() => {
            const pendingIndex = waiters.indexOf(waiter);
            if (pendingIndex >= 0) waiters.splice(pendingIndex, 1);
            reject(new Error('Timed out waiting for browser message: ' + type));
          }, timeoutMs);
          waiters.push(waiter);
        });
      },
      send(command) {
        if (!client.socket || client.socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
        client.socket.send(JSON.stringify(command));
      },
      close() {
        return new Promise(resolve => {
          if (!client.socket || client.socket.readyState === WebSocket.CLOSED) return resolve();
          client.socket.addEventListener('close', resolve, { once: true });
          client.socket.close();
        });
      },
      snapshot() {
        return structuredClone(client.document);
      }
    };

    window.__systemfabricCollaboration = client;
    const wsUrl = config.baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
      + '/api/v1/sites/' + config.siteId + '/realtime/ws';
    client.socket = new WebSocket(wsUrl);
    client.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'document.operation' || message.type === 'document.sync.operation' || message.type === 'document.operation.ack') {
        const sequence = Number(message.sequence);
        if (Number.isSafeInteger(sequence) && sequence > lastSequence && message.operation) {
          if (!pendingOperations.has(sequence)) pendingOperations.set(sequence, message.operation);
          while (pendingOperations.has(lastSequence + 1)) {
            const nextSequence = lastSequence + 1;
            applyOperation(pendingOperations.get(nextSequence));
            pendingOperations.delete(nextSequence);
            lastSequence = nextSequence;
          }
        }
      } else if (message.type === 'document.reload') {
        client.document = structuredClone(message.document);
        lastSequence = Number(message.sequence) || lastSequence;
        pendingOperations.clear();
      }
      const waiterIndex = waiters.findIndex(waiter => waiter.type === 'document.operation.any'
        ? ['document.operation', 'document.sync.operation'].includes(message.type)
        : waiter.type === message.type);
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    });
    await new Promise((resolve, reject) => {
      if (client.socket.readyState === WebSocket.OPEN) return resolve();
      client.socket.addEventListener('open', resolve, { once: true });
      client.socket.addEventListener('error', () => reject(new Error('Browser WebSocket failed to open')), { once: true });
    });
    await client.waitFor('connection.ready');
    client.send({ type: 'document.join', contentId: config.contentId, afterSequence: config.afterSequence });
    const joined = await client.waitFor('document.joined');
    return joined;
  }, { baseUrl, siteId, contentId, clientId, initialDocument, afterSequence });
}

async function sendCollaborationCommand(page, command) {
  return page.evaluate(value => {
    window.__systemfabricCollaboration.send(value);
  }, command);
}

async function waitForCollaborationMessage(page, type, timeoutMs = 3_000) {
  return page.evaluate(({ expectedType, waitMs }) => (
    window.__systemfabricCollaboration.waitFor(expectedType, waitMs)
  ), { expectedType: type, waitMs: timeoutMs });
}

async function waitForAnyCollaborationMessage(page, timeoutMs = 3_000) {
  return waitForCollaborationMessage(page, 'document.operation.any', timeoutMs);
}

async function readCollaborativeDocument(page) {
  return page.evaluate(() => window.__systemfabricCollaboration.snapshot());
}

async function closeCollaborationClient(page) {
  return page.evaluate(() => window.__systemfabricCollaboration.close());
}

module.exports = {
  connectCollaborationClient,
  sendCollaborationCommand,
  waitForCollaborationMessage,
  waitForAnyCollaborationMessage,
  readCollaborativeDocument,
  closeCollaborationClient
};
