'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { createTraceContext, runWithTraceContext, getTraceContext } = require('../packages/observability/src/trace-context');
const {
  initializeTracing,
  parseTracingConfig,
  parseExporterHeaders,
  sanitizeAttributes,
  runWithServerSpan,
  withSpan,
  instrumentPostgresPool,
  instrumentRedisClient,
  sqlOperation
} = require('../packages/observability/src/tracing');
const { createGraphProjectionWorker, GRAPH_PROJECTION_EVENT_TYPES } = require('../apps/worker/src/outbox-worker');
const { createMemgraphProjector } = require('../packages/graph/src/memgraph-store');
const { createPluginRunnerServer } = require('../apps/plugin-runner/src/server');
const { createRemotePluginRunner } = require('../packages/plugins/src/remote-runner');

class RetainingInMemorySpanExporter extends InMemorySpanExporter {
  shutdown() { return this.forceFlush(); }
}

const validEnv = overrides => ({
  NODE_ENV: 'test',
  SYSTEMFABRIC_OTEL_ENABLED: 'true',
  SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: 'https://collector.example/v1/traces',
  SYSTEMFABRIC_OTEL_SAMPLE_RATIO: '1',
  ...overrides
});

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

test('instrumented PostgreSQL callback queries remain functional before tracing is initialized', async () => {
  const client = {
    query(_statement, callback) {
      queueMicrotask(() => callback(null, { rows: [{ ok: true }] }));
    }
  };
  const pool = {
    connect(callback) {
      callback(null, client, () => {});
    }
  };
  instrumentPostgresPool(pool);

  const result = await new Promise((resolve, reject) => {
    pool.connect((error, connected) => {
      if (error) return reject(error);
      connected.query('SELECT 1', (queryError, queryResult) => {
        if (queryError) return reject(queryError);
        resolve(queryResult);
      });
    });
  });
  assert.deepEqual(result.rows, [{ ok: true }]);
});

test('OpenTelemetry is disabled by default and does not require an exporter endpoint', () => {
  const config = parseTracingConfig({}, 'systemfabric-api');
  assert.equal(config.enabled, false);
  assert.equal(config.endpoint, null);
  assert.equal(config.sampleRatio, 0.1);
  assert.equal(config.timeoutMs, 5000);
});

test('OTLP endpoint validation requires an explicit secure endpoint when enabled', () => {
  assert.throws(
    () => parseTracingConfig(validEnv({ SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: '' })),
    /required when OpenTelemetry is enabled/
  );
  assert.throws(
    () => parseTracingConfig(validEnv({ SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: 'http://collector.example/v1/traces' })),
    /must use HTTPS/
  );
  assert.throws(
    () => parseTracingConfig(validEnv({ SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: 'https://user:secret@collector.example/v1/traces' })),
    /must not contain credentials/
  );
  assert.throws(
    () => parseTracingConfig(validEnv({ SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: 'https://collector.example/v1/traces?token=secret' })),
    /must not contain credentials/
  );
  assert.throws(
    () => parseTracingConfig(validEnv({ SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: 'https://collector.example/custom' })),
    /path must be \/v1\/traces or omitted/
  );
  assert.equal(
    parseTracingConfig(validEnv({
      SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
      SYSTEMFABRIC_OTEL_ALLOW_INSECURE_HTTP: 'true'
    })).endpoint,
    'http://127.0.0.1:4318/v1/traces'
  );
  assert.equal(
    parseTracingConfig(validEnv({
      SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: 'https://collector.example'
    })).endpoint,
    'https://collector.example/v1/traces'
  );
});

test('OTLP exporter authentication headers are narrowly allow-listed and never become attributes', () => {
  assert.deepEqual(parseExporterHeaders('{"authorization":"Bearer secret","x-api-key":"secret-key"}'), {
    authorization: 'Bearer secret',
    'x-api-key': 'secret-key'
  });
  assert.throws(() => parseExporterHeaders('{"cookie":"session"}'), /Only authorization and x-api-key/);
  assert.throws(() => parseExporterHeaders('{"authorization":"Bearer secret\\r\\nX-Injected: yes"}'), /control characters/);
  assert.throws(() => parseExporterHeaders('[]'), /JSON object/);
});

test('sampling ratio, timeout, and service identity are bounded', () => {
  assert.throws(() => parseTracingConfig(validEnv({ SYSTEMFABRIC_OTEL_SAMPLE_RATIO: '1.1' })), /between 0 and 1/);
  assert.throws(() => parseTracingConfig(validEnv({ SYSTEMFABRIC_OTEL_SAMPLE_RATIO: 'NaN' })), /between 0 and 1/);
  assert.throws(() => parseTracingConfig(validEnv({ SYSTEMFABRIC_OTEL_EXPORT_TIMEOUT_MS: '50' })), /250 to 30000/);
  assert.throws(() => parseTracingConfig(validEnv(), 'SystemFabric API'), /service name is invalid/);
});

test('span attributes are restricted to low-cardinality operational fields', () => {
  const attributes = sanitizeAttributes({
    'systemfabric.component': 'database',
    'systemfabric.operation': 'query',
    'db.system': 'postgresql',
    'db.operation.name': 'SELECT',
    'http.request.method': 'GET',
    'http.response.status_code': 200,
    'db.statement': 'SELECT * FROM users',
    'db.query.text': 'sensitive SQL',
    'enduser.id': 'user-123',
    'systemfabric.site_id': 'site-secret',
    'error.message': 'sensitive error message'
  });
  assert.deepEqual(attributes, {
    'systemfabric.component': 'database',
    'systemfabric.operation': 'query',
    'db.system': 'postgresql',
    'db.operation.name': 'select',
    'http.request.method': 'GET',
    'http.response.status_code': 200
  });
});

test('SQL operation classification never returns statement text or values', () => {
  assert.equal(sqlOperation('SELECT * FROM users WHERE email = $1'), 'select');
  assert.equal(sqlOperation('INSERT INTO private_table (secret) VALUES ($1)'), 'insert');
  assert.equal(sqlOperation({ text: 'UPDATE accounts SET secret = $1' }), 'update');
  assert.equal(sqlOperation('CREATE TABLE tenant_data (id int)'), 'other');
  assert.equal(sqlOperation('not SQL'), 'other');
});

test('manual server, databases, worker and plugin-runner spans export one redacted trace over OTLP', async () => {
  const collectorRequests = [];
  const collector = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    collectorRequests.push({
      method: req.method,
      path: req.url,
      contentType: req.headers['content-type'],
      authorization: req.headers.authorization,
      bodyBytes: Buffer.byteLength(body),
      body
    });
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end();
  });
  const collectorAddress = await listenLoopback(collector);
  const memoryExporter = new RetainingInMemorySpanExporter();
  const otlpExporter = new OTLPTraceExporter({
    url: 'http://127.0.0.1:' + collectorAddress.port + '/v1/traces',
    headers: { authorization: 'Bearer test-collector-secret' },
    timeoutMillis: 5000
  });
  const exporter = {
    export(spans, callback) {
      memoryExporter.export(spans, result => {
        if (result.code !== 0) return callback(result);
        otlpExporter.export(spans, callback);
      });
    },
    forceFlush() { return Promise.resolve(); },
    shutdown() {
      return Promise.all([memoryExporter.shutdown(), otlpExporter.shutdown()]);
    }
  };
  const runtime = initializeTracing({
    env: validEnv({
      SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: 'http://127.0.0.1:' + collectorAddress.port,
      SYSTEMFABRIC_OTEL_ALLOW_INSECURE_HTTP: 'true'
    }),
    serviceName: 'systemfabric-observability-test',
    exporter
  });
  const request = createTraceContext({ requestId: 'test-request-123' });
  const client = {
    async query(statement, values) {
      assert.match(statement, /private_table/);
      assert.deepEqual(values, ['private-value']);
      return { rows: [] };
    }
  };
  const pool = {
    async connect() { return client; }
  };
  instrumentPostgresPool(pool);
  const redisCalls = [];
  const redis = {
    async eval(key, command, payload) {
      redisCalls.push([key, command, payload]);
      return 'OK';
    },
    async publish(channel, payload) {
      redisCalls.push([channel, payload]);
      return 1;
    }
  };
  instrumentRedisClient(redis);

  const pluginToken = 'plugin-runner-observability-test-token-123456';
  const pluginImageDigest = 'registry.example/plugin@sha256:' + 'a'.repeat(64);
  const pluginServer = createPluginRunnerServer({
    env: {
      NODE_ENV: 'test',
      SYSTEMFABRIC_PLUGIN_RUNNER_TOKEN: pluginToken,
      SYSTEMFABRIC_PLUGIN_ALLOWED_IMAGES: pluginImageDigest
    },
    runner: {
      async invoke(input) {
        assert.equal(input.action, 'observability.test');
        assert.equal(input.input.privateValue, 'plugin-private-payload');
        return { accepted: true };
      }
    },
    logger: { info() {}, warn() {}, error() {} }
  });
  const pluginAddress = await listenLoopback(pluginServer);
  const remotePluginRunner = createRemotePluginRunner({
    url: 'http://127.0.0.1:' + pluginAddress.port,
    token: pluginToken,
    allowHttpInternal: true
  });

  let serverSpanContext;
  let requestTraceId;
  try {
    await runWithServerSpan(request, async span => {
    serverSpanContext = span.spanContext();
    requestTraceId = getTraceContext().traceId;
    assert.equal(getTraceContext().spanId, serverSpanContext.spanId);
    const acquiredClient = await pool.connect();
    await acquiredClient.query('SELECT secret FROM private_table WHERE value = $1', ['private-value']);
    await withSpan('realtime.redis.operation', {
      'systemfabric.component': 'redis',
      'systemfabric.operation': 'eval'
    }, () => redis.eval('site-secret-key', 'secret-script', 'private-payload'));
    await redis.publish('site:secret:channel', 'private-payload');
    const pluginResult = await remotePluginRunner.invoke({
      imageDigest: pluginImageDigest,
      action: 'observability.test',
      input: { privateValue: 'plugin-private-payload' },
      requestId: 'test-request-123'
    });
    assert.deepEqual(pluginResult, { accepted: true });

    const graphStatements = [];
    const graphDriver = {
      session() {
        return {
          async executeWrite(callback) {
            return callback({
              async run(statement, params) {
                graphStatements.push({ statement, params });
                return { records: [] };
              }
            });
          },
          async close() {}
        };
      }
    };
    const graphProjector = createMemgraphProjector({ driver: graphDriver });
    const siteId = '11111111-1111-4111-8111-111111111111';
    const contentId = '22222222-2222-4222-8222-222222222222';
    const outboxEvent = {
      id: '33333333-3333-4333-8333-333333333333',
      aggregate_type: 'content',
      aggregate_id: contentId,
      aggregate_version: 1,
      event_type: 'content.upsert',
      payload: {
        id: contentId,
        siteId,
        contentType: 'page',
        slug: 'trace-test',
        locale: 'en',
        status: 'draft',
        title: 'private-content-title',
        version: 1
      },
      schema_version: 1,
      site_id: siteId,
      actor_id: null,
      correlation_id: null,
      causation_id: null,
      classification: 'site-private',
      created_at: new Date().toISOString(),
      delivery_attempts: 1
    };
    const outboxPool = {
      async query(statement) {
        if (statement.includes('INSERT INTO outbox_consumer_groups')) return { rows: [], rowCount: 1 };
        if (statement.includes('SELECT event_types FROM outbox_consumer_groups')) {
          return { rows: [{ event_types: GRAPH_PROJECTION_EVENT_TYPES }], rowCount: 1 };
        }
        if (statement.includes('INSERT INTO outbox_deliveries(event_id')) return { rows: [], rowCount: 1 };
        if (statement.includes('WITH candidates AS')) return { rows: [outboxEvent], rowCount: 1 };
        if (statement.includes("SET status = 'processed'")) return { rows: [], rowCount: 1 };
        throw new Error('Unexpected outbox test query.');
      }
    };
    const graphWorker = createGraphProjectionWorker({
      pool: outboxPool,
      projector: graphProjector
    });
    const workerResult = await graphWorker.runOnce();
    assert.equal(workerResult.claimed, 1);
    assert.equal(workerResult.results[0].ok, true);
    assert.equal(graphStatements.length, 1);

    const callbackClient = {
      query(_statement, valuesOrCallback, callback) {
        const done = typeof callback === 'function' ? callback : valuesOrCallback;
        queueMicrotask(() => done(null, { rows: [] }));
      }
    };
    const callbackPool = {
      connect(callback) { callback(null, callbackClient, () => {}); },
      query(statement, values) {
        return new Promise((resolve, reject) => {
          this.connect((error, connected, release) => {
            if (error) return reject(error);
            connected.query(statement, values, (queryError, result) => {
              release();
              if (queryError) return reject(queryError);
              resolve(result);
            });
          });
        });
      }
    };
    instrumentPostgresPool(callbackPool);
    const callbackResult = await callbackPool.query('DELETE FROM private_table WHERE id = $1', ['private-value']);
    assert.deepEqual(callbackResult.rows, []);

    const failedPool = {
      async connect() {
        return {
          async query() {
            const error = new Error('private database failure detail');
            error.code = 'ERR_DATABASE_UNAVAILABLE';
            throw error;
          }
        };
      }
    };
    instrumentPostgresPool(failedPool);
    await assert.rejects(
      (async () => (await failedPool.connect()).query('SELECT secret FROM private_table', ['private-value']))(),
      /private database failure detail/
    );
  }, {
    'systemfabric.component': 'api',
    'systemfabric.operation': 'test_request',
    'http.request.method': 'POST'
    });
  } finally {
    await runtime.shutdown();
    await Promise.all([closeServer(pluginServer), closeServer(collector)]);
  }

  const spans = memoryExporter.getFinishedSpans();
  const server = spans.find(span => span.kind === 1 && span.attributes['systemfabric.component'] === 'api');
  const postgres = spans.find(span => span.name === 'db.postgresql.query');
  const redisEval = spans.find(span => span.name === 'db.redis.eval');
  const redisPublish = spans.find(span => span.name === 'db.redis.publish');
  const outboxRun = spans.find(span => span.name === 'outbox.run_once');
  const outboxEventSpan = spans.find(span => span.name === 'outbox.process_event');
  const graphProjection = spans.find(span => span.name === 'graph.projection.apply');
  const memgraphWrite = spans.find(span => span.name === 'db.memgraph.write');
  const failedQuery = spans.find(span => span.attributes['error.code'] === 'ERR_DATABASE_UNAVAILABLE');
  const pluginClient = spans.find(span => span.name === 'plugin_runner.invoke');
  const pluginServerSpan = pluginClient && spans.find(span =>
    span.kind === 1 && span.parentSpanContext?.spanId === pluginClient.spanContext().spanId
  );
  assert.ok(server, 'server span should be exported');
  assert.ok(postgres, 'PostgreSQL span should be exported');
  assert.ok(redisEval, 'Redis EVAL span should be exported');
  assert.ok(redisPublish, 'Redis PUBLISH span should be exported');
  assert.ok(outboxRun, 'outbox run span should be exported');
  assert.ok(outboxEventSpan, 'outbox event span should be exported');
  assert.ok(graphProjection, 'graph projection span should be exported');
  assert.ok(memgraphWrite, 'Memgraph write span should be exported');
  assert.ok(failedQuery, 'failed database span should be exported');
  assert.ok(pluginClient, 'plugin-runner client span should be exported');
  assert.ok(pluginServerSpan, 'authenticated plugin-runner server span should be exported');
  assert.equal(failedQuery.status.code, 2);
  assert.equal(collectorRequests.length > 0, true, 'OTLP exporter should send a trace batch');
  assert.equal(collectorRequests[0].method, 'POST');
  assert.equal(collectorRequests[0].path, '/v1/traces');
  assert.match(collectorRequests[0].contentType, /application\/(json|x-protobuf)/i);
  assert.equal(collectorRequests[0].authorization, 'Bearer test-collector-secret');
  assert.ok(collectorRequests[0].bodyBytes > 0);
  if (collectorRequests[0].contentType.includes('json')) {
    assert.ok(JSON.parse(collectorRequests[0].body).resourceSpans?.length > 0);
  }
  assert.doesNotMatch(
    collectorRequests.map(request => request.body).join(''),
    /private-value|private-payload|site-secret|private_table|private-content-title|private database failure detail|plugin-private-payload/i
  );

  for (const span of spans) assert.equal(span.spanContext().traceId, requestTraceId);
  assert.equal(server.spanContext().spanId, serverSpanContext.spanId);
  assert.equal(pluginClient.parentSpanContext.spanId, server.spanContext().spanId);
  assert.equal(pluginServerSpan.parentSpanContext.spanId, pluginClient.spanContext().spanId);
  assert.equal(pluginClient.kind, 2, 'service-to-service invocation is a CLIENT span');
  assert.equal(postgres.kind, 2, 'PostgreSQL queries are CLIENT spans');
  assert.equal(redisEval.kind, 2, 'Redis operations are CLIENT spans');
  assert.equal(memgraphWrite.kind, 2, 'Memgraph operations are CLIENT spans');
  assert.equal(postgres.parentSpanContext.spanId, server.spanContext().spanId);
  assert.equal(outboxRun.parentSpanContext.spanId, server.spanContext().spanId);
  assert.equal(outboxEventSpan.parentSpanContext.spanId, outboxRun.spanContext().spanId);
  assert.equal(graphProjection.parentSpanContext.spanId, outboxEventSpan.spanContext().spanId);
  assert.equal(memgraphWrite.parentSpanContext.spanId, graphProjection.spanContext().spanId);
  assert.equal(redisEval.attributes['db.system'], 'redis');
  assert.equal(redisEval.attributes['db.operation.name'], 'eval');
  assert.equal(postgres.attributes['db.system'], 'postgresql');
  assert.equal(postgres.attributes['db.operation.name'], 'select');
  for (const span of spans) {
    const serialized = JSON.stringify(span.attributes);
    assert.doesNotMatch(serialized, /private-value|private-payload|site-secret|private_table|private-content-title|private database failure detail|plugin-private-payload/i);
  }
  assert.equal(redisCalls.length, 2);
});
