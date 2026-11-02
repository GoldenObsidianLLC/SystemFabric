'use strict';

const APPROVED_GENERATED_OUTPUTS = new Set([
  'artifacts/evidence/artifact-check.log',
  'artifacts/evidence/unit-tests.tap.log',
  'artifacts/evidence/enginex-tests.tap.log',
  'artifacts/evidence/integration-tests.tap.log',
  'artifacts/evidence/integration-migrations.log',
  'artifacts/evidence/fresh-migrations.json',
  'artifacts/evidence/fresh-migrations.log',
  'artifacts/evidence/integration-live.json',
  'artifacts/evidence/memgraph-outage-live.log',
  'artifacts/evidence/graph-rebuild-live.log',
  'artifacts/evidence/browser-smoke.log',
  'artifacts/evidence/npm-audit-all.log',
  'artifacts/evidence/npm-audit.log',
  'artifacts/evidence/sbom-generation.log',
  'artifacts/systemfabric.sbom.cdx.json',
  'artifacts/release-readiness.json',
  'artifacts/release-readiness.md',
]);

function isFreshMigrationEvidence(value, expectedMigrationCount) {
  if (!Number.isInteger(expectedMigrationCount) || expectedMigrationCount < 1) return false;
  return value?.status === 'PASS'
    && value.migrationCount === expectedMigrationCount
    && value.firstPass === expectedMigrationCount + '/' + expectedMigrationCount + ' migrations applied'
    && value.secondPass === expectedMigrationCount + '/' + expectedMigrationCount + ' migrations skipped as already applied'
    && value.cleanup === 'disposable database dropped';
}

function hasSuccessfulPlaywrightSummary(output) {
  const text = String(output || '');
  const passed = [...text.matchAll(/^\s*(\d+) passed(?:\s|$)/gm)].at(-1);
  if (!passed || Number(passed[1]) < 1) return false;
  const failures = [...text.matchAll(/^\s*(\d+) failed(?:\s|$)/gm)];
  const skipped = [...text.matchAll(/^\s*(\d+) skipped(?:\s|$)/gm)];
  return failures.every(match => Number(match[1]) === 0)
    && skipped.every(match => Number(match[1]) === 0);
}

function hasNoHighAuditFindings(output) {
  const lines = String(output || '').split(/\r?\n/).map(line => line.trim());
  const summaries = lines.map(line => line.match(/^found\s+([0-9]+)\s+vulnerabilit(?:y|ies)(?:\s*\(([^)]*)\))?$/i)).filter(Boolean);
  const summary = summaries.at(-1);
  if (!summary) return false;
  const total = Number(summary[1]);
  if (!Number.isSafeInteger(total)) return false;
  if (total === 0) return true;
  const breakdown = summary[2];
  if (!breakdown) return false;
  const severity = [...breakdown.matchAll(/([0-9]+)\s+(low|moderate|high|critical)/gi)];
  if (severity.length === 0) return false;
  const counted = severity.reduce((sum, item) => sum + Number(item[1]), 0);
  return counted === total
    && severity.every(item => !['high', 'critical'].includes(item[2].toLowerCase()) || Number(item[1]) === 0);
}

function parseTapSummary(output) {
  const values = new Map();
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.trim().split(' ').filter(Boolean);
    if (fields.length === 3 && (fields[0] === '#' || fields[0] === 'ℹ') &&
        ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].includes(fields[1]) &&
        /^[0-9]+$/.test(fields[2])) {
      values.set(fields[1], Number(fields[2]));
    }
  }
  const get = name => values.has(name) ? values.get(name) : null;
  return {
    tests: get('tests'),
    pass: get('pass'),
    fail: get('fail'),
    cancelled: get('cancelled'),
    skipped: get('skipped'),
    todo: get('todo'),
  };
}

function parseGitPorcelainStatus(output) {
  const fields = String(output || '').split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('Git returned malformed porcelain status output.');
    }
    const status = record.slice(0, 2);
    const filePath = record.slice(3).replace(/\\/g, '/');
    const parts = filePath.split('/');
    if (!filePath || filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath) ||
        parts.some(part => !part || part === '.' || part === '..')) {
      throw new Error('Git returned an unsafe or empty path in porcelain status output.');
    }
    entries.push({ path: filePath, status });
    if (status.includes('R') || status.includes('C')) {
      const originalPath = fields[index + 1];
      const normalizedOriginal = String(originalPath || '').replace(/\\/g, '/');
      const originalParts = normalizedOriginal.split('/');
      if (!originalPath || normalizedOriginal.startsWith('/') || /^[A-Za-z]:/.test(normalizedOriginal) ||
          originalParts.some(part => !part || part === '.' || part === '..')) {
        throw new Error('Git returned an incomplete or unsafe rename/copy source path.');
      }
      entries.push({ path: normalizedOriginal, status: 'rename-source' });
      index += 1;
    }
  }
  return entries;
}

function assessSourceTreeStatus(statusOutput) {
  const entries = parseGitPorcelainStatus(statusOutput);
  const changedPaths = [...new Set(entries.map(entry => entry.path))].sort();
  const generatedPaths = changedPaths.filter(filePath => APPROVED_GENERATED_OUTPUTS.has(filePath));
  const sourcePaths = changedPaths.filter(filePath => !APPROVED_GENERATED_OUTPUTS.has(filePath));
  return {
    clean: sourcePaths.length === 0,
    changedPaths,
    generatedPaths,
    sourcePaths,
  };
}

module.exports = {
  APPROVED_GENERATED_OUTPUTS,
  assessSourceTreeStatus,
  hasNoHighAuditFindings,
  hasSuccessfulPlaywrightSummary,
  isFreshMigrationEvidence,
  parseGitPorcelainStatus,
  parseTapSummary,
};
