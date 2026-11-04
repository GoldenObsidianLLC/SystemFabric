'use strict';

const { randomBytes } = require('node:crypto');
const {
  context,
  trace,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode
} = require('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider
} = require('@opentelemetry/sdk-trace');
const {
  createTraceContext,
  createChildTraceContext,
  getTraceContext,
  runWithTraceContext
} = require('./trace-context');

const TRACER_NAME = 'virgoscorpio_hub';
const SERVICE_NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const SAFE_ATTRIBUTES = new Set([
  'virgoscorpio_hub.component',
  'virgoscorpio_hub.operation',
  'virgoscorpio_hub.outcome',
  'http.request.method',
  'http.response.status_code',
  'db.system',
  'db.operation.name',
  'error.type',
  'error.code'
]);
const REDIS_METHODS = Object.freeze([
  'connect', 'eval', 'publish', 'pPublish', 'pSubscribe', 'subscribe',
  'get', 'set', 'del', 'hGet', 'hSet', 'expire', 'quit', 'ping'
]);
const INSTRUMENTED_CLIENT = Symbol.for('virgoscorpio_hub.observability.otel.instrumented');
const INSTRUMENTED_POOL = Symbol.for('virgoscorpio_hub.observability.otel.pool.instrumented');

let sdkRuntime = null;
let tracingEnabled = false;
let tracer = null;

function randomHex(bytes) {
  let value;
  do { value = randomBytes(bytes).toString('hex'); } while (/^0+$/.test(value));
  return value;
}

function strictBoolean(value, name) {
  if (value === undefined || value === null || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`${name} must be true or false.`);
}

function parseExporterHeaders(raw) {
  if (raw === undefined || raw === null || raw === '') return Object.freeze({});
  if (typeof raw !== 'string' || raw.length > 8192) {
    throw new TypeError('OTLP exporter headers must be a JSON object no larger than 8192 characters.');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new TypeError('OTLP exporter headers must contain valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('OTLP exporter headers must be a JSON object.');
  }
  const entries = Object.entries(parsed);
  if (entries.length > 8) throw new TypeError('At most eight OTLP exporter headers are allowed.');
  const headers = {};
  for (const [name, value] of entries) {
    const normalized = name.toLowerCase();
    if (!HEADER_NAME_RE.test(name) || !['authorization', 'x-api-key'].includes(normalized)) {
      throw new TypeError('Only authorization and x-api-key OTLP exporter headers are supported.');
    }
    if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || /[\r\n\0]/.test(value)) {
      throw new TypeError('OTLP exporter header values must be bounded strings without control characters.');
    }
    if (Object.hasOwn(headers, normalized)) throw new TypeError('Duplicate OTLP exporter header names are not allowed.');
    headers[normalized] = value;
  }
  return Object.freeze(headers);
}

function parseTracingConfig(env = process.env, serviceName = 'virgoscorpio-hub-api') {
  if (!env || typeof env !== 'object') throw new TypeError('An environment object is required.');
  const enabled = strictBoolean(env.VIRGOSCORPIO_HUB_OTEL_ENABLED, 'VIRGOSCORPIO_HUB_OTEL_ENABLED');
  const allowInsecureHttp = strictBoolean(env.VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP, 'VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP');
  const endpointValue = env.VIRGOSCORPIO_HUB_OTEL_EXPORTER_ENDPOINT || '';
  const headers = parseExporterHeaders(env.VIRGOSCORPIO_HUB_OTEL_EXPORTER_HEADERS_JSON);
  const sampleRaw = env.VIRGOSCORPIO_HUB_OTEL_SAMPLE_RATIO === undefined || env.VIRGOSCORPIO_HUB_OTEL_SAMPLE_RATIO === ''
    ? '0.1'
    : String(env.VIRGOSCORPIO_HUB_OTEL_SAMPLE_RATIO);
  const sampleRatio = Number(sampleRaw);
  if (!Number.isFinite(sampleRatio) || sampleRatio < 0 || sampleRatio > 1) {
    throw new RangeError('VIRGOSCORPIO_HUB_OTEL_SAMPLE_RATIO must be between 0 and 1.');
  }
  const timeoutMs = env.VIRGOSCORPIO_HUB_OTEL_EXPORT_TIMEOUT_MS === undefined || env.VIRGOSCORPIO_HUB_OTEL_EXPORT_TIMEOUT_MS === ''
    ? 5000
    : Number(env.VIRGOSCORPIO_HUB_OTEL_EXPORT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new RangeError('VIRGOSCORPIO_HUB_OTEL_EXPORT_TIMEOUT_MS must be an integer from 250 to 30000.');
  }
  if (!SERVICE_NAME_RE.test(serviceName)) throw new TypeError('The OpenTelemetry service name is invalid.');

  let endpoint = null;
  if (enabled) {
    if (typeof endpointValue !== 'string' || endpointValue.length < 1 || endpointValue.length > 2048) {
      throw new TypeError('VIRGOSCORPIO_HUB_OTEL_EXPORTER_ENDPOINT is required when OpenTelemetry is enabled.');
    }
    try { endpoint = new URL(endpointValue); } catch {
      throw new TypeError('VIRGOSCORPIO_HUB_OTEL_EXPORTER_ENDPOINT must be a valid URL.');
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new TypeError('The OTLP endpoint must not contain credentials, query parameters, or a fragment.');
    }
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && allowInsecureHttp)) {
      throw new TypeError('The OTLP endpoint must use HTTPS unless VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP=true.');
    }
    if (!endpoint.hostname) throw new TypeError('The OTLP endpoint must include a hostname.');
    if (endpoint.pathname === '/' || endpoint.pathname === '') endpoint.pathname = '/v1/traces';
    if (endpoint.pathname !== '/v1/traces') {
      throw new TypeError('The OTLP/HTTP endpoint path must be /v1/traces or omitted.');
    }
  }

  const environment = typeof env.NODE_ENV === 'string' && TOKEN_RE.test(env.NODE_ENV)
    ? env.NODE_ENV
    : 'unknown';
  const version = typeof env.VIRGOSCORPIO_HUB_VERSION === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(env.VIRGOSCORPIO_HUB_VERSION)
    ? env.VIRGOSCORPIO_HUB_VERSION
    : '0.5.1';

  return Object.freeze({
    enabled,
    endpoint: endpoint ? endpoint.toString() : null,
    headers,
    sampleRatio,
    timeoutMs,
    serviceName,
    environment,
    version
  });
}

function sanitizeAttributes(attributes = {}) {
  const safe = {};
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return safe;
  for (const [name, value] of Object.entries(attributes)) {
    if (!SAFE_ATTRIBUTES.has(name)) continue;
    if (name === 'http.response.status_code') {
      if (Number.isInteger(value) && value >= 100 && value <= 599) safe[name] = value;
      continue;
    }
    if (name === 'http.request.method') {
      if (typeof value === 'string' && /^[A-Z]{1,12}$/.test(value)) safe[name] = value;
      continue;
    }
    if (name === 'db.system') {
      if (['postgresql', 'redis', 'memgraph'].includes(value)) safe[name] = value;
      continue;
    }
    if (name === 'db.operation.name') {
      if (typeof value === 'string' && TOKEN_RE.test(value)) safe[name] = value.toLowerCase();
      continue;
    }
    if (name === 'error.type') {
      if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(value)) safe[name] = value;
      continue;
    }
    if (name === 'error.code') {
      safe[name] = typeof value === 'string' && /^ERR_[A-Z0-9_.-]{1,96}$/.test(value)
        ? value
        : 'ERR_VIRGOSCORPIO_HUB_UNKNOWN';
      continue;
    }
    if (typeof value === 'string' && TOKEN_RE.test(value)) safe[name] = value;
  }
  return safe;
}

function createIdGenerator() {
  return Object.freeze({
    generateTraceId() {
      return getTraceContext()?.traceId || randomHex(16);
    },
    generateSpanId() {
      return getTraceContext()?.spanId || randomHex(8);
    }
  });
}

function initializeTracing({
  env = process.env,
  serviceName = 'virgoscorpio-hub-api',
  serviceVersion,
  exporter = null
} = {}) {
  if (sdkRuntime) return sdkRuntime;
  const config = parseTracingConfig(env, serviceName);
  if (!config.enabled) {
    return Object.freeze({
      enabled: false,
      serviceName: config.serviceName,
      async shutdown() {}
    });
  }

  const traceExporter = exporter || new OTLPTraceExporter({
    url: config.endpoint,
    headers: config.headers,
    timeoutMillis: config.timeoutMs
  });
  const resource = resourceFromAttributes({
    'service.name': config.serviceName,
    'service.version': serviceVersion || config.version,
    'deployment.environment.name': config.environment
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(contextManager)) {
    contextManager.disable();
    throw new Error('An OpenTelemetry context manager is already registered in this process.');
  }

  const provider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.sampleRatio)
    }),
    spanProcessors: [new BatchSpanProcessor({
      exporter: traceExporter,
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
      exportTimeoutMillis: config.timeoutMs
    })],
    idGenerator: createIdGenerator()
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    contextManager.disable();
    void provider.shutdown().catch(() => {});
    throw new Error('An OpenTelemetry tracer provider is already registered in this process.');
  }

  tracingEnabled = true;
  tracer = trace.getTracer(TRACER_NAME, serviceVersion || config.version);
  let shutdownPromise = null;
  sdkRuntime = Object.freeze({
    enabled: true,
    serviceName: config.serviceName,
    async shutdown() {
      if (!shutdownPromise) {
        shutdownPromise = provider.shutdown().finally(() => {
          tracingEnabled = false;
          tracer = null;
          contextManager.disable();
        });
      }
      await shutdownPromise;
    }
  });
  return sdkRuntime;
}

function isTracingEnabled() {
  return tracingEnabled;
}

function traceContextForSpan(base, span, parentSpanId = base?.parentSpanId || null) {
  const spanContext = span.spanContext();
  const flags = Number(spanContext.traceFlags || 0).toString(16).padStart(2, '0').slice(-2);
  return Object.freeze({
    requestId: base?.requestId || null,
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: parentSpanId || null,
    traceFlags: flags,
    remoteParentAccepted: Boolean(base?.remoteParentAccepted),
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`
  });
}

function markSpanError(span, error) {
  if (!span || typeof span.setStatus !== 'function') return;
  const safe = sanitizeAttributes({
    'error.type': error?.name,
    'error.code': error?.code
  });
  if (Object.keys(safe).length) span.setAttributes(safe);
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'operation failed' });
}

function setHttpStatus(span, statusCode) {
  if (!span || typeof span.setAttributes !== 'function') return;
  const safe = sanitizeAttributes({ 'http.response.status_code': statusCode });
  if (Object.keys(safe).length) span.setAttributes(safe);
  if (Number.isInteger(statusCode) && statusCode >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'server response' });
  }
}

function executeSpan(span, baseContext, parentSpanId, callback) {
  const scopedContext = traceContextForSpan(baseContext, span, parentSpanId);
  return runWithTraceContext(scopedContext, async () => {
    try {
      return await callback(span);
    } catch (error) {
      markSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

function runWithServerSpan(traceContext, callback, attributes = {}) {
  if (typeof callback !== 'function') throw new TypeError('A span callback is required.');
  if (!tracingEnabled || !tracer) return runWithTraceContext(traceContext, () => callback(null));

  const parentContext = traceContext.parentSpanId
    ? trace.setSpanContext(ROOT_CONTEXT, {
      traceId: traceContext.traceId,
      spanId: traceContext.parentSpanId,
      traceFlags: Number.parseInt(traceContext.traceFlags || '00', 16),
      isRemote: true
    })
    : ROOT_CONTEXT;
  return runWithTraceContext(traceContext, () => tracer.startActiveSpan(
    'http.server.request',
    { kind: SpanKind.SERVER, attributes: sanitizeAttributes(attributes) },
    parentContext,
    span => executeSpan(span, traceContext, traceContext.parentSpanId, callback)
  ));
}

function withSpan(name, attributes, callback, kind = SpanKind.INTERNAL) {
  if (typeof callback !== 'function') throw new TypeError('A span callback is required.');
  if (!tracingEnabled || !tracer) return callback();
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(name)) {
    throw new TypeError('Span names must be bounded, low-cardinality identifiers.');
  }
  const parentContext = getTraceContext();
  const baseContext = parentContext || createTraceContext();
  const childContext = createChildTraceContext(baseContext);
  return runWithTraceContext(childContext, () => tracer.startActiveSpan(
    name,
    { kind, attributes: sanitizeAttributes(attributes) },
    span => executeSpan(span, childContext, baseContext.spanId, callback)
  ));
}

function withClientSpan(name, attributes, callback) {
  return withSpan(name, attributes, callback, SpanKind.CLIENT);
}

function startDetachedSpan(name, attributes = {}) {
  const parentContext = getTraceContext();
  const baseContext = parentContext || createTraceContext();
  const childContext = createChildTraceContext(baseContext);
  let handle = null;
  runWithTraceContext(childContext, () => tracer.startActiveSpan(
    name,
    { kind: SpanKind.CLIENT, attributes: sanitizeAttributes(attributes) },
    span => {
      handle = Object.freeze({
        span,
        otelContext: context.active(),
        traceContext: traceContextForSpan(childContext, span, baseContext.spanId),
        end(error = null) {
          context.with(this.otelContext, () => runWithTraceContext(this.traceContext, () => {
            if (error) markSpanError(span, error);
            span.end();
          }));
        }
      });
      return span;
    }
  ));
  return handle;
}

function sqlOperation(statement) {
  const text = typeof statement === 'string'
    ? statement
    : (statement && typeof statement.text === 'string' ? statement.text : '');
  const token = text.trimStart().match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() || 'OTHER';
  return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'BEGIN', 'COMMIT', 'ROLLBACK'].includes(token)
    ? token.toLowerCase()
    : 'other';
}

function instrumentPostgresPool(pool) {
  if (!pool || typeof pool.connect !== 'function' || pool[INSTRUMENTED_POOL]) return pool;
  const originalConnect = pool.connect;
  const instrumentClient = client => {
    if (!client || typeof client.query !== 'function' || client[INSTRUMENTED_CLIENT]) return client;
    const originalQuery = client.query;
    const wrappedQuery = function (...args) {
      if (!tracingEnabled || !tracer) return originalQuery.apply(this, args);
      const operation = sqlOperation(args[0]);
      const attributes = {
        'virgoscorpio_hub.component': 'database',
        'virgoscorpio_hub.operation': 'query',
        'db.system': 'postgresql',
        'db.operation.name': operation
      };
      const callbackIndex = args.length - 1;
      const callback = args[callbackIndex];
      if (typeof callback === 'function') {
        const handle = startDetachedSpan('db.postgresql.query', attributes);
        args[callbackIndex] = context.bind(handle.otelContext, function (...resultArgs) {
          const error = resultArgs[0] instanceof Error ? resultArgs[0] : null;
          runWithTraceContext(handle.traceContext, () => {
            handle.end(error);
            callback.apply(this, resultArgs);
          });
        });
        try {
          return originalQuery.apply(this, args);
        } catch (error) {
          handle.end(error);
          throw error;
        }
      }
      return withClientSpan('db.postgresql.query', attributes, () => originalQuery.apply(this, args));
    };
    try {
      client.query = wrappedQuery;
      Object.defineProperty(client, INSTRUMENTED_CLIENT, { value: true });
    } catch {
      return client;
    }
    return client;
  };

  const wrappedConnect = function (...args) {
    if (typeof args[0] === 'function') {
      const callback = args[0];
      args[0] = function (error, client, release) {
        if (client) instrumentClient(client);
        return callback.call(this, error, client, release);
      };
      return originalConnect.apply(this, args);
    }
    return originalConnect.apply(this, args).then(instrumentClient);
  };
  try {
    pool.connect = wrappedConnect;
    Object.defineProperty(pool, INSTRUMENTED_POOL, { value: true });
  } catch {
    return pool;
  }
  return pool;
}

function instrumentRedisClient(client) {
  if (!client || client[INSTRUMENTED_CLIENT]) return client;
  for (const method of REDIS_METHODS) {
    const original = client[method];
    if (typeof original !== 'function') continue;
    try {
      client[method] = function (...args) {
        return withClientSpan(`db.redis.${method.toLowerCase()}`, {
          'virgoscorpio_hub.component': 'redis',
          'virgoscorpio_hub.operation': method.toLowerCase(),
          'db.system': 'redis',
          'db.operation.name': method.toLowerCase()
        }, () => original.apply(this, args));
      };
    } catch {
      // A non-writable client method is left uninstrumented.
    }
  }
  try { Object.defineProperty(client, INSTRUMENTED_CLIENT, { value: true }); } catch {}
  return client;
}

module.exports = {
  initializeTracing,
  parseTracingConfig,
  parseExporterHeaders,
  sanitizeAttributes,
  isTracingEnabled,
  runWithServerSpan,
  withSpan,
  withClientSpan,
  setHttpStatus,
  markSpanError,
  instrumentPostgresPool,
  instrumentRedisClient,
  sqlOperation
};
