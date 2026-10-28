'use strict';

/**
 * Parse summary counters emitted by Node.js's built-in test runner.
 *
 * Node versions/reporters may emit either classic TAP summary lines such as
 * `# tests 5` or the information-symbol format `ℹ tests 5`. Accept both but
 * fail closed when the summary is absent or incomplete.
 */
function parseNodeTestSummary(output) {
  if (typeof output !== 'string') return null;

  const counts = Object.create(null);
  const linePattern = /^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm;
  let match;
  while ((match = linePattern.exec(output)) !== null) {
    counts[match[1]] = Number(match[2]);
  }

  // These counters are required to distinguish a fully passing run from a
  // partial/truncated log. Optional counters are zero when not emitted by an
  // older compatible Node.js reporter.
  if (!Number.isSafeInteger(counts.tests)
      || !Number.isSafeInteger(counts.pass)
      || !Number.isSafeInteger(counts.fail)
      || !Number.isSafeInteger(counts.skipped)) {
    return null;
  }

  return {
    tests: counts.tests,
    passed: counts.pass,
    failed: counts.fail,
    cancelled: Number.isSafeInteger(counts.cancelled) ? counts.cancelled : 0,
    skipped: counts.skipped,
    todo: Number.isSafeInteger(counts.todo) ? counts.todo : 0
  };
}

module.exports = { parseNodeTestSummary };
