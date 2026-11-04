'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const {
  TRACE_ID_RE,
  SPAN_ID_RE,
  TRACE_FLAGS_RE,
  REQUEST_ID_RE
} = require('./trace-identifiers');

const contextStorage = new AsyncLocalStorage();
const TRACEPARENT_V00_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function randomHex(bytes) {
  let value;
  do { value = randomBytes(bytes).toString('hex'); } while (/^0+$/.test(value));
  return value;
}

function isNonZeroHex(value) {
  return typeof value === 'string' && !/^0+$/.test(value);
}

/**
 * Parses the supported W3C Trace Context version 00 header.
 * Unknown versions and malformed/zero identifiers are ignored rather than
 * partially interpreted. tracestate and baggage are intentionally unsupported.
 */
function parseTraceparent(value) {
  if (typeof value !== 'string' || value.length !== 55) return null;
  const match = TRACEPARENT_V00_RE.exec(value);
  if (!match) return null;
  const [, traceId, parentSpanId, traceFlags] = match;
  if (!isNonZeroHex(traceId) || !isNonZeroHex(parentSpanId)) return null;
  return Object.freeze({
    traceId: traceId.toLowerCase(),
    parentSpanId: parentSpanId.toLowerCase(),
    traceFlags: traceFlags.toLowerCase()
  });
}

function createTraceContext({
  requestId = null,
  incomingTraceparent = null,
  trustRemote = false
} = {}) {
  const remoteParent = trustRemote ? parseTraceparent(incomingTraceparent) : null;
  const traceId = remoteParent?.traceId || randomHex(16);
  const spanId = randomHex(8);
  const parentSpanId = remoteParent?.parentSpanId || null;
  const traceFlags = remoteParent?.traceFlags || '00';
  return Object.freeze({
    requestId: typeof requestId === 'string' && REQUEST_ID_RE.test(requestId) ? requestId : null,
    traceId,
    spanId,
    parentSpanId,
    traceFlags,
    remoteParentAccepted: Boolean(remoteParent),
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`
  });
}

function getTraceContext() {
  return contextStorage.getStore() || null;
}

function getTraceparent() {
  return getTraceContext()?.traceparent || null;
}

function runWithTraceContext(context, callback) {
  if (!context || !TRACE_ID_RE.test(context.traceId || '') ||
      !SPAN_ID_RE.test(context.spanId || '') || typeof callback !== 'function') {
    throw new TypeError('A valid trace context and callback are required.');
  }
  return contextStorage.run(context, callback);
}

function createChildTraceContext(parent = getTraceContext()) {
  if (!parent || !TRACE_ID_RE.test(parent.traceId || '') || !SPAN_ID_RE.test(parent.spanId || '')) {
    throw new TypeError('A current parent trace context is required.');
  }
  const spanId = randomHex(8);
  const traceFlags = TRACE_FLAGS_RE.test(parent.traceFlags || '') ? parent.traceFlags : '00';
  return Object.freeze({
    requestId: parent.requestId || null,
    traceId: parent.traceId,
    spanId,
    parentSpanId: parent.spanId,
    traceFlags,
    remoteParentAccepted: false,
    traceparent: `00-${parent.traceId}-${spanId}-${traceFlags}`
  });
}

function runWithChildTraceContext(callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function.');
  return runWithTraceContext(createChildTraceContext(), callback);
}

module.exports = {
  createTraceContext,
  parseTraceparent,
  getTraceContext,
  getTraceparent,
  runWithTraceContext,
  createChildTraceContext,
  runWithChildTraceContext
};
