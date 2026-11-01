'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSbom } = require('../scripts/normalize-sbom');

test('CycloneDX root component identity is independent of checkout directory name', () => {
  const packageInfo = { name: 'systemfabric', version: '0.5.1' };
  const sbom = {
    metadata: {
      component: {
        type: 'library',
        name: 'feature-worktree',
        version: '0.5.1',
        'bom-ref': 'systemfabric@0.5.1',
        purl: 'pkg:npm/systemfabric@0.5.1'
      }
    },
    components: [{ name: 'dependency-a', version: '1.2.3' }],
    dependencies: [{ ref: 'systemfabric@0.5.1', dependsOn: ['dependency-a@1.2.3'] }]
  };

  const normalized = normalizeSbom(sbom, packageInfo);
  assert.equal(normalized.metadata.component.name, 'systemfabric');
  assert.equal(normalized.metadata.component.version, '0.5.1');
  assert.deepEqual(normalized.components, [{ name: 'dependency-a', version: '1.2.3' }]);
  assert.deepEqual(normalized.dependencies, [{ ref: 'systemfabric@0.5.1', dependsOn: ['dependency-a@1.2.3'] }]);
});

test('CycloneDX normalization rejects a mismatched root package identity', () => {
  const sbom = {
    metadata: {
      component: {
        type: 'library',
        name: 'wrong',
        version: '0.5.1',
        'bom-ref': 'different@0.5.1',
        purl: 'pkg:npm/different@0.5.1'
      }
    }
  };
  assert.throws(() => normalizeSbom(sbom, { name: 'systemfabric', version: '0.5.1' }), /bom-ref does not match/);
});
