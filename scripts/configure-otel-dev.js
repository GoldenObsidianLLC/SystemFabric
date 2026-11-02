'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const COLLECTOR_TAG_BY_ARCH = Object.freeze({
  x64: '0.164.0-amd64',
  arm64: '0.164.0-arm64',
  arm: '0.164.0-armv7'
});

function collectorImageTagForArch(arch = process.arch) {
  const tag = COLLECTOR_TAG_BY_ARCH[arch];
  if (!tag) {
    throw new Error('No pinned OpenTelemetry Collector image is available for architecture: ' + arch);
  }
  return tag;
}

const ENVIRONMENT = Object.freeze({
  SYSTEMFABRIC_OTEL_ENABLED: 'true',
  SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
  SYSTEMFABRIC_OTEL_SAMPLE_RATIO: '0.1',
  SYSTEMFABRIC_OTEL_EXPORT_TIMEOUT_MS: '5000',
  SYSTEMFABRIC_OTEL_ALLOW_INSECURE_HTTP: 'true',
  SYSTEMFABRIC_OTEL_AUTH_TOKEN_FILE: './var/secrets/otel-collector-token.txt'
});

function upsertEnv(content, updates) {
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp('^(?:export\\s+)?' + key + '\\s*=');
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index].trim())) matches.push(index);
    }
    if (matches.length > 1) {
      throw new Error('.env contains duplicate ' + key + ' entries; remove the duplicates before configuring the local collector.');
    }
    const line = key + '=' + value;
    if (matches.length === 1) lines[matches[0]] = line;
    else lines.push(line);
  }
  return lines.join('\n') + '\n';
}

/**
 * Configure the optional local-only OTLP collector.
 *
 * The generated token is shared by the app exporter and the collector receiver.
 * It is stored only in the ignored var/ directory and .env; it is never returned
 * or printed. A second run reuses the existing token. Pass rotate=true to rotate.
 */
function configureLocalCollector({
  root = path.resolve(__dirname, '..'),
  rotate = false,
  tokenFactory = () => crypto.randomBytes(32).toString('base64url'),
  arch = process.arch
} = {}) {
  // Resolve supported architecture before touching the secret directory or .env.
  const collectorImageTag = collectorImageTagForArch(arch);
  const rootRealPath = fs.realpathSync(root);
  const variableDirectory = path.join(rootRealPath, 'var');
  const secretDirectory = path.join(variableDirectory, 'secrets');
  const secretFile = path.join(secretDirectory, 'otel-collector-token.txt');
  const envFile = path.join(rootRealPath, '.env');
  fs.mkdirSync(variableDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });

  for (const directory of [variableDirectory, secretDirectory]) {
    const stats = fs.lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('The local OTLP secret directories must be real directories, not symbolic links.');
    }
  }
  const realSecretDirectory = fs.realpathSync(secretDirectory);
  if (!realSecretDirectory.startsWith(rootRealPath + path.sep)) {
    throw new Error('The local OTLP secret directory must remain inside the repository root.');
  }

  const secretExists = fs.existsSync(secretFile);
  let previousToken = null;
  if (secretExists) {
    const stats = fs.lstatSync(secretFile);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('The local OTLP token path must be a regular file, not a symbolic link.');
    }
    previousToken = fs.readFileSync(secretFile, 'utf8');
  }

  const writeToken = !secretExists || rotate;
  const token = writeToken
    ? tokenFactory()
    : previousToken.trim();
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new TypeError(writeToken
      ? 'The generated local OTLP token must be 40–64 base64url characters.'
      : 'The existing local OTLP token is invalid; rerun with --rotate to replace it.');
  }

  const updates = {
    ...ENVIRONMENT,
    SYSTEMFABRIC_OTEL_COLLECTOR_IMAGE_TAG: collectorImageTag,
    SYSTEMFABRIC_OTEL_EXPORTER_HEADERS_JSON: JSON.stringify({
      authorization: 'Bearer ' + token
    })
  };
  const currentEnv = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  // Validate .env before writing a new token so duplicate entries cannot
  // rotate the collector secret while leaving the application on the old one.
  const nextEnv = upsertEnv(currentEnv, updates);
  const temporaryEnv = envFile + '.tmp-' + process.pid;
  const temporaryToken = secretFile + '.tmp-' + process.pid;

  try {
    fs.writeFileSync(temporaryEnv, nextEnv, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (writeToken) {
      fs.writeFileSync(temporaryToken, token + '\n', { encoding: 'utf8', mode: 0o644, flag: 'wx' });
      fs.renameSync(temporaryToken, secretFile);
    }
    fs.renameSync(temporaryEnv, envFile);
  } catch (error) {
    fs.rmSync(temporaryEnv, { force: true });
    fs.rmSync(temporaryToken, { force: true });
    if (writeToken) {
      if (previousToken === null) fs.rmSync(secretFile, { force: true });
      else fs.writeFileSync(secretFile, previousToken, { encoding: 'utf8', mode: 0o644 });
    }
    throw error;
  }

  return Object.freeze({
    envFile,
    secretFile,
    rotated: Boolean(rotate)
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(argument => argument !== '--rotate')) {
    console.error('Usage: node scripts/configure-otel-dev.js [--rotate]');
    process.exitCode = 2;
  } else {
    try {
      const result = configureLocalCollector({ rotate: args.includes('--rotate') });
      console.log('Local OTLP collector configuration written.');
      console.log('Secret file: ' + path.relative(process.cwd(), result.secretFile));
      console.log('Environment: .env updated; token value was not displayed.');
      console.log('Next: docker compose --profile observability up -d otel-collector');
    } catch (error) {
      console.error('Unable to configure local OTLP collector: ' + error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { configureLocalCollector, upsertEnv, collectorImageTagForArch };
