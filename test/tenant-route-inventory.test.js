'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const inventoryPath = path.join(root, 'artifacts/security/tenant-isolation-route-inventory.json');

test('tenant-isolation route inventory is generated, source-anchored and current', () => {
  const check = spawnSync(process.execPath, [
    'scripts/generate-tenant-isolation-route-inventory.js',
    '--check'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));

  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.notAnIndependentAssessment, true);
  assert.equal(inventory.status, 'MAINTAINER_PREPARED_NOT_INDEPENDENTLY_REVIEWED');
  assert.ok(inventory.summary.routeFamilyCount >= 20);
  assert.ok(inventory.summary.declaredRoutePatternCount >= 40);
  assert.ok(/^[a-f0-9]{64}$/.test(inventory.sourceTree.sha256));
  assert.ok(/^[a-f0-9]{64}$/.test(inventory.testTree.sha256));
  assert.ok(inventory.families.some(family => family.id === 'site-membership-administration'));
  assert.ok(inventory.families.some(family => family.id === 'public-media-and-library-assets'));
  assert.ok(inventory.families.some(family => family.id === 'postgres-outbox-and-workers'));

  for (const family of inventory.families) {
    assert.ok(Array.isArray(family.methods) && family.methods.length > 0, family.id + ' needs method metadata');
    assert.ok(family.sourceRefs.length > 0, family.id + ' needs source refs');
    for (const reference of family.sourceRefs) {
      assert.ok(reference.anchors.length > 0, family.id + ' needs source anchors');
      for (const anchor of reference.anchors) {
        assert.ok(anchor.lines.length > 0, family.id + ' has an unresolved source anchor');
        assert.ok(anchor.lines.every(line => Number.isInteger(line) && line > 0));
      }
    }
    for (const testFile of family.tests) {
      assert.equal(fs.existsSync(path.join(root, testFile)), true, family.id + ' test reference missing: ' + testFile);
    }
  }
});

test('generated inventory explicitly preserves the independent-review boundary', () => {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const markdown = fs.readFileSync(path.join(root, 'docs/security/TENANT-ISOLATION-ROUTE-CAPABILITY-MAP-2026-11-07.md'), 'utf8');
  assert.match(markdown, /NOT AN INDEPENDENT REVIEW/);
  assert.match(markdown, /Issue #14 remains OPEN \/ NOT PERFORMED/);
  assert.match(markdown, /artifacts\/evidence\/tenant-isolation-review\.json/);
  assert.equal(inventory.notAnIndependentAssessment, true);
});
