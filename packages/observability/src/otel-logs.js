'use strict';

const { LoggerProvider, BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { parseExporterHeaders } = require('./tracing');

const SERVICE_NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;

function strictBoolean(value, name) {
  if (value === undefined || value === null || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`${name} must be true or false.`);
}

function boundedTimeout(value) {
  if (value === undefined || value === '') return 5000;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new RangeError('VIRGOSCORPIO_HUB_OTEL_EXPORT_TIMEOUT_MS must be an integer from 250 to 30000.');
  }
  return timeoutMs;
}

function parseLogExportConfig(env = process.env, serviceName = 'virgoscorpio-hub-api') {
  if (!env || typeof env !== 'object') throw new TypeError('An environment object is required.');
  if (!SERVICE_NAME_RE.test(serviceName)) throw new TypeError('The OpenTelemetry service name is invalid.');

  const enabled = strictBoolean(env.VIRGOSCORPIO_HUB_OTEL_LOGS_ENABLED, 'VIRGOSCORPIO_HUB_OTEL_LOGS_ENABLED');
  const allowInsecureHttp = strictBoolean(
    env.VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP,
    'VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP'
  );
  const logHeadersRaw = env.VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_HEADERS_JSON;
  const headersRaw = logHeadersRaw === undefined || logHeadersRaw === null || logHeadersRaw === ''
    ? env.VIRGOSCORPIO_HUB_OTEL_EXPORTER_HEADERS_JSON
    : logHeadersRaw;
  const headers = parseExporterHeaders(headersRaw);
  const timeoutMs = boundedTimeout(env.VIRGOSCORPIO_HUB_OTEL_EXPORT_TIMEOUT_MS);

  let endpoint = null;
  if (enabled) {
    const endpointValue = env.VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT || '';
    if (typeof endpointValue !== 'string' || endpointValue.length < 1 || endpointValue.length > 2048) {
      throw new TypeError('VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT is required when OTLP log export is enabled.');
    }
    try {
      endpoint = new URL(endpointValue);
    } catch {
      throw new TypeError('VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT must be a valid URL.');
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new TypeError('The OTLP logs endpoint must not contain credentials, query parameters, or a fragment.');
    }
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && allowInsecureHttp)) {
      throw new TypeError('The OTLP logs endpoint must use HTTPS unless VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP=true.');
    }
    if (!endpoint.hostname) throw new TypeError('The OTLP logs endpoint must include a hostname.');
    if (endpoint.pathname === '/' || endpoint.pathname === '') endpoint.pathname = '/v1/logs';
    if (endpoint.pathname !== '/v1/logs') {
      throw new TypeError('The OTLP/HTTP logs endpoint path must be /v1/logs or omitted.');
    }
  }

  const environment = typeof env.NODE_ENV === 'string' && TOKEN_RE.test(env.NODE_ENV)
    ? env.NODE_ENV
    : 'unknown';
  const version = typeof env.VIRGOSCORPIO_HUB_VERSION === 'string' && VERSION_RE.test(env.VIRGOSCORPIO_HUB_VERSION)
    ? env.VIRGOSCORPIO_HUB_VERSION
    : '0.5.1';

  return Object.freeze({
    enabled,
    endpoint: endpoint ? endpoint.toString() : null,
    headers,
    timeoutMs,
    serviceName,
    environment,
    version
  });
}

/**
 * Create an isolated, opt-in OTLP Logs runtime.
 *
 * The provider is intentionally not registered as a process-global provider:
 * VirgoScorpio Hub's logger receives this runtime explicitly, avoiding accidental
 * capture of unrelated libraries or unreviewed console output.
 */
function initializeLogExport({
  env = process.env,
  serviceName = 'virgoscorpio-hub-api',
  serviceVersion,
  exporter = null
} = {}) {
  const config = parseLogExportConfig(env, serviceName);
  if (!config.enabled) {
    return Object.freeze({
      enabled: false,
      serviceName: config.serviceName,
      logger: null,
      async forceFlush() {},
      async shutdown() {}
    });
  }

  const logExporter = exporter || new OTLPLogExporter({
    url: config.endpoint,
    headers: config.headers,
    timeoutMillis: config.timeoutMs,
    concurrencyLimit: 1
  });
  const resource = resourceFromAttributes({
    'service.name': config.serviceName,
    'service.version': VERSION_RE.test(serviceVersion || '') ? serviceVersion : config.version,
    'deployment.environment.name': config.environment
  });
  const provider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({
      exporter: logExporter,
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
      exportTimeoutMillis: config.timeoutMs
    })]
  });
  const logger = provider.getLogger('virgoscorpio_hub.structured', config.version);

  let shutdownPromise = null;
  return Object.freeze({
    enabled: true,
    serviceName: config.serviceName,
    logger,
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      if (!shutdownPromise) shutdownPromise = provider.shutdown();
      await shutdownPromise;
    }
  });
}

module.exports = { parseLogExportConfig, initializeLogExport };
