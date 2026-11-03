'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  APPROVED_GENERATED_OUTPUTS,
  assessSourceTreeStatus,
  hasNoHighAuditFindings,
  hasSuccessfulPlaywrightSummary,
  isFreshMigrationEvidence,
  parseGitPorcelainStatus,
  parseTapSummary,
} = require('../scripts/release-readiness-validation');

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('fresh migration evidence must match the current migration count and idempotency result', () => {
  const current = {
    status: 'PASS',
    migrationCount: 17,
    firstPass: '17/17 migrations applied',
    secondPass: '17/17 migrations skipped as already applied',
    cleanup: 'disposable database dropped',
  };
  assert.equal(isFreshMigrationEvidence(current, 17), true);
  assert.equal(isFreshMigrationEvidence(current, 16), false);
  assert.equal(isFreshMigrationEvidence({ ...current, secondPass: '15/15 migrations skipped as already applied' }, 17), false);
  assert.equal(isFreshMigrationEvidence({ ...current, status: 'BLOCKED' }, 17), false);
});

test('Playwright validation requires a positive passed count and rejects failures or skips', () => {
  assert.equal(hasSuccessfulPlaywrightSummary('Running 9 tests\n9 passed (35.2s)\n'), true);
  assert.equal(hasSuccessfulPlaywrightSummary('Running 4 tests\n4 passed (18.4s)\n'), true);
  assert.equal(hasSuccessfulPlaywrightSummary('Running 9 tests\n8 passed\n1 failed\n'), false);
  assert.equal(hasSuccessfulPlaywrightSummary('Running 9 tests\n9 passed\n1 skipped\n'), false);
  assert.equal(hasSuccessfulPlaywrightSummary('Running 0 tests\n'), false);
  assert.equal(hasSuccessfulPlaywrightSummary('9 passed\n1 skipped\n'), false);
});

test('npm audit evidence requires a parseable summary and rejects high/critical counts', () => {
  assert.equal(hasNoHighAuditFindings('found 0 vulnerabilities'), true);
  assert.equal(hasNoHighAuditFindings('found 4 vulnerabilities (2 low, 2 moderate)'), true);
  assert.equal(hasNoHighAuditFindings('found 1 vulnerability (1 moderate)'), true);
  assert.equal(hasNoHighAuditFindings('found 4 vulnerabilities (2 low, 1 moderate, 1 high)'), false);
  assert.equal(hasNoHighAuditFindings('found 2 vulnerabilities (1 moderate, 1 critical)'), false);
  assert.equal(hasNoHighAuditFindings('audit completed without a summary'), false);
});

test('TAP summary parser reports each counter and leaves absent counters unknown', () => {
  const summary = parseTapSummary([
    'TAP version 13',
    '# tests 22',
    '# pass 22',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ].join('\n'));
  assert.deepEqual(summary, { tests: 22, pass: 22, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(parseTapSummary('# tests 2\n').pass, null);
  assert.deepEqual(parseTapSummary(['ℹ tests 22', 'ℹ pass 21', 'ℹ fail 1', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n')),
    { tests: 22, pass: 21, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
});

test('only exact, enumerated generated outputs are non-blocking', () => {
  assert.ok(APPROVED_GENERATED_OUTPUTS.has('artifacts/release-readiness.json'));
  assert.ok(APPROVED_GENERATED_OUTPUTS.has('artifacts/evidence/integration-tests.tap.log'));
  const result = assessSourceTreeStatus([
    ' M artifacts/release-readiness.json',
    ' M artifacts/evidence/npm-audit.log',
    ' M artifacts/evidence/unapproved-report.json',
  ].join('\0') + '\0');
  assert.equal(result.clean, false);
  assert.deepEqual(result.generatedPaths, [
    'artifacts/evidence/npm-audit.log',
    'artifacts/release-readiness.json',
  ]);
  assert.deepEqual(result.sourcePaths, ['artifacts/evidence/unapproved-report.json']);
});

test('untracked source and tracked source edits remain blocking, including filenames with spaces', () => {
  const result = assessSourceTreeStatus(' M packages/domain/src/model.js\0?? new source file.js\0');
  assert.equal(result.clean, false);
  assert.deepEqual(result.changedPaths, ['new source file.js', 'packages/domain/src/model.js']);
  assert.deepEqual(result.sourcePaths, result.changedPaths);
});

test('NUL porcelain parser handles rename records and Windows-style separators', () => {
  const entries = parseGitPorcelainStatus('R  docs/new name.md\0docs/old name.md\0 M scripts\\new-file.js\0');
  assert.deepEqual(entries, [
    { path: 'docs/new name.md', status: 'R ' },
    { path: 'docs/old name.md', status: 'rename-source' },
    { path: 'scripts/new-file.js', status: ' M' },
  ]);
});

test('NUL porcelain parser rejects malformed, absolute and traversal paths', () => {
  assert.throws(() => parseGitPorcelainStatus('malformed\0'), /malformed/);
  assert.throws(() => parseGitPorcelainStatus('?? ../outside.js\0'), /unsafe/);
  assert.throws(() => parseGitPorcelainStatus('?? C:/outside.js\0'), /unsafe/);
  assert.throws(() => parseGitPorcelainStatus('R  new.js\0'), /incomplete/);
});

test('real Git status detects source changes and line-ending-only edits on Windows and Linux', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'systemfabric-git-status-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  git(directory, ['init', '--quiet']);
  git(directory, ['config', 'user.name', 'SystemFabric Test']);
  git(directory, ['config', 'user.email', 'systemfabric-test@example.invalid']);
  git(directory, ['config', 'core.autocrlf', 'false']);

  const tracked = path.join(directory, 'tracked.txt');
  fs.writeFileSync(tracked, 'first\nsecond\n', 'utf8');
  git(directory, ['add', '--', 'tracked.txt']);
  git(directory, ['commit', '--quiet', '-m', 'baseline']);

  const cleanOutput = git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  assert.equal(assessSourceTreeStatus(cleanOutput).clean, true);

  // Recreate a deterministic postinstall copy: the file timestamp changes,
  // but the committed blob does not. Refresh Git's cached stat data before the
  // source-tree gate so this byte-identical output is not a false dirty edit.
  fs.writeFileSync(tracked, 'first\nsecond\n', 'utf8');
  git(directory, ['update-index', '--refresh']);
  const refreshedOutput = git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  assert.equal(assessSourceTreeStatus(refreshedOutput).clean, true);

  fs.writeFileSync(tracked, 'first\r\nsecond\r\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'untracked source.js'), 'module.exports = true;\n', 'utf8');
  const changedOutput = git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const assessment = assessSourceTreeStatus(changedOutput);
  assert.equal(assessment.clean, false);
  assert.deepEqual(assessment.sourcePaths, ['tracked.txt', 'untracked source.js']);
});
