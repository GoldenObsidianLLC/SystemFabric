'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageInfo = require('../package.json');

function normalizeSbom(sbom, manifest = packageInfo) {
  if (!sbom || typeof sbom !== 'object' || Array.isArray(sbom)) {
    throw new TypeError('CycloneDX SBOM must be a JSON object.');
  }
  const component = sbom.metadata?.component;
  if (!component || component.type !== 'library') {
    throw new TypeError('CycloneDX SBOM must contain a root library component.');
  }

  const expectedRef = `${manifest.name}@${manifest.version}`;
  if (component['bom-ref'] !== expectedRef) {
    throw new Error(`SBOM root bom-ref does not match package.json (${expectedRef}).`);
  }
  if (component.purl !== `pkg:npm/${manifest.name}@${manifest.version}`) {
    throw new Error('SBOM root package URL does not match package.json.');
  }

  // npm derives this display name from the working-directory basename, which
  // differs between CI and developer worktrees. Normalize only the root name;
  // component identities, hashes, dependency edges and provenance remain intact.
  component.name = manifest.name;
  component.version = manifest.version;
  return sbom;
}

function main() {
  const target = path.resolve(process.argv[2] || path.join(root, 'artifacts', 'systemfabric.sbom.cdx.json'));
  const sbom = JSON.parse(fs.readFileSync(target, 'utf8'));
  normalizeSbom(sbom);
  fs.writeFileSync(target, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`SBOM normalization failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { normalizeSbom };
