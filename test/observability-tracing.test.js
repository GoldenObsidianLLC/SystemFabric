'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTraceparent,
  createTraceContext,
  getTraceContext,
  getTraceparent,
  runWithTraceContext,
  createChildTraceContext,
  runWithChildTraceContext
} = require('../packages/observability/src/trace-context');
const { createStructuredLogger } = require('../packages/observability/src/structured-logger');
const { createApiServer } = require('../apps/api/src/server');
const { createRemotePluginRunner } = require('../packages/plugins/src/remote-runner');
const { createPluginRunnerServer } = require('../apps/plugin-runner/src/server');

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const PARENT_SPAN_ID = '0123456789abcdef';
const TRACEPARENT = '00-' + TRACE_ID + '-' + PARENT_SPAN_ID + '-01';
const API_TOKEN = 'observability-trace-test-token';

async function withServer(fn, envExtra = {}, logger = { error() {} }) {
  const server = createApiServer({
    env: {
      NODE_ENV: 'test',
      VIRGOSCORPIO_HUB_API_TOKEN: API_TOKEN,
      AI_PROVIDER: 'mock',
      MAX_REQUEST_BYTES: '16384',
      RATE_LIMIT_MAX_REQUESTS: '100',
      ...envExtra
    },
    logger
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.virgoScorpioHub.close();
  }
}

test('W3C traceparent parser accepts v00 and rejects malformed or zero identifiers', () => {
  assert.deepEqual(parseTraceparent(TRACEPARENT), {
    traceId: TRACE_ID,
    parentSpanId: PARENT_SPAN_ID,
    traceFlags: '01'
  });
  assert.equal(parseTraceparent('00-' + '0'.repeat(32) + '-' + PARENT_SPAN_ID + '-01'), null);
  assert.equal(parseTraceparent('00-' + TRACE_ID + '-' + '0'.repeat(16) + '-01'), null);
  assert.equal(parseTraceparent('ff-' + TRACE_ID + '-' + PARENT_SPAN_ID + '-01'), null);
  assert.equal(parseTraceparent('00-' + TRACE_ID + '-' + PARENT_SPAN_ID + '-gg'), null);
  assert.equal(parseTraceparent(TRACEPARENT + ', ' + TRACEPARENT), null);
  assert.equal(parseTraceparent({ value: TRACEPARENT }), null);
});

test('trace context only adopts a remote parent when explicitly trusted', () => {
  const untrusted = createTraceContext({ requestId: 'request-1234', incomingTraceparent: TRACEPARENT });
  assert.notEqual(untrusted.traceId, TRACE_ID);
  assert.equal(untrusted.parentSpanId, null);
  assert.equal(untrusted.remoteParentAccepted, false);
  assert.match(untrusted.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);

  const trusted = createTraceContext({
    requestId: 'request-1234',
    incomingTraceparent: TRACEPARENT,
    trustRemote: true
  });
  assert.equal(trusted.traceId, TRACE_ID);
  assert.equal(trusted.parentSpanId, PARENT_SPAN_ID);
  assert.equal(trusted.remoteParentAccepted, true);
  assert.match(trusted.traceparent, new RegExp('^00-' + TRACE_ID + '-[0-9a-f]{16}-01$'));
});

test('AsyncLocalStorage isolates concurrent requests and creates child span parent links', async () => {
  const left = createTraceContext({ requestId: 'request-left' });
  const right = createTraceContext({ requestId: 'request-right' });
  const values = await Promise.all([
    runWithTraceContext(left, async () => {
      await new Promise(resolve => setTimeout(resolve, 8));
      const child = createChildTraceContext();
      const childValue = await runWithTraceContext(child, async () => {
        await Promise.resolve();
        return { trace: getTraceContext(), header: getTraceparent() };
      });
      return { parent: getTraceContext(), childValue };
    }),
    runWithTraceContext(right, async () => {
      await new Promise(resolve => setTimeout(resolve, 2));
      return getTraceContext();
    })
  ]);

  assert.equal(values[0].parent.traceId, left.traceId);
  assert.equal(values[0].childValue.trace.traceId, left.traceId);
  assert.equal(values[0].childValue.trace.parentSpanId, left.spanId);
  assert.equal(values[0].childValue.header, values[0].childValue.trace.traceparent);
  assert.equal(values[1].traceId, right.traceId);
  assert.notEqual(values[0].parent.traceId, values[1].traceId);
  assert.equal(getTraceContext(), null);

  const fromHelper = await runWithTraceContext(left, async () =>
    runWithChildTraceContext(async () => getTraceContext())
  );
  assert.equal(fromHelper.traceId, left.traceId);
  assert.equal(fromHelper.parentSpanId, left.spanId);
});

test('structured logger allow-lists correlation fields and excludes unapproved data', async () => {
  const records = [];
  const output = createStructuredLogger({
    logger: { info: line => records.push(JSON.parse(line)) },
    service: 'virgoscorpio-hub-api',
    environment: 'test',
    accessLogsEnabled: true,
    now: () => Date.UTC(2026, 10, 1)
  });
  const context = createTraceContext({ requestId: 'request-5678' });
  await runWithTraceContext(context, async () => {
    output.requestCompleted({
      requestId: 'request-5678',
      method: 'GET',
      route: '/api/v1/sites',
      statusCode: 200,
      elapsedMs: 3.25,
      siteId: 'sensitive-site-id',
      email: 'private@example.com',
      authorization: 'Bearer secret',
      message: 'must not appear'
    });
  });

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.event, 'virgoscorpio_hub.http.request_completed');
  assert.equal(record.traceId, context.traceId);
  assert.equal(record.spanId, context.spanId);
  assert.equal(record.requestId, 'request-5678');
  assert.equal(record.route, '/api/v1/sites');
  assert.equal(record.statusClass, '2xx');
  assert.equal(record.elapsedMs, 3.25);
  assert.equal('siteId' in record, false);
  assert.equal('email' in record, false);
  assert.equal('authorization' in record, false);
  assert.equal('message' in record, false);
  assert.doesNotMatch(JSON.stringify(record), /private@example.com|Bearer secret|sensitive-site-id/);
});

test('API starts a new trace by default and emits privacy-safe completion records when enabled', async () => {
  const records = [];
  const logger = {
    info: line => records.push(JSON.parse(line)),
    error: line => records.push(JSON.parse(line))
  };
  await withServer(async base => {
    const response = await fetch(base + '/api/v1/ai/status', {
      headers: {
        authorization: 'Bearer ' + API_TOKEN,
        traceparent: TRACEPARENT,
        'x-request-id': 'request-5678'
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'request-5678');
    const traceId = response.headers.get('x-trace-id');
    assert.match(traceId, /^[0-9a-f]{32}$/);
    assert.notEqual(traceId, TRACE_ID);
    await response.arrayBuffer();
  }, { VIRGOSCORPIO_HUB_HTTP_ACCESS_LOGS_ENABLED: 'true' }, logger);

  const completed = records.find(record => record.event === 'virgoscorpio_hub.http.request_completed');
  assert.ok(completed);
  assert.equal(completed.requestId, 'request-5678');
  assert.notEqual(completed.traceId, TRACE_ID);
  assert.equal(completed.route, '/api/v1/ai');
  assert.equal(completed.statusCode, 200);
  assert.ok(completed.spanId);
});

test('API accepts a remote traceparent only behind the explicit trusted-ingress setting', async () => {
  const records = [];
  const logger = { info: line => records.push(JSON.parse(line)), error() {} };
  await withServer(async base => {
    const response = await fetch(base + '/api/v1/ai/status', {
      headers: {
        authorization: 'Bearer ' + API_TOKEN,
        traceparent: TRACEPARENT
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-trace-id'), TRACE_ID);
    await response.arrayBuffer();
  }, {
    VIRGOSCORPIO_HUB_TRACE_CONTEXT_TRUST_REMOTE: 'true',
    VIRGOSCORPIO_HUB_HTTP_ACCESS_LOGS_ENABLED: 'true'
  }, logger);

  const completed = records.find(record => record.event === 'virgoscorpio_hub.http.request_completed');
  assert.equal(completed.traceId, TRACE_ID);
  assert.equal(completed.parentSpanId, PARENT_SPAN_ID);
  assert.notEqual(completed.spanId, PARENT_SPAN_ID);
});

test('API error records carry trace correlation without raw messages or route identifiers', async () => {
  const records = [];
  const logger = { info: line => records.push(JSON.parse(line)), error: line => records.push(JSON.parse(line)) };
  await withServer(async base => {
    const response = await fetch(base + '/api/v1/ai/content-assist', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + API_TOKEN,
        'content-type': 'application/json',
        traceparent: TRACEPARENT
      },
      body: '{invalid-json'
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'ERR_VIRGOSCORPIO_HUB_INVALID_JSON');
  }, {
    VIRGOSCORPIO_HUB_TRACE_CONTEXT_TRUST_REMOTE: 'true',
    VIRGOSCORPIO_HUB_HTTP_ACCESS_LOGS_ENABLED: 'true'
  }, logger);

  const errorRecord = records.find(record => record.event === 'virgoscorpio_hub.http.error');
  assert.ok(errorRecord);
  assert.equal(errorRecord.traceId, TRACE_ID);
  assert.equal(errorRecord.route, '/api/v1/ai');
  assert.equal(errorRecord.code, 'ERR_VIRGOSCORPIO_HUB_INVALID_JSON');
  assert.equal('message' in errorRecord, false);
  assert.doesNotMatch(JSON.stringify(errorRecord), /invalid-json|content-assist/);
});

test('remote plugin runner forwards the current trace context, but sends none outside a request', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(options);
    return { ok: true, async json() { return { result: { accepted: true } }; } };
  };
  try {
    const runner = createRemotePluginRunner({
      url: 'https://plugin-runner.internal',
      token: 'x'.repeat(40),
      timeoutMs: 1_000
    });
    const context = createTraceContext({ requestId: 'request-plugin' });
    await runWithTraceContext(context, async () => runner.invoke({ action: 'validate' }));
    await runner.invoke({ action: 'validate' });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.traceparent, context.traceparent);
    assert.equal(requests[0].headers['x-request-id'], 'request-plugin');
    assert.equal('traceparent' in requests[1].headers, false);
    assert.equal(requests[0].headers.authorization, 'Bearer ' + 'x'.repeat(40));
  } finally {
    global.fetch = originalFetch;
  }
});


test('authenticated plugin-runner hop continues the trace and emits correlated structured logs', async () => {
  const token = 'plugin-runner-observability-test-token-123456';
  const imageDigest = 'registry.example/plugin@sha256:' + 'a'.repeat(64);
  const records = [];
  const server = createPluginRunnerServer({
    env: {
      NODE_ENV: 'test',
      VIRGOSCORPIO_HUB_PLUGIN_RUNNER_TOKEN: token,
      VIRGOSCORPIO_HUB_PLUGIN_ALLOWED_IMAGES: imageDigest
    },
    runner: { async invoke() { return { completed: true }; } },
    logger: { info: line => records.push(JSON.parse(line)), error: line => records.push(JSON.parse(line)) }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const unauthorized = await fetch(base + '/v1/invoke', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token', traceparent: TRACEPARENT, 'content-type': 'application/json' },
      body: JSON.stringify({ imageDigest, action: 'validate', input: {} })
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('x-trace-id'), null, 'an unauthenticated caller cannot establish the runner trace parent');

    const response = await fetch(base + '/v1/invoke', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        traceparent: TRACEPARENT,
        'x-request-id': 'request-plugin-hop',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ imageDigest, action: 'validate', input: {} })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-trace-id'), TRACE_ID);
    assert.deepEqual(await response.json(), { result: { completed: true } });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  const invocation = records.find(record => record.event === 'virgoscorpio_hub.plugin_runner.invocation_completed');
  assert.ok(invocation);
  assert.equal(invocation.traceId, TRACE_ID);
  assert.equal(invocation.parentSpanId, PARENT_SPAN_ID);
  assert.equal(invocation.requestId, 'request-plugin-hop');
  assert.equal(invocation.outcome, 'success');
  assert.equal(invocation.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(invocation), /validate|registry\.example|Bearer/);
});
