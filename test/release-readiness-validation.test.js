'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasSuccessfulPlaywrightSummary,
  isFreshMigrationEvidence,
} = require('../scripts/release-readiness-validation');

test('fresh migration evidence must match the current migration count and idempotency result', () => {
  const current = {
    status: 'PASS',
    migrationCount: 14,
    firstPass: '14/14 migrations applied',
    secondPass: '14/14 migrations skipped as already applied',
    cleanup: 'disposable database dropped',
  };

  assert.equal(isFreshMigrationEvidence(current, 14), true);
  assert.equal(isFreshMigrationEvidence(current, 13), false);
  assert.equal(isFreshMigrationEvidence({ ...current, secondPass: '13/13 migrations skipped as already applied' }, 14), false);
});

test('Playwright validation accepts a zero-failure suite of any positive size but rejects failures and skips', () => {
  assert.equal(hasSuccessfulPlaywrightSummary('Running 9 tests\n9 passed (35.2s)\n'), true);
  assert.equal(hasSuccessfulPlaywrightSummary('Running 4 tests\n4 passed (18.4s)\n'), true);
  assert.equal(hasSuccessfulPlaywrightSummary('Running 9 tests\n8 passed\n1 failed\n'), false);
  assert.equal(hasSuccessfulPlaywrightSummary('Running 9 tests\n9 passed\n1 skipped\n'), false);
  assert.equal(hasSuccessfulPlaywrightSummary('Running 0 tests\n'), false);
});
