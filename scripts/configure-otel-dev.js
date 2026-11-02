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
  SYSTEMFABRIC_OTEL_LOGS_ENABLED: 'true',
  SYSTEMFABRIC_OTEL_LOGS_EXPORTER_ENDPOINT: 'http://127.0.0.1:4318/v1/logs',
  SYSTEMFABRIC_OTEL_SAMPLE_RATIO: '0.1',
  SYSTEMFABRIC_OTEL_EXPORT_TIMEOUT_MS: '5000',
  SYSTEMFABRIC_OTEL_ALLOW_INSECURE_HTTP: 'true',
  SYSTEMFABRIC_OTEL_AUTH_TOKEN_FILE: './var/secrets/otel-collector-token.txt'
});

function isInsideDirectory(directory, candidate) {
  return candidate.startsWith(directory + path.sep);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Open first, then validate and read through the same descriptor. This avoids
 * checking a pathname and subsequently reopening a different file after a
 * symlink/path replacement race. The canonical target must stay inside root.
 */
function readRegularFile(rootRealPath, filePath, { optional = false } = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const openedStats = fs.fstatSync(descriptor);
    if (!openedStats.isFile()) {
      throw new Error('The local OTLP configuration path must be a regular file.');
    }

    // Inspect the directory entry only after opening. Match it to the opened
    // file identity, then consume the descriptor rather than reopening the path.
    const entryStats = fs.lstatSync(filePath);
    if (!entryStats.isFile() || entryStats.isSymbolicLink() ||
        !sameFileIdentity(openedStats, entryStats)) {
      throw new Error('The local OTLP configuration file changed while it was being opened.');
    }

    const canonicalPath = fs.realpathSync(filePath);
    if (!isInsideDirectory(rootRealPath, canonicalPath)) {
      throw new Error('The local OTLP configuration file must remain inside the repository root.');
    }
    const canonicalStats = fs.statSync(canonicalPath);
    if (!sameFileIdentity(openedStats, canonicalStats)) {
      throw new Error('The local OTLP configuration file changed while it was being opened.');
    }

    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Create an exclusive temporary file and write to the open descriptor. Callers
 * publish it with renameSync so readers never observe a partially written file.
 */
function writeTemporaryFile(targetPath, content, mode) {
  const temporaryPath = targetPath + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      mode
    );
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  fs.closeSync(descriptor);
  return temporaryPath;
}

function replaceFileAtomically(targetPath, content, mode) {
  const temporaryPath = writeTemporaryFile(targetPath, content, mode);
  try {
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

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

  // The token file is readable by the non-root Collector UID inside its bind
  // mount. Keep the host directory private so other local users cannot traverse
  // to that file. On Windows, NTFS ACLs govern access rather than POSIX mode bits.
  fs.chmodSync(secretDirectory, 0o700);
  if (process.platform !== 'win32' && (fs.statSync(secretDirectory).mode & 0o077) !== 0) {
    throw new Error('The local OTLP secret directory must not grant access to group or other users.');
  }

  const realSecretDirectory = fs.realpathSync(secretDirectory);
  if (!isInsideDirectory(rootRealPath, realSecretDirectory)) {
    throw new Error('The local OTLP secret directory must remain inside the repository root.');
  }

  const previousToken = readRegularFile(rootRealPath, secretFile, { optional: true });
  const writeToken = previousToken === null || rotate;
  const token = writeToken ? tokenFactory() : previousToken.trim();
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
    }),
    SYSTEMFABRIC_OTEL_LOGS_EXPORTER_HEADERS_JSON: JSON.stringify({
      authorization: 'Bearer ' + token
    })
  };

  // Validate .env before writing a new token so duplicate entries cannot rotate
  // the collector secret while leaving the application on the old one.
  const currentEnv = readRegularFile(rootRealPath, envFile, { optional: true }) || '';
  const nextEnv = upsertEnv(currentEnv, updates);
  let temporaryEnv = null;
  let temporaryToken = null;

  try {
    temporaryEnv = writeTemporaryFile(envFile, nextEnv, 0o600);
    if (writeToken) {
      temporaryToken = writeTemporaryFile(secretFile, token + '\n', 0o644);
      fs.renameSync(temporaryToken, secretFile);
      temporaryToken = null;
    }
    fs.renameSync(temporaryEnv, envFile);
    temporaryEnv = null;
  } catch (error) {
    if (temporaryEnv) fs.rmSync(temporaryEnv, { force: true });
    if (temporaryToken) fs.rmSync(temporaryToken, { force: true });

    if (writeToken) {
      try {
        if (previousToken === null) fs.rmSync(secretFile, { force: true });
        else replaceFileAtomically(secretFile, previousToken, 0o644);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Local OTLP configuration failed and the previous secret could not be restored.'
        );
      }
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

module.exports = {
  configureLocalCollector,
  upsertEnv,
  collectorImageTagForArch,
  readRegularFile,
  writeTemporaryFile,
  replaceFileAtomically
};
