'use strict';

/**
 * Attach to a ws-compatible WebSocketServer supplied by the host application.
 * EnginEx intentionally does not bundle a WebSocket server implementation.
 */
function attachWebSocketLivePreview({ wss, engine, templateOptions, authorize = async () => false, maxMessageBytes = 64 * 1024, maxOutputBytes = 2 * 1024 * 1024, rateLimitPerMinute = 60 } = {}) {
  if (!wss?.on || !engine?.load) throw new TypeError('wss and engine.load are required.');
  const sessions = new WeakMap();
  wss.on('connection', async (socket, request) => {
    let principal;
    try { principal = await authorize(request); } catch { socket.close(1008, 'Not authorized'); return; }
    if (!principal) { socket.close(1008, 'Not authorized'); return; }
    const session = { messages: 0, windowStart: Date.now(), principal, incrementalSessions: new Map() };
    sessions.set(socket, session);
    socket.on('message', async raw => {
      try {
        const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
        if (bytes > maxMessageBytes) { socket.close(1009, 'Message too large'); return; }
        const now = Date.now();
        if (now - session.windowStart >= 60_000) { session.windowStart = now; session.messages = 0; }
        if (++session.messages > rateLimitPerMinute) { socket.close(1008, 'Rate limit exceeded'); return; }
        const messageText = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
        const message = JSON.parse(messageText);
        if (message.type === 'ping') { safeSend(socket, { type: 'pong', at: now }); return; }
        if (message.type === 'incremental.update') {
          if (typeof message.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.sessionId)) {
            safeSend(socket, { type: 'error', code: 'ERR_ENGINEX_PREVIEW_SESSION', message: 'Invalid incremental session id.' });
            return;
          }
          const incremental = session.incrementalSessions.get(message.sessionId);
          if (!incremental) {
            safeSend(socket, { type: 'error', code: 'ERR_ENGINEX_PREVIEW_SESSION', message: 'Incremental session not found.' });
            return;
          }
          const result = incremental.session.render(message.data ?? Object.create(null), { changedPaths: message.changedPaths });
          const serialized = JSON.stringify(result);
          if (Buffer.byteLength(serialized) > maxOutputBytes) { safeSend(socket, { type: 'error', code: 'ERR_ENGINEX_PREVIEW_OUTPUT_LIMIT', message: 'Preview patch is too large.' }); return; }
          safeSend(socket, { type: 'incremental.result', sessionId: message.sessionId, template: incremental.templateName, revision: result.revision, result });
          return;
        }
        if (!['preview', 'incremental.start'].includes(message.type) || typeof message.template !== 'string' || !message.template || message.template.startsWith('/') || message.template.includes('..') || message.template.includes('\\')) {
          safeSend(socket, { type: 'error', code: 'ERR_ENGINEX_PREVIEW_REQUEST', message: 'Invalid preview request.' });
          return;
        }
        const loaded = await engine.load(message.template, { ...(templateOptions || {}), cache: true });
        if (message.type === 'incremental.start') {
          if (typeof message.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.sessionId)) {
            safeSend(socket, { type: 'error', code: 'ERR_ENGINEX_PREVIEW_SESSION', message: 'Invalid incremental session id.' });
            return;
          }
          if (session.incrementalSessions.size >= 32 && !session.incrementalSessions.has(message.sessionId)) {
            safeSend(socket, { type: 'error', code: 'ERR_ENGINEX_PREVIEW_SESSION_LIMIT', message: 'Too many incremental preview sessions.' });
            return;
          }
          const incrementalSession = loaded.createIncrementalSession();
          session.incrementalSessions.set(message.sessionId, { templateName: message.template, session: incrementalSession });
          const result = incrementalSession.render(message.data ?? Object.create(null));
          if (Buffer.byteLength(JSON.stringify(result)) > maxOutputBytes) { session.incrementalSessions.delete(message.sessionId); safeSend(socket, { type: 'error', code: 'ERR_ENGINEX_PREVIEW_OUTPUT_LIMIT', message: 'Preview output is too large.' }); return; }
          safeSend(socket, { type: 'incremental.result', sessionId: message.sessionId, template: message.template, revision: result.revision, result, fragments: loaded.fragments });
          return;
        }
        const html = loaded.render(message.data ?? Object.create(null));
        if (Buffer.byteLength(html) > maxOutputBytes) { safeSend(socket, { type: 'error', code: 'ERR_ENGINEX_PREVIEW_OUTPUT_LIMIT', message: 'Preview output is too large.' }); return; }
        safeSend(socket, { type: 'preview.result', template: message.template, revision: Number.isSafeInteger(message.revision) ? message.revision : null, html, fragments: loaded.fragments });
      } catch (error) {
        safeSend(socket, { type: 'error', code: error.code || 'ERR_ENGINEX_PREVIEW_FAILED', message: 'The preview request could not be completed.' });
      }
    });
  });
  return Object.freeze({ close() { for (const client of wss.clients || []) { try { client.close(1001, 'Preview server closing'); } catch {} } } });
}
function safeSend(socket, payload) {
  if (socket.readyState === 1 && typeof socket.send === 'function') socket.send(JSON.stringify(payload));
}
module.exports = { attachWebSocketLivePreview };
