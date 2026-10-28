'use strict';

/** Browser-side WebTransport JSON-lines channel for reliable template updates. */
export async function connectWebTransport(url, options = {}) {
  const Transport = options.WebTransportClass || globalThis.WebTransport;
  if (typeof Transport !== 'function') throw new Error('WebTransport is unavailable in this environment.');
  const transport = new Transport(url, options.transportOptions);
  await transport.ready;
  const stream = await transport.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
  let pendingText = '';
  let closed = false;
  const listeners = new Set();
  const readerTask = (async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        pendingText += decoder.decode(value, { stream: true });
        if (pendingText.length > maxMessageBytes) throw new Error('WebTransport message exceeds configured limit.');
        let newline;
        while ((newline = pendingText.indexOf('\n')) !== -1) {
          const line = pendingText.slice(0, newline);
          pendingText = pendingText.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          for (const listener of listeners) listener(message);
        }
      }
    } catch (error) {
      if (!closed) for (const listener of listeners) listener({ type: 'transport.error', message: error.message });
    }
  })();
  return Object.freeze({
    transport,
    async send(message) {
      if (closed) throw new Error('WebTransport connection is closed.');
      const encoded = encoder.encode(`${JSON.stringify(message)}\n`);
      if (encoded.byteLength > maxMessageBytes) throw new RangeError('WebTransport message exceeds configured limit.');
      await writer.ready;
      await writer.write(encoded);
    },
    onMessage(listener) { if (typeof listener !== 'function') throw new TypeError('listener must be a function.'); listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      if (closed) return;
      closed = true;
      try { await writer.close(); } catch {}
      try { await reader.cancel(); } catch {}
      try { transport.close({ closeCode: 0, reason: 'EnginEx client closed' }); } catch {}
      await readerTask.catch(() => {});
      listeners.clear();
    }
  });
}
