'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  main,
  resolveManifestPath
} = require('../scripts/validate-observability-deployment');

const repositoryRoot = path.resolve(__dirname, '..');

function withConsoleCapture(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: callback(), output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('CLI rejects manifest paths that resolve outside the repository', () => {
  assert.throws(
    () => resolveManifestPath(path.resolve(repositoryRoot, '..', '..', 'outside.json')),
    /inside the repository/
  );
});

test('CLI rejects unexpected secret fields without printing their values', t => {
  const manifestPath = path.join(repositoryRoot, 'var', 'observability-invalid-fixture.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    environment: 'production',
    sourceRevision: '5d9a99541a23670c07af1425cbc21df454af19c8',
    transport: {
      authentication: {
        apiKey: 'THIS_VALUE_MUST_NOT_APPEAR_IN_CLI_OUTPUT'
      }
    }
  }));
  t.after(() => fs.rmSync(manifestPath, { force: true }));

  const captured = withConsoleCapture(() => main([manifestPath]));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /OBSERVABILITY DEPLOYMENT: BLOCKED/);
  assert.match(captured.output, /unexpected_field/);
  assert.doesNotMatch(captured.output, /THIS_VALUE_MUST_NOT_APPEAR_IN_CLI_OUTPUT/);
});

test('CLI explains that an absent deployment manifest blocks approval', () => {
  const captured = withConsoleCapture(() => main(['artifacts/evidence/manifest-that-does-not-exist.json']));
  assert.equal(captured.result, 2);
  assert.match(captured.output, /OBSERVABILITY DEPLOYMENT: BLOCKED/);
  assert.match(captured.output, /manifest is missing/i);
});
