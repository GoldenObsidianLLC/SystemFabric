'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateObservabilityDeploymentManifest } = require('../packages/observability/src/deployment-contract');
const { readRegularFile } = require('./configure-otel-dev');

const repositoryRoot = path.resolve(__dirname, '..');
const defaultManifest = path.join(repositoryRoot, 'artifacts', 'evidence', 'observability-production.json');

function usage() {
  console.log('Usage: node scripts/validate-observability-deployment.js [manifest.json]');
  console.log('Validates explicit production OTLP deployment evidence; it never deploys or configures a collector.');
}

function resolveManifestPath(inputPath) {
  const candidate = path.resolve(repositoryRoot, inputPath);
  const relative = path.relative(repositoryRoot, candidate);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Manifest path must be inside the repository.');
  }
  const metadata = fs.lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Manifest must be a regular, non-symbolic-link file.');
  }
  const realPath = fs.realpathSync(candidate);
  const realRelative = path.relative(repositoryRoot, realPath);
  if (!realRelative || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
    throw new Error('Manifest path resolves outside the repository.');
  }
  return realPath;
}

function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return 0;
  }
  if (args.length > 1) {
    usage();
    console.error('Provide at most one manifest path.');
    return 2;
  }

  const inputPath = args[0] || path.relative(repositoryRoot, defaultManifest);
  let manifest;
  try {
    const resolved = resolveManifestPath(inputPath);
    manifest = JSON.parse(readRegularFile(fs.realpathSync(repositoryRoot), resolved));
  } catch (error) {
    console.error('OBSERVABILITY DEPLOYMENT: BLOCKED');
    console.error(error.code === 'ENOENT'
      ? 'Production evidence manifest is missing. Copy the documented template and complete it with deployment-approved evidence.'
      : 'Could not safely read or parse the production evidence manifest.');
    return 2;
  }

  const result = validateObservabilityDeploymentManifest(manifest);
  if (!result.ready) {
    console.error('OBSERVABILITY DEPLOYMENT: BLOCKED (' + result.errors.length + ' issue(s))');
    for (const error of result.errors) {
      console.error('- ' + error.path + ': ' + error.code);
    }
    return 1;
  }

  console.log('OBSERVABILITY DEPLOYMENT: STRUCTURAL EVIDENCE VALIDATION PASSED');
  console.log('Backend, security, governance, ownership, delivery, and evidence declarations are complete.');
  console.log('Human verification of external references and independent deployment approval remain required.');
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, resolveManifestPath };
