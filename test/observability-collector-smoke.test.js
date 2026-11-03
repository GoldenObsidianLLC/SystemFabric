'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configureLocalCollector } = require('../scripts/configure-otel-dev');
const { smokeTestLocalCollector } = require('../scripts/test-otel-collector');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'virgoscorpio_hub-otel-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('collector smoke test proves auth rejection and OTLP acceptance for traces and logs', async t => {
  const root = temporaryRoot(t);
  const token = 'f'.repeat(43);
  configureLocalCollector({ root, tokenFactory: () => token });
  const requests = [];

  const result = await smokeTestLocalCollector({
    root,
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { status: options.headers.authorization ? 200 : 401 };
    }
  });

  assert.deepEqual(result, {
    traceEndpoint: 'http://127.0.0.1:4318/v1/traces',
    logsEndpoint: 'http://127.0.0.1:4318/v1/logs',
    unauthenticatedTraceStatus: 401,
    authenticatedTraceStatus: 200,
    unauthenticatedLogsStatus: 401,
    authenticatedLogsStatus: 200,
    spansSubmitted: 1,
    logsSubmitted: 1
  });
  assert.equal(requests.length, 4);
  assert.equal(requests[0].url, 'http://127.0.0.1:4318/v1/traces');
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.equal(requests[1].options.headers.authorization, 'Bearer ' + token);
  assert.equal(requests[2].url, 'http://127.0.0.1:4318/v1/logs');
  assert.equal(requests[2].options.headers.authorization, undefined);
  assert.equal(requests[3].options.headers.authorization, 'Bearer ' + token);
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);

  const tracePayload = JSON.parse(requests[1].options.body);
  assert.equal(tracePayload.resourceSpans[0].scopeSpans[0].spans[0].name, 'collector.authenticated_smoke');
  assert.equal(tracePayload.resourceSpans[0].scopeSpans[0].spans.length, 1);
  const logsPayload = JSON.parse(requests[3].options.body);
  assert.equal(logsPayload.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'virgoscorpio_hub.observability.logs_smoke');
  assert.equal(logsPayload.resourceLogs[0].scopeLogs[0].logRecords.length, 1);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('collector smoke test never sends traces or logs to endpoints other than loopback', async t => {
  const root = temporaryRoot(t);
  configureLocalCollector({ root, tokenFactory: () => 'g'.repeat(43) });
  const envFile = path.join(root, '.env');
  const env = fs.readFileSync(envFile, 'utf8');
  fs.writeFileSync(envFile, env.replace(
    'VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT=http://127.0.0.1:4318/v1/logs',
    'VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT=https://external.example/v1/logs'
  ));

  let calls = 0;
  await assert.rejects(
    smokeTestLocalCollector({
      root,
      fetchImpl: async () => { calls += 1; return { status: 200 }; }
    }),
    /fixed loopback OTLP endpoint/
  );
  assert.equal(calls, 0);
});

test('collector smoke test refuses mismatched and missing bearer token files', async t => {
  const root = temporaryRoot(t);
  const setup = configureLocalCollector({ root, tokenFactory: () => 'h'.repeat(43) });
  fs.writeFileSync(setup.secretFile, 'i'.repeat(43) + '\n');

  let calls = 0;
  await assert.rejects(
    smokeTestLocalCollector({
      root,
      fetchImpl: async () => { calls += 1; return { status: 200 }; }
    }),
    /do not match/
  );
  assert.equal(calls, 0);
});

test('collector smoke test fails when the receiver accepts unauthenticated requests', async t => {
  const root = temporaryRoot(t);
  configureLocalCollector({ root, tokenFactory: () => 'j'.repeat(43) });

  await assert.rejects(
    smokeTestLocalCollector({
      root,
      fetchImpl: async () => ({ status: 200 })
    }),
    /must reject requests without bearer authentication/
  );
});
