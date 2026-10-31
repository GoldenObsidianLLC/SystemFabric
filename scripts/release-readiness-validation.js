'use strict';

/**
 * Validate the fresh-migration evidence against the schema revision that the
 * release-readiness report currently requires.
 *
 * @param {Record<string, unknown>} value
 * @param {number} expectedMigrationCount
 * @returns {boolean}
 */
function isFreshMigrationEvidence(value, expectedMigrationCount) {
  if (!Number.isInteger(expectedMigrationCount) || expectedMigrationCount < 1) return false;
  return value?.status === 'PASS'
    && value.migrationCount === expectedMigrationCount
    && value.firstPass === `${expectedMigrationCount}/${expectedMigrationCount} migrations applied`
    && value.secondPass === `${expectedMigrationCount}/${expectedMigrationCount} migrations skipped as already applied`
    && value.cleanup === 'disposable database dropped';
}

/**
 * Accept a Playwright run summary only when at least one test passed and none
 * failed or skipped. Supports both the current full suite and smaller focused
 * smoke sets.
 *
 * @param {string} output
 * @returns {boolean}
 */
function hasSuccessfulPlaywrightSummary(output) {
  const text = String(output || '');
  const passed = [...text.matchAll(/^\s*(\d+) passed(?:\s|$)/gm)].at(-1);
  if (!passed || Number(passed[1]) < 1) return false;

  const failures = [...text.matchAll(/^\s*(\d+) failed(?:\s|$)/gm)];
  const skipped = [...text.matchAll(/^\s*(\d+) skipped(?:\s|$)/gm)];
  return failures.every(match => Number(match[1]) === 0)
    && skipped.every(match => Number(match[1]) === 0);
}

module.exports = {
  isFreshMigrationEvidence,
  hasSuccessfulPlaywrightSummary,
};
