'use strict';

const {
  context: otelContext,
  trace: otelTrace
} = require('@opentelemetry/api');
const { getTraceContext } = require('./trace-context');

const SAFE_FIELD_NAMES = new Set([
  'requestId', 'traceId', 'spanId', 'parentSpanId',
  'method', 'route', 'statusCode', 'statusClass', 'elapsedMs',
  'code', 'errorType', 'component', 'operation', 'outcome',
  'count', 'checked', 'errors', 'unlinked', 'intervalMs',
  'batchSize', 'dispatchBatchSize', 'leaseMs', 'maxAttempts',
  'pollMs', 'attempts', 'terminal', 'processed', 'durationMs'
]);
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ROUTE_RE = /^\/[A-Za-z0-9_/:.-]{0,119}$/;
const EVENT_NAME_RE = /^virgoscorpio_hub\.[a-z0-9_.-]{1,100}$/;
const METHOD_RE = /^[A-Z]{1,12}$/;
const STATUS_CLASS_RE = /^[1-5]xx$/;
const NUMERIC_FIELDS = new Set([
  'count', 'checked', 'errors', 'unlinked', 'intervalMs',
  'batchSize', 'dispatchBatchSize', 'leaseMs', 'maxAttempts',
  'pollMs', 'attempts', 'processed', 'durationMs'
]);
const OTEL_ATTRIBUTE_NAMES = Object.freeze({
  requestId: 'virgoscorpio_hub.request_id',
  traceId: 'virgoscorpio_hub.trace_id',
  spanId: 'virgoscorpio_hub.span_id',
  parentSpanId: 'virgoscorpio_hub.parent_span_id',
  method: 'http.request.method',
  route: 'http.route',
  statusCode: 'http.response.status_code',
  statusClass: 'virgoscorpio_hub.http.status_class',
  elapsedMs: 'virgoscorpio_hub.elapsed_ms',
  code: 'error.code',
  errorType: 'error.type',
  component: 'virgoscorpio_hub.component',
  operation: 'virgoscorpio_hub.operation',
  outcome: 'virgoscorpio_hub.outcome',
  count: 'virgoscorpio_hub.count',
  checked: 'virgoscorpio_hub.checked',
  errors: 'virgoscorpio_hub.errors',
  unlinked: 'virgoscorpio_hub.unlinked',
  intervalMs: 'virgoscorpio_hub.interval_ms',
  batchSize: 'virgoscorpio_hub.batch_size',
  dispatchBatchSize: 'virgoscorpio_hub.dispatch_batch_size',
  leaseMs: 'virgoscorpio_hub.lease_ms',
  maxAttempts: 'virgoscorpio_hub.max_attempts',
  pollMs: 'virgoscorpio_hub.poll_ms',
  attempts: 'virgoscorpio_hub.attempts',
  terminal: 'virgoscorpio_hub.terminal',
  processed: 'virgoscorpio_hub.processed',
  durationMs: 'virgoscorpio_hub.duration_ms'
});
const SEVERITY_NUMBERS = Object.freeze({
  debug: 5,
  info: 9,
  warn: 13,
  error: 17
});

function sanitizeField(name, value) {
  if (!SAFE_FIELD_NAMES.has(name)) return undefined;
  if (name === 'requestId') return typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : undefined;
  if (name === 'traceId') return typeof value === 'string' && TRACE_ID_RE.test(value) ? value : undefined;
  if (name === 'spanId' || name === 'parentSpanId') return typeof value === 'string' && SPAN_ID_RE.test(value) ? value : undefined;
  if (name === 'route') return typeof value === 'string' && ROUTE_RE.test(value) ? value : '/other';
  if (name === 'method') return typeof value === 'string' && METHOD_RE.test(value) ? value : 'OTHER';
  if (name === 'statusClass') return typeof value === 'string' && STATUS_CLASS_RE.test(value) ? value : undefined;
  if (name === 'statusCode') return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
  if (name === 'elapsedMs' || name === 'durationMs') {
    return Number.isFinite(value) && value >= 0 && value <= 86_400_000
      ? Math.round(value * 1000) / 1000
      : undefined;
  }
  if (NUMERIC_FIELDS.has(name)) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
  }
  if (name === 'terminal') return typeof value === 'boolean' ? value : undefined;
  if (name === 'code') return typeof value === 'string' && /^ERR_[A-Z0-9_.-]{1,96}$/.test(value) ? value : 'ERR_VIRGOSCORPIO_HUB_UNKNOWN';
  if (name === 'errorType' || name === 'component' || name === 'operation' || name === 'outcome') {
    return typeof value === 'string' && TOKEN_RE.test(value) ? value : undefined;
  }
  return undefined;
}

function normalizeEventName(event) {
  return typeof event === 'string' && EVENT_NAME_RE.test(event)
    ? event
    : 'virgoscorpio_hub.observability.event';
}

function toHrTime(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const seconds = Math.floor(milliseconds / 1000);
  const nanoseconds = (milliseconds - seconds * 1000) * 1_000_000;
  return [seconds, nanoseconds];
}

/**
 * Emit only the already-sanitized structured record through the OpenTelemetry
 * Logs API. The active trace context is attached as OTLP trace/span correlation
 * metadata; request-specific identifiers remain bounded attributes.
 */
function emitOtelLog(otelLogger, record) {
  if (!otelLogger || typeof otelLogger.emit !== 'function') return false;
  const attributes = { 'event.name': record.event };
  for (const [field, attribute] of Object.entries(OTEL_ATTRIBUTE_NAMES)) {
    if (Object.hasOwn(record, field)) attributes[attribute] = record[field];
  }

  const traceContext = getTraceContext();
  let correlatedContext;
  if (traceContext && TRACE_ID_RE.test(traceContext.traceId || '') &&
      SPAN_ID_RE.test(traceContext.spanId || '')) {
    correlatedContext = otelTrace.setSpanContext(otelContext.active(), {
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      traceFlags: Number.parseInt(traceContext.traceFlags || '00', 16) || 0,
      isRemote: false
    });
  }

  const logRecord = {
    timestamp: toHrTime(record.timestamp),
    severityNumber: SEVERITY_NUMBERS[record.level],
    severityText: record.level.toUpperCase(),
    body: record.event,
    attributes
  };
  if (correlatedContext) logRecord.context = correlatedContext;
  otelLogger.emit(logRecord);
  return true;
}

function createStructuredLogger({
  logger = console,
  otelLogger = null,
  service = 'virgoscorpio-hub-api',
  environment = 'development',
  accessLogsEnabled = false,
  now = Date.now
} = {}) {
  const safeService = TOKEN_RE.test(service) ? service : 'virgoscorpio_hub';
  const safeEnvironment = TOKEN_RE.test(environment) ? environment : 'unknown';

  function emit(level, event, fields = {}) {
    if (!Object.hasOwn(SEVERITY_NUMBERS, level)) return false;
    const writer = typeof logger?.[level] === 'function'
      ? logger[level]
      : (typeof logger?.log === 'function' ? logger.log : null);
    if (!writer && typeof otelLogger?.emit !== 'function') return false;

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

    let delivered = false;
    if (writer) {
      try {
        writer.call(logger, JSON.stringify(record));
        delivered = true;
      } catch {
        // A local log sink must never change the outcome of an application request.
      }
    }
    if (otelLogger) {
      try {
        if (emitOtelLog(otelLogger, record)) delivered = true;
      } catch {
        // Telemetry export is best-effort and never changes application behavior.
      }
    }
    return delivered;
  }

  function requestCompleted({ requestId, method, route, statusCode, elapsedMs } = {}) {
    if (!accessLogsEnabled) return false;
    const safeStatus = Number.isInteger(statusCode) ? statusCode : 0;
    return emit('info', 'virgoscorpio_hub.http.request_completed', {
      requestId,
      method,
      route,
      statusCode: safeStatus,
      statusClass: safeStatus >= 100 && safeStatus <= 599 ? String(Math.floor(safeStatus / 100)) + 'xx' : undefined,
      elapsedMs
    });
  }

  return Object.freeze({ emit, requestCompleted });
}

module.exports = {
  createStructuredLogger,
  emitOtelLog,
  SAFE_FIELD_NAMES,
  sanitizeField,
  normalizeEventName
};
