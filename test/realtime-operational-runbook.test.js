'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REALTIME_COUNTERS,
  REALTIME_GAUGES,
  REALTIME_HISTOGRAMS
} = require('../packages/observability/src/metrics');

const runbookPath = path.join(__dirname, '..', 'docs', 'REALTIME-OPERATIONS.md');
const runbook = fs.readFileSync(runbookPath, 'utf8');

function catalogNames(sectionName) {
  const start = '<!-- METRIC-CATALOG:' + sectionName + ':START -->';
  const end = '<!-- METRIC-CATALOG:' + sectionName + ':END -->';
  const startIndex = runbook.indexOf(start);
  const endIndex = runbook.indexOf(end);
  assert.notEqual(startIndex, -1, 'missing ' + sectionName + ' catalog start marker');
  assert.ok(endIndex > startIndex, 'missing or misplaced ' + sectionName + ' catalog end marker');
  const section = runbook.slice(startIndex + start.length, endIndex);
  return section.split(/\r?\n/)
    .map(line => line.split('|')[1]?.trim())
    .filter(name => name && name !== 'Metric' && /^[a-z][a-z0-9_]+$/.test(name));
}

function assertCatalogMatchesRegistry(sectionName, expectedNames) {
  const documentedNames = catalogNames(sectionName);
  assert.deepEqual(
    documentedNames,
    [...expectedNames],
    sectionName + ' catalog must match the exported registry in order, without omissions or duplicates'
  );
}

test('real-time operations runbook documents the exact fixed metric registry', () => {
  assertCatalogMatchesRegistry('COUNTERS', REALTIME_COUNTERS);
  assertCatalogMatchesRegistry('GAUGES', REALTIME_GAUGES);
  assertCatalogMatchesRegistry('HISTOGRAMS', Object.keys(REALTIME_HISTOGRAMS));
});

test('real-time operations guidance preserves the preview and privacy boundaries', () => {
  assert.match(runbook, /PostgreSQL is authoritative/i);
  assert.match(runbook, /Pub\/Sub.*(?:hint|ephemeral)|(?:hint|ephemeral).*Pub\/Sub/i);
  assert.match(runbook, /bearer-protected/i);
  assert.match(runbook, /Do not flush Redis/i);
  assert.match(runbook, /NOT_PRODUCTION_CERTIFIED \/ NO-GO/);
  assert.match(runbook, /Prompt logging remains disabled by default/);
});
