'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile } = require('./load-env');
const { readRegularFile } = require('./configure-otel-dev');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const LOCAL_COLLECTOR_URL = 'http://127.0.0.1:4318/v1/traces';

function readLocalCollectorConfig(root) {
  const env = Object.create(null);
  loadEnvFile(path.join(root, '.env'), env);
  if (env.SYSTEMFABRIC_OTEL_ENABLED !== 'true') {
    throw new Error('SYSTEMFABRIC_OTEL_ENABLED=true is required in the local .env.');
  }

  const endpoint = new URL(env.SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT || '');
  if (endpoint.toString() !== LOCAL_COLLECTOR_URL) {
    throw new Error('The smoke test only sends requests to the fixed loopback OTLP endpoint 127.0.0.1:4318/v1/traces.');
  }

  const relativeSecretPath = env.SYSTEMFABRIC_OTEL_AUTH_TOKEN_FILE ||
    './var/secrets/otel-collector-token.txt';
  if (path.isAbsolute(relativeSecretPath)) {
    throw new Error('The local collector token path must be relative to the repository root.');
  }
  const rootRealPath = fs.realpathSync(root);
  const secretFile = path.resolve(rootRealPath, relativeSecretPath);
  const rootPrefix = rootRealPath + path.sep;
  if (!secretFile.startsWith(rootPrefix)) {
    throw new Error('The local collector token path must remain inside the repository root.');
  }

  const token = readRegularFile(rootRealPath, secretFile).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('The local collector token file is invalid; rerun npm run otel:dev:setup.');
  }

  let exporterHeaders;
  try {
    exporterHeaders = JSON.parse(env.SYSTEMFABRIC_OTEL_EXPORTER_HEADERS_JSON || '');
  } catch {
    throw new Error('The local exporter authorization header is missing or invalid; rerun npm run otel:dev:setup.');
  }
  if (!exporterHeaders || typeof exporterHeaders !== 'object' || Array.isArray(exporterHeaders) ||
      Object.keys(exporterHeaders).length !== 1 || typeof exporterHeaders.authorization !== 'string') {
    throw new Error('The local collector profile supports only its generated bearer authorization header.');
  }
  if (exporterHeaders.authorization !== 'Bearer ' + token) {
    throw new Error('The local exporter authorization header and collector token file do not match; rerun npm run otel:dev:setup.');
  }

  return Object.freeze({ endpoint: endpoint.toString(), authorization: exporterHeaders.authorization });
}

function createSmokePayload(now = Date.now()) {
  const start = BigInt(now) * 1_000_000n;
  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');
  return {
    resourceSpans: [{
      resource: {
        attributes: [{
          key: 'service.name',
          value: { stringValue: 'systemfabric-local-collector-smoke' }
        }]
      },
      scopeSpans: [{
        scope: { name: 'systemfabric.local-collector-smoke' },
        spans: [{
          traceId,
          spanId,
          name: 'collector.authenticated_smoke',
          kind: 1,
          startTimeUnixNano: start.toString(),
          endTimeUnixNano: (start + 1_000_000n).toString()
        }]
      }]
    }]
  };
}

/**
 * Verify unauthenticated OTLP requests are rejected and a minimal authenticated
 * OTLP JSON span is accepted by the loopback development collector.
 * The token is never returned or printed.
 */
async function smokeTestLocalCollector({
  root = path.resolve(__dirname, '..'),
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  now = Date.now
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Node.js fetch is required for the collector smoke test.');
  const config = readLocalCollectorConfig(root);
  const payload = JSON.stringify(createSmokePayload(now()));
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload
  };

  async function send(headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await fetchImpl(config.endpoint, {
        ...request,
        headers: { ...request.headers, ...headers },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const unauthenticated = await send({});
  if (unauthenticated.status !== 401) {
    throw new Error('The local collector must reject requests without bearer authentication (expected HTTP 401).');
  }

  const authenticated = await send({ authorization: config.authorization });
  if (authenticated.status !== 200) {
    throw new Error('The local collector did not accept the authenticated OTLP smoke span (expected HTTP 200).');
  }

  return Object.freeze({
    endpoint: config.endpoint,
    unauthenticatedStatus: unauthenticated.status,
    authenticatedStatus: authenticated.status,
    spansSubmitted: 1
  });
}

if (require.main === module) {
  smokeTestLocalCollector().then(result => {
    console.log('Local OTLP collector smoke test passed.');
    console.log('Unauthenticated request rejected: HTTP ' + result.unauthenticatedStatus);
    console.log('Authenticated OTLP span accepted: HTTP ' + result.authenticatedStatus);
    console.log('Inspect the debug exporter with: docker compose --profile observability logs -f otel-collector');
  }).catch(error => {
    console.error('Local OTLP collector smoke test failed: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { readLocalCollectorConfig, createSmokePayload, smokeTestLocalCollector };
