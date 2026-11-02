'use strict';

const { getTraceContext } = require('./trace-context');

const SAFE_FIELD_NAMES = new Set([
  'requestId', 'traceId', 'spanId', 'parentSpanId',
  'method', 'route', 'statusCode', 'statusClass', 'elapsedMs',
  'code', 'errorType', 'component', 'operation', 'outcome'
]);
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ROUTE_RE = /^\/[A-Za-z0-9_/:.-]{0,119}$/;
const METHOD_RE = /^[A-Z]{1,12}$/;
const STATUS_CLASS_RE = /^[1-5]xx$/;

function sanitizeField(name, value) {
  if (!SAFE_FIELD_NAMES.has(name)) return undefined;
  if (name === 'requestId') return typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : undefined;
  if (name === 'traceId') return typeof value === 'string' && TRACE_ID_RE.test(value) ? value : undefined;
  if (name === 'spanId' || name === 'parentSpanId') return typeof value === 'string' && SPAN_ID_RE.test(value) ? value : undefined;
  if (name === 'route') return typeof value === 'string' && ROUTE_RE.test(value) ? value : '/other';
  if (name === 'method') return typeof value === 'string' && METHOD_RE.test(value) ? value : 'OTHER';
  if (name === 'statusClass') return typeof value === 'string' && STATUS_CLASS_RE.test(value) ? value : undefined;
  if (name === 'statusCode') return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
  if (name === 'elapsedMs') return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : undefined;
  if (name === 'code') return typeof value === 'string' && /^ERR_[A-Z0-9_.-]{1,96}$/.test(value) ? value : 'ERR_SYSTEMFABRIC_UNKNOWN';
  if (name === 'errorType' || name === 'component' || name === 'operation' || name === 'outcome') {
    return typeof value === 'string' && TOKEN_RE.test(value) ? value : undefined;
  }
  return undefined;
}

function normalizeEventName(event) {
  return typeof event === 'string' && /^systemfabric\.[a-z0-9_.-]{1,100}$/.test(event)
    ? event
    : 'systemfabric.observability.event';
}

function createStructuredLogger({
  logger = console,
  service = 'systemfabric-api',
  environment = 'development',
  accessLogsEnabled = false,
  now = Date.now
} = {}) {
  const safeService = TOKEN_RE.test(service) ? service : 'systemfabric';
  const safeEnvironment = TOKEN_RE.test(environment) ? environment : 'unknown';

  function emit(level, event, fields = {}) {
    if (!['debug', 'info', 'warn', 'error'].includes(level)) return false;
    const writer = typeof logger?.[level] === 'function'
      ? logger[level]
      : (typeof logger?.log === 'function' ? logger.log : null);
    if (!writer) return false;

    const context = getTraceContext();
    const record = {
      timestamp: new Date(now()).toISOString(),
      level,
      service: safeService,
      environment: safeEnvironment,
      event: normalizeEventName(event)
    };
    const contextualFields = {
      requestId: context?.requestId,
      traceId: context?.traceId,
      spanId: context?.spanId,
      parentSpanId: context?.parentSpanId
    };
    for (const [name, value] of Object.entries({ ...contextualFields, ...fields })) {
      const sanitized = sanitizeField(name, value);
      if (sanitized !== undefined) record[name] = sanitized;
    }

    try {
      writer.call(logger, JSON.stringify(record));
      return true;
    } catch {
      // Observability must never change the outcome of an application request.
      return false;
    }
  }

  function requestCompleted({ requestId, method, route, statusCode, elapsedMs } = {}) {
    if (!accessLogsEnabled) return false;
    const safeStatus = Number.isInteger(statusCode) ? statusCode : 0;
    return emit('info', 'systemfabric.http.request_completed', {
      requestId,
      method,
      route,
      statusCode: safeStatus,
      statusClass: safeStatus >= 100 && safeStatus <= 599 ? `${Math.floor(safeStatus / 100)}xx` : undefined,
      elapsedMs
    });
  }

  return Object.freeze({ emit, requestCompleted });
}

module.exports = { createStructuredLogger, SAFE_FIELD_NAMES, sanitizeField };
