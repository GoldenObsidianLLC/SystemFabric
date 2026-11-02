'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile } = require('./load-env');
const { readRegularFile } = require('./configure-otel-dev');

const LOCAL_TRACE_URL = 'http://127.0.0.1:4318/v1/traces';
const LOCAL_LOGS_URL = 'http://127.0.0.1:4318/v1/logs';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

function readLocalCollectorConfig(root) {
  const env = Object.create(null);
  loadEnvFile(path.join(root, '.env'), env);
  if (env.SYSTEMFABRIC_OTEL_ENABLED !== 'true' ||
      env.SYSTEMFABRIC_OTEL_LOGS_ENABLED !== 'true') {
    throw new Error('SYSTEMFABRIC_OTEL_ENABLED=true and SYSTEMFABRIC_OTEL_LOGS_ENABLED=true are required in the local .env.');
  }

  const traceEndpoint = new URL(env.SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT || '');
  if (traceEndpoint.toString() !== LOCAL_TRACE_URL) {
    throw new Error('The smoke test only sends traces to the fixed loopback OTLP endpoint 127.0.0.1:4318/v1/traces.');
  }
  const logsEndpoint = new URL(env.SYSTEMFABRIC_OTEL_LOGS_EXPORTER_ENDPOINT || '');
  if (logsEndpoint.toString() !== LOCAL_LOGS_URL) {
    throw new Error('The smoke test only sends logs to the fixed loopback OTLP endpoint 127.0.0.1:4318/v1/logs.');
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

  function readBearerHeader(value, label) {
    let parsed;
    try { parsed = JSON.parse(value || ''); } catch {
      throw new Error('The local ' + label + ' authorization header is missing or invalid; rerun npm run otel:dev:setup.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 || typeof parsed.authorization !== 'string') {
      throw new Error('The local collector profile supports only its generated bearer authorization header.');
    }
    if (parsed.authorization !== 'Bearer ' + token) {
      throw new Error('The local ' + label + ' authorization header and collector token file do not match; rerun npm run otel:dev:setup.');
    }
    return parsed.authorization;
  }

  const traceAuthorization = readBearerHeader(
    env.SYSTEMFABRIC_OTEL_EXPORTER_HEADERS_JSON,
    'trace exporter'
  );
  const logsAuthorization = readBearerHeader(
    env.SYSTEMFABRIC_OTEL_LOGS_EXPORTER_HEADERS_JSON,
    'logs exporter'
  );
  if (traceAuthorization !== logsAuthorization) {
    throw new Error('The local trace and logs collector credentials must match.');
  }

  return Object.freeze({
    traceEndpoint: traceEndpoint.toString(),
    logsEndpoint: logsEndpoint.toString(),
    authorization: traceAuthorization
  });
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

function createSmokeLogPayload(now = Date.now()) {
  const timestamp = (BigInt(now) * 1_000_000n).toString();
  const eventName = 'systemfabric.observability.logs_smoke';
  return {
    resourceLogs: [{
      resource: {
        attributes: [{
          key: 'service.name',
          value: { stringValue: 'systemfabric-local-collector-smoke' }
        }]
      },
      scopeLogs: [{
        scope: { name: 'systemfabric.local-collector-smoke', version: '0.5.1' },
        logRecords: [{
          timeUnixNano: timestamp,
          observedTimeUnixNano: timestamp,
          severityNumber: 9,
          severityText: 'INFO',
          body: { stringValue: eventName },
          attributes: [{
            key: 'event.name',
            value: { stringValue: eventName }
          }]
        }]
      }]
    }]
  };
}

/**
 * Verify bearer authentication and OTLP acceptance for both traces and logs.
 * Requests are restricted to the fixed loopback receiver; the token is never
 * returned, included in a result or printed.
 */
async function smokeTestLocalCollector({
  root = path.resolve(__dirname, '..'),
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  now = Date.now
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Node.js fetch is required for the collector smoke test.');
  const config = readLocalCollectorConfig(root);

  async function send(endpoint, payload, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const tracePayload = createSmokePayload(now());
  const unauthenticatedTrace = await send(config.traceEndpoint, tracePayload);
  if (unauthenticatedTrace.status !== 401) {
    throw new Error('The local trace receiver must reject requests without bearer authentication (expected HTTP 401).');
  }
  const authenticatedTrace = await send(config.traceEndpoint, tracePayload, {
    authorization: config.authorization
  });
  if (authenticatedTrace.status !== 200) {
    throw new Error('The local collector did not accept the authenticated OTLP smoke span (expected HTTP 200).');
  }

  const logPayload = createSmokeLogPayload(now());
  const unauthenticatedLogs = await send(config.logsEndpoint, logPayload);
  if (unauthenticatedLogs.status !== 401) {
    throw new Error('The local logs receiver must reject requests without bearer authentication (expected HTTP 401).');
  }
  const authenticatedLogs = await send(config.logsEndpoint, logPayload, {
    authorization: config.authorization
  });
  if (authenticatedLogs.status !== 200) {
    throw new Error('The local collector did not accept the authenticated OTLP smoke log (expected HTTP 200).');
  }

  return Object.freeze({
    traceEndpoint: config.traceEndpoint,
    logsEndpoint: config.logsEndpoint,
    unauthenticatedTraceStatus: unauthenticatedTrace.status,
    authenticatedTraceStatus: authenticatedTrace.status,
    unauthenticatedLogsStatus: unauthenticatedLogs.status,
    authenticatedLogsStatus: authenticatedLogs.status,
    spansSubmitted: 1,
    logsSubmitted: 1
  });
}

if (require.main === module) {
  smokeTestLocalCollector().then(result => {
    console.log('Local OTLP collector trace and logs smoke tests passed.');
    console.log('Unauthenticated trace request rejected: HTTP ' + result.unauthenticatedTraceStatus);
    console.log('Authenticated OTLP span accepted: HTTP ' + result.authenticatedTraceStatus);
    console.log('Unauthenticated logs request rejected: HTTP ' + result.unauthenticatedLogsStatus);
    console.log('Authenticated OTLP log accepted: HTTP ' + result.authenticatedLogsStatus);
    console.log('Inspect the local debug exporter with: docker compose --profile observability logs -f otel-collector');
  }).catch(error => {
    console.error('Local OTLP collector smoke test failed: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  readLocalCollectorConfig,
  createSmokePayload,
  createSmokeLogPayload,
  smokeTestLocalCollector
};
