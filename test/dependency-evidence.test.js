'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSbom, renderGenerationLog } = require('../scripts/generate-sbom');

test('CycloneDX summary reflects the actual component and dependency records', () => {
  const summary = summarizeSbom({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: { component: { name: 'VirgoScorpio Hub', version: '0.5.1' } },
    components: [
      { name: 'sharp', version: '0.35.5', licenses: [{ license: { id: 'Apache-2.0' } }] },
      { name: '@img/sharp-libvips-linux-x64', version: '1.3.4', licenses: [{ license: { id: 'LGPL-3.0-or-later' } }] },
      { name: '@img/sharp-wasm32', version: '0.35.5', licenses: [{ expression: 'Apache-2.0 AND LGPL-3.0-or-later AND MIT' }] }
    ],
    dependencies: [{ ref: 'pkg:npm/virgoscorpio-hub@0.5.1', dependsOn: [] }, { ref: 'pkg:npm/sharp@0.35.5', dependsOn: [] }]
  }, { name: 'virgoscorpio_hub', version: '0.5.1' });

  assert.equal(summary.format, 'CycloneDX');
  assert.equal(summary.specVersion, '1.5');
  assert.equal(summary.rootName, 'virgoscorpio_hub');
  assert.equal(summary.rootVersion, '0.5.1');
  assert.equal(summary.components, 3);
  assert.equal(summary.dependencies, 2);
  assert.deepEqual(summary.licenseCounts, {
    'Apache-2.0': 1,
    'Apache-2.0 AND LGPL-3.0-or-later AND MIT': 1,
    'LGPL-3.0-or-later': 1
  });
  assert.deepEqual(summary.unidentified, []);
  assert.equal(summary.lgplComponents.length, 2);
});

test('CycloneDX summary fails closed for malformed BOM documents', () => {
  assert.throws(() => summarizeSbom(null), /valid CycloneDX/);
  assert.throws(() => summarizeSbom({ bomFormat: 'SPDX', components: [], dependencies: [] }), /valid CycloneDX/);
  assert.throws(() => summarizeSbom({ bomFormat: 'CycloneDX', components: [], dependencies: null }), /valid CycloneDX/);
});

test('SBOM generation log records exact counts, lockfile/SBOM hashes, host and license gaps', () => {
  const log = renderGenerationLog({
    summary: {
      format: 'CycloneDX',
      specVersion: '1.5',
      rootName: 'VirgoScorpio Hub',
      rootVersion: '0.5.1',
      components: 167,
      dependencies: 168,
      licenseCounts: { 'LGPL-3.0-or-later': 2, 'MIT': 107 },
      unidentified: [{ name: 'example-no-license', version: '1.0.0' }],
      lgplComponents: [{ name: '@img/sharp-libvips-linux-x64', version: '1.3.4', licenses: ['LGPL-3.0-or-later'] }]
    },
    nodeVersion: 'v22.23.4',
    npmUserAgent: 'npm/10.9.4 node/v22.23.4 linux x64 workspaces/false',
    platform: 'linux',
    architecture: 'x64',
    lockHash: 'lock-hash',
    sbomHash: 'sbom-hash',
    generatedAt: '2026-11-01T18:00:00.000Z'
  });

  assert.match(log, /Components: 167/);
  assert.match(log, /Dependency records: 168/);
  assert.match(log, /npm: 10\.9\.4/);
  assert.match(log, /package-lock\.json SHA-256: lock-hash/);
  assert.match(log, /virgoscorpio-hub\.sbom\.cdx\.json SHA-256: sbom-hash/);
  assert.match(log, /Components without an identified license: 1/);
  assert.match(log, /example-no-license@1\.0\.0/);
  assert.match(log, /@img\/sharp-libvips-linux-x64@1\.3\.4/);
});
