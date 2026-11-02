'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  configureLocalCollector,
  upsertEnv,
  collectorImageTagForArch
} = require('../scripts/configure-otel-dev');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'systemfabric-otel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('local collector setup creates an ignored token file and matching loopback exporter settings', t => {
  const root = temporaryRoot(t);
  const token = 'a'.repeat(43);
  const result = configureLocalCollector({ root, tokenFactory: () => token });
  const savedToken = fs.readFileSync(result.secretFile, 'utf8').trim();
  const env = fs.readFileSync(result.envFile, 'utf8');
  const headersLine = env.split(/\r?\n/).find(line =>
    line.startsWith('SYSTEMFABRIC_OTEL_EXPORTER_HEADERS_JSON=')
  );

  assert.equal(savedToken, token);
  assert.match(env, /^SYSTEMFABRIC_OTEL_ENABLED=true$/m);
  assert.match(env, /^SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT=http:\/\/127\.0\.0\.1:4318\/v1\/traces$/m);
  assert.match(env, /^SYSTEMFABRIC_OTEL_ALLOW_INSECURE_HTTP=true$/m);
  assert.match(env, /^SYSTEMFABRIC_OTEL_AUTH_TOKEN_FILE=\.\/var\/secrets\/otel-collector-token\.txt$/m);
  assert.deepEqual(JSON.parse(headersLine.slice(headersLine.indexOf('=') + 1)), {
    authorization: 'Bearer ' + token
  });
  assert.match(env, /^SYSTEMFABRIC_OTEL_COLLECTOR_IMAGE_TAG=0\.164\.0-amd64$/m);
  assert.equal(result.rotated, false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('local collector setup is idempotent and token rotation updates both sides', t => {
  const root = temporaryRoot(t);
  let calls = 0;
  const tokenFactory = () => (++calls === 1 ? 'b'.repeat(43) : 'c'.repeat(43));
  const first = configureLocalCollector({ root, tokenFactory });
  const second = configureLocalCollector({ root, tokenFactory });
  assert.equal(fs.readFileSync(first.secretFile, 'utf8').trim(), 'b'.repeat(43));
  assert.equal(fs.readFileSync(second.secretFile, 'utf8').trim(), 'b'.repeat(43));
  assert.equal(calls, 1);

  const rotated = configureLocalCollector({ root, rotate: true, tokenFactory });
  const env = fs.readFileSync(rotated.envFile, 'utf8');
  const headersLine = env.split(/\r?\n/).find(line =>
    line.startsWith('SYSTEMFABRIC_OTEL_EXPORTER_HEADERS_JSON=')
  );
  assert.equal(fs.readFileSync(rotated.secretFile, 'utf8').trim(), 'c'.repeat(43));
  assert.deepEqual(JSON.parse(headersLine.slice(headersLine.indexOf('=') + 1)), {
    authorization: 'Bearer ' + 'c'.repeat(43)
  });
  assert.equal(rotated.rotated, true);
});

test('local collector setup rejects unsupported architectures before creating secrets', t => {
  const root = temporaryRoot(t);
  assert.throws(
    () => configureLocalCollector({ root, arch: 'unsupported' }),
    /No pinned OpenTelemetry Collector image/
  );
  assert.equal(fs.existsSync(path.join(root, 'var')), false);
});

test('duplicate environment keys do not rotate or replace the existing collector token', t => {
  const root = temporaryRoot(t);
  const first = configureLocalCollector({ root, tokenFactory: () => 'd'.repeat(43) });
  const originalToken = fs.readFileSync(first.secretFile, 'utf8');
  fs.appendFileSync(first.envFile, 'SYSTEMFABRIC_OTEL_ENABLED=false\\n');

  assert.throws(
    () => configureLocalCollector({ root, rotate: true, tokenFactory: () => 'e'.repeat(43) }),
    /duplicate SYSTEMFABRIC_OTEL_ENABLED/
  );
  assert.equal(fs.readFileSync(first.secretFile, 'utf8'), originalToken);
});

test('local collector setup rejects invalid existing or newly generated secrets', t => {
  const root = temporaryRoot(t);
  const secretDirectory = path.join(root, 'var', 'secrets');
  fs.mkdirSync(secretDirectory, { recursive: true });
  fs.writeFileSync(path.join(secretDirectory, 'otel-collector-token.txt'), 'short\n');
  assert.throws(() => configureLocalCollector({ root }), /existing local OTLP token is invalid/);
  assert.throws(
    () => configureLocalCollector({ root, rotate: true, tokenFactory: () => 'short' }),
    /40–64 base64url/
  );
});

test('environment updates preserve unrelated settings and reject duplicate OTEL keys', () => {
  const result = upsertEnv(
    '# keep me\nDATABASE_URL=postgres://localhost/db\nSYSTEMFABRIC_OTEL_ENABLED=false\n',
    { SYSTEMFABRIC_OTEL_ENABLED: 'true' }
  );
  assert.match(result, /^# keep me$/m);
  assert.match(result, /^DATABASE_URL=postgres:\/\/localhost\/db$/m);
  assert.match(result, /^SYSTEMFABRIC_OTEL_ENABLED=true$/m);
  assert.throws(
    () => upsertEnv(
      'SYSTEMFABRIC_OTEL_ENABLED=false\nSYSTEMFABRIC_OTEL_ENABLED=false\n',
      { SYSTEMFABRIC_OTEL_ENABLED: 'true' }
    ),
    /duplicate SYSTEMFABRIC_OTEL_ENABLED/
  );
});

test('collector image tags are pinned per supported host architecture', () => {
  assert.equal(collectorImageTagForArch('x64'), '0.164.0-amd64');
  assert.equal(collectorImageTagForArch('arm64'), '0.164.0-arm64');
  assert.equal(collectorImageTagForArch('arm'), '0.164.0-armv7');
  assert.throws(() => collectorImageTagForArch('unsupported'), /No pinned OpenTelemetry Collector image/);
});

test('collector reference config is authenticated, trace-only, memory-bounded and debug-only', () => {
  const root = path.resolve(__dirname, '..');
  const config = fs.readFileSync(path.join(root, 'docker', 'otel', 'collector.yaml'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');

  assert.match(config, /bearertokenauth:/);
  assert.match(config, /filename:\s*\/run\/secrets\/otel_receiver_token/);
  assert.match(config, /authenticator:\s*bearertokenauth/);
  assert.match(config, /memory_limiter:/);
  assert.match(config, /batch:/);
  assert.match(config, /exporters:\s*\n\s+debug:/);
  assert.match(config, /verbosity:\s+normal/);
  assert.match(config, /pipelines:\s*\n\s+traces:/);
  assert.doesNotMatch(config, /\n\s+metrics:\s*\n\s+receivers:/);
  assert.doesNotMatch(config, /\n\s+logs:\s*\n\s+receivers:/);
  assert.match(config, /telemetry:\s*\n\s+logs:\s*\n\s+level:\s+info/);
  assert.match(compose, /ghcr\.io\/open-telemetry\/opentelemetry-collector-releases\/opentelemetry-collector-contrib:/);
  assert.match(compose, /127\.0\.0\.1:4318:4318/);
  assert.match(compose, /cap_drop:\s*\[\s*"ALL"\s*\]/);
  assert.match(compose, /no-new-privileges:true/);
});
