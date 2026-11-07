'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertGitSubmodulesReady, parseSubmoduleStatus } = require('../scripts/git-submodules');

const COMMIT = 'd99e021f55664f006b5e65b4a58202f9c7bc4f4b';

function runWithStatus(stdout, overrides = {}) {
  const calls = [];
  const result = assertGitSubmodulesReady({
    cwd: 'C:\\workspace\\virgoscorpio-hub',
    spawnSyncImpl(...args) {
      calls.push(args);
      return { status: 0, stdout, stderr: '', ...overrides };
    }
  });
  return { result, calls };
}

test('submodule preflight reads recursive Git status and returns pinned commit paths', () => {
  const { result, calls } = runWithStatus(' ' + COMMIT + ' vendor/enginex (heads/main)\n');
  assert.deepEqual(result, [{ commit: COMMIT, path: 'vendor/enginex' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'git');
  assert.deepEqual(calls[0][1], ['submodule', 'status', '--recursive']);
  assert.equal(calls[0][2].cwd, 'C:\\workspace\\virgoscorpio-hub');
  assert.equal(calls[0][2].encoding, 'utf8');
  assert.equal(calls[0][2].timeout, 5000);
});

test('submodule preflight accepts repositories without configured submodules', () => {
  assert.deepEqual(runWithStatus('').result, []);
});

test('submodule status parser rejects malformed output instead of silently accepting it', () => {
  assert.throws(() => parseSubmoduleStatus('not Git submodule status'), /unrecognized submodule status/);
  assert.throws(() => parseSubmoduleStatus(null), /must be a string/);
});

test('submodule preflight gives an actionable command for an uninitialized submodule', () => {
  assert.throws(
    () => runWithStatus('-' + COMMIT + ' vendor/enginex'),
    error => error.message.includes('vendor/enginex') &&
      error.message.includes('git submodule update --init --recursive') &&
      error.message.includes('git clone --recurse-submodules')
  );
});

test('submodule preflight refuses a different checkout without mutating it', () => {
  assert.throws(
    () => runWithStatus('+' + COMMIT + ' vendor/enginex'),
    error => error.message.includes('differ from the commits pinned') &&
      error.message.includes('will not overwrite or reset')
  );
});

test('submodule preflight reports unresolved submodule conflicts', () => {
  assert.throws(
    () => runWithStatus('U' + COMMIT + ' vendor/enginex'),
    /unresolved submodule conflicts/
  );
});

test('submodule preflight fails closed when Git cannot inspect the checkout', () => {
  assert.throws(
    () => runWithStatus('', { status: 128, stderr: 'private remote details must not be echoed' }),
    error => error.message.includes('Unable to inspect Git submodule state') &&
      !error.message.includes('private remote details')
  );
  assert.throws(
    () => assertGitSubmodulesReady({ cwd: '', spawnSyncImpl() {} }),
    /working directory is required/
  );
});
