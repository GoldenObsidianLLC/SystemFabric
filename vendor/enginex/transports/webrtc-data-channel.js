'use strict';

/** Wrap an already-negotiated RTCDataChannel; signaling/ICE stay host-owned. */
function wrapRtcDataChannel(channel, options = {}) {
  if (!channel || typeof channel.send !== 'function') throw new TypeError('An RTCDataChannel is required.');
  const maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
  const highWaterMark = options.highWaterMark ?? 1024 * 1024;
  const lowWaterMark = options.lowWaterMark ?? Math.floor(highWaterMark / 4);
  const listeners = new Set();
  let closed = false;
  channel.bufferedAmountLowThreshold = lowWaterMark;
  const onMessage = event => {
    try {
      const raw = event.data;
      const size = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw?.byteLength ?? 0;
      if (size > maxMessageBytes) throw new RangeError('RTCDataChannel message exceeds configured limit.');
      const data = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
      for (const listener of listeners) listener(data);
    } catch (error) { for (const listener of listeners) listener({ type: 'transport.error', message: error.message }); }
  };
  channel.addEventListener?.('message', onMessage);
  if (!channel.addEventListener) channel.onmessage = onMessage;
  async function waitForBuffer() {
    if (channel.bufferedAmount <= highWaterMark) return;
    await new Promise((resolve, reject) => {
      const onLow = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('RTCDataChannel closed while waiting for backpressure.')); };
      const cleanup = () => { channel.removeEventListener?.('bufferedamountlow', onLow); channel.removeEventListener?.('close', onClose); };
      channel.addEventListener?.('bufferedamountlow', onLow, { once: true });
      channel.addEventListener?.('close', onClose, { once: true });
      if (!channel.addEventListener) setTimeout(() => { cleanup(); resolve(); }, 10);
    });
  }
  return Object.freeze({
    backend: 'webrtc-data-channel',
    async send(message) {
      if (closed || channel.readyState !== 'open') throw new Error('RTCDataChannel is not open.');
      const encoded = JSON.stringify(message);
      if (new TextEncoder().encode(encoded).byteLength > maxMessageBytes) throw new RangeError('RTCDataChannel message exceeds configured limit.');
      await waitForBuffer();
      channel.send(encoded);
    },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { closed = true; channel.removeEventListener?.('message', onMessage); listeners.clear(); }
  });
}
module.exports = { wrapRtcDataChannel };
