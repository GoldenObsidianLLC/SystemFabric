'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { context: otelContext, trace: otelTrace } = require('@opentelemetry/api');
const { InMemoryLogRecordExporter } = require('@opentelemetry/sdk-logs');
const {
  parseLogExportConfig,
  initializeLogExport
} = require('../packages/observability/src/otel-logs');
const { createStructuredLogger } = require('../packages/observability/src/structured-logger');
const { initializeTracing, withSpan } = require('../packages/observability/src/tracing');
const {
  createTraceContext,
  runWithTraceContext
} = require('../packages/observability/src/trace-context');

function validEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    VIRGOSCORPIO_HUB_OTEL_LOGS_ENABLED: 'true',
    VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT: 'https://collector.example/v1/logs',
    VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_HEADERS_JSON: '{"authorization":"Bearer test-log-token"}',
    ...overrides
  };
}

async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address();
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolve => server.close(resolve));
}

test('OTLP logs are disabled by default and require no endpoint', () => {
  const config = parseLogExportConfig({}, 'virgoscorpio-hub-api');
  assert.equal(config.enabled, false);
  assert.equal(config.endpoint, null);
  assert.deepEqual(config.headers, {});
  assert.equal(config.timeoutMs, 5000);
  const runtime = initializeLogExport({ env: {}, serviceName: 'virgoscorpio-hub-api' });
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.logger, null);
});

test('OTLP logs endpoint validation requires HTTPS and only permits the /v1/logs path', () => {
  assert.equal(
    parseLogExportConfig(validEnv({
      VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT: 'https://collector.example'
    })).endpoint,
    'https://collector.example/v1/logs'
  );
  assert.throws(
    () => parseLogExportConfig(validEnv({
      VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT: 'http://collector.example/v1/logs'
    })),
    /must use HTTPS/
  );
  assert.equal(
    parseLogExportConfig(validEnv({
      VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT: 'http://127.0.0.1:4318/v1/logs',
      VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP: 'true'
    })).endpoint,
    'http://127.0.0.1:4318/v1/logs'
  );
  for (const endpoint of [
    'https://user:secret@collector.example/v1/logs',
    'https://collector.example/v1/logs?token=secret',
    'https://collector.example/custom'
  ]) {
    assert.throws(
      () => parseLogExportConfig(validEnv({ VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT: endpoint })),
      /credentials|path must be/
    );
  }
  assert.throws(
    () => parseLogExportConfig(validEnv({ VIRGOSCORPIO_HUB_OTEL_LOGS_ENABLED: 'yes' })),
    /must be true or false/
  );
  assert.throws(
    () => parseLogExportConfig(validEnv({ VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_HEADERS_JSON: '{"cookie":"secret"}' })),
    /Only authorization and x-api-key/
  );
  assert.throws(
    () => parseLogExportConfig(validEnv({ VIRGOSCORPIO_HUB_OTEL_EXPORT_TIMEOUT_MS: '25' })),
    /250 to 30000/
  );
});

test('logs inherit trace exporter authentication when the logs-specific header is absent or blank', () => {
  const config = parseLogExportConfig(validEnv({
    VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_HEADERS_JSON: undefined,
    VIRGOSCORPIO_HUB_OTEL_EXPORTER_HEADERS_JSON: '{"authorization":"Bearer shared-secret"}'
  }));
  const blank = parseLogExportConfig(validEnv({
    VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_HEADERS_JSON: '',
    VIRGOSCORPIO_HUB_OTEL_EXPORTER_HEADERS_JSON: '{"authorization":"Bearer shared-secret"}'
  }));
  assert.deepEqual(blank.headers, { authorization: 'Bearer shared-secret' });
  assert.deepEqual(config.headers, { authorization: 'Bearer shared-secret' });
  const override = parseLogExportConfig(validEnv({
    VIRGOSCORPIO_HUB_OTEL_EXPORTER_HEADERS_JSON: '{"authorization":"Bearer trace-secret"}'
  }));
  assert.deepEqual(override.headers, { authorization: 'Bearer test-log-token' });
});

test('structured OTLP records retain only approved fields and carry trace/span correlation', async () => {
  const exporter = new InMemoryLogRecordExporter();
  const runtime = initializeLogExport({
    env: validEnv(),
    serviceName: 'virgoscorpio-hub-api',
    serviceVersion: '0.5.1',
    exporter
  });
  const structured = createStructuredLogger({
    logger: null,
    otelLogger: runtime.logger,
    service: 'virgoscorpio-hub-api',
    environment: 'test',
    now: () => Date.UTC(2026, 10, 1)
  });
  const traceContext = createTraceContext({ requestId: 'request-logs-1234' });

  await runWithTraceContext(traceContext, async () => {
    assert.equal(structured.emit('warn', 'virgoscorpio_hub.test.redacted_event', {
      component: 'api',
      operation: 'request',
      outcome: 'rejected',
      method: 'POST',
      route: '/api/v1/sites',
      statusCode: 403,
      elapsedMs: 4.125,
      code: 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN',
      siteId: 'private-site-id',
      email: 'private@example.invalid',
      message: 'PRIVATE MESSAGE',
      requestBody: 'PRIVATE REQUEST BODY',
      authorization: 'Bearer PRIVATE TOKEN',
      prompt: 'PRIVATE PROMPT',
      stack: 'PRIVATE STACK'
    }), true);
  });

  await runtime.forceFlush();
  const records = exporter.getFinishedLogRecords();
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.body, 'virgoscorpio_hub.test.redacted_event');
  assert.equal(record.severityText, 'WARN');
  assert.equal(record.severityNumber, 13);
  assert.equal(record.attributes['event.name'], 'virgoscorpio_hub.test.redacted_event');
  assert.equal(record.attributes['virgoscorpio_hub.component'], 'api');
  assert.equal(record.attributes['http.request.method'], 'POST');
  assert.equal(record.attributes['http.route'], '/api/v1/sites');
  assert.equal(record.attributes['http.response.status_code'], 403);
  assert.equal(record.attributes['virgoscorpio_hub.elapsed_ms'], 4.125);
  assert.equal(record.attributes['error.code'], 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN');
  assert.equal(record.attributes['virgoscorpio_hub.request_id'], 'request-logs-1234');
  assert.equal(record._spanContext.traceId, traceContext.traceId);
  assert.equal(record._spanContext.spanId, traceContext.spanId);
  assert.doesNotMatch(JSON.stringify(record), /private-site-id|private@example|PRIVATE MESSAGE|PRIVATE REQUEST BODY|PRIVATE TOKEN|PRIVATE PROMPT|PRIVATE STACK/);
  await runtime.shutdown();
});

test('OTLP HTTP log export sends one sanitized, correlated record to /v1/logs', async t => {
  const requests = [];
  const collector = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body: Buffer.concat(chunks).toString('utf8')
    });
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end();
  });
  const address = await listenLoopback(collector);
  t.after(() => closeServer(collector));

  const runtime = initializeLogExport({
    env: validEnv({
      VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT: 'http://127.0.0.1:' + address.port,
      VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP: 'true'
    }),
    serviceName: 'virgoscorpio-hub-api'
  });
  const structured = createStructuredLogger({
    logger: null,
    otelLogger: runtime.logger,
    service: 'virgoscorpio-hub-api',
    environment: 'test'
  });
  const traceContext = createTraceContext({ requestId: 'request-otlp-1234' });
  await runWithTraceContext(traceContext, async () => {
    structured.emit('info', 'virgoscorpio_hub.test.otlp_export', {
      component: 'api',
      operation: 'smoke',
      outcome: 'success',
      route: '/api/v1/health',
      method: 'GET',
      statusCode: 200,
      prompt: 'NEVER EXPORT THIS PROMPT'
    });
  });
  await runtime.forceFlush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/v1/logs');
  assert.equal(requests[0].authorization, 'Bearer test-log-token');
  assert.match(requests[0].contentType, /application\/json/);
  const payload = JSON.parse(requests[0].body);
  const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(logRecord.body.stringValue, 'virgoscorpio_hub.test.otlp_export');
  assert.equal(logRecord.traceId, traceContext.traceId);
  assert.equal(logRecord.spanId, traceContext.spanId);
  assert.equal(payload.resourceLogs[0].resource.attributes.find(item => item.key === 'service.name').value.stringValue, 'virgoscorpio-hub-api');
  assert.doesNotMatch(requests[0].body, /NEVER EXPORT THIS PROMPT|Bearer test-log-token/);
  await runtime.shutdown();
});

test('structured OTLP logs inherit the active OpenTelemetry span identity', async () => {
  const logExporter = new InMemoryLogRecordExporter();
  const traceRuntime = initializeTracing({
    env: {
      NODE_ENV: 'test',
      VIRGOSCORPIO_HUB_OTEL_ENABLED: 'true',
      VIRGOSCORPIO_HUB_OTEL_EXPORTER_ENDPOINT: 'https://collector.example/v1/traces',
      VIRGOSCORPIO_HUB_OTEL_SAMPLE_RATIO: '1'
    },
    serviceName: 'virgoscorpio-hub-api',
    exporter: {
      export(_spans, callback) { callback({ code: 0 }); },
      async shutdown() {},
      async forceFlush() {}
    }
  });
  const logRuntime = initializeLogExport({
    env: validEnv(),
    serviceName: 'virgoscorpio-hub-api',
    exporter: logExporter
  });
  const structured = createStructuredLogger({
    logger: null,
    otelLogger: logRuntime.logger,
    service: 'virgoscorpio-hub-api',
    environment: 'test'
  });
  let activeTraceContext;
  let activeSpanContext;

  await withSpan('virgoscorpio_hub.test.log_correlation', {
    'virgoscorpio_hub.component': 'test',
    'virgoscorpio_hub.operation': 'log_correlation'
  }, async () => {
    activeTraceContext = require('../packages/observability/src/trace-context').getTraceContext();
    activeSpanContext = otelTrace.getSpan(otelContext.active())?.spanContext();
    structured.emit('info', 'virgoscorpio_hub.test.correlated_log', {
      component: 'test',
      operation: 'log_correlation',
      outcome: 'success'
    });
  });

  await logRuntime.forceFlush();
  const records = logExporter.getFinishedLogRecords();
  assert.equal(records.length, 1);
  assert.ok(activeSpanContext);
  assert.equal(activeSpanContext.traceId, activeTraceContext.traceId);
  assert.equal(activeSpanContext.spanId, activeTraceContext.spanId);
  assert.equal(records[0]._spanContext.traceId, activeSpanContext.traceId);
  assert.equal(records[0]._spanContext.spanId, activeSpanContext.spanId);
  await Promise.all([traceRuntime.shutdown(), logRuntime.shutdown()]);
});

test('structured log export failures never propagate into the application path', () => {
  const structured = createStructuredLogger({
    logger: null,
    otelLogger: { emit() { throw new Error('simulated exporter failure'); } },
    service: 'virgoscorpio-hub-api'
  });
  assert.doesNotThrow(() => {
    assert.equal(structured.emit('error', 'virgoscorpio_hub.test.export_failure', {
      component: 'api',
      code: 'ERR_VIRGOSCORPIO_HUB_TEST'
    }), false);
  });
  const local = createStructuredLogger({
    logger: { error() {} },
    otelLogger: { emit() { throw new Error('simulated exporter failure'); } },
    service: 'virgoscorpio-hub-api'
  });
  assert.equal(local.emit('error', 'virgoscorpio_hub.test.local_fallback'), true);
});
