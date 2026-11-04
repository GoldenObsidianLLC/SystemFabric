'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const EVIDENCE = path.join(ARTIFACTS, 'evidence');
const SBOM_PATH = path.join(ARTIFACTS, 'virgoscorpio-hub.sbom.cdx.json');
const LOG_PATH = path.join(EVIDENCE, 'sbom-generation.log');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function licenseLabel(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.expression === 'string' && entry.expression.trim()) return entry.expression.trim();
  if (entry.license && typeof entry.license.id === 'string' && entry.license.id.trim()) return entry.license.id.trim();
  if (entry.license && typeof entry.license.name === 'string' && entry.license.name.trim()) return entry.license.name.trim();
  return null;
}

function summarizeSbom(bom, packageManifest = null) {
  if (!bom || bom.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components) || !Array.isArray(bom.dependencies)) {
    throw new Error('npm sbom did not return a valid CycloneDX component/dependency document.');
  }

  const licenseCounts = new Map();
  const unidentified = [];
  const lgplComponents = [];
  for (const component of bom.components) {
    const labels = (Array.isArray(component.licenses) ? component.licenses : [])
      .map(licenseLabel).filter(Boolean);
    if (!labels.length) unidentified.push({
      name: component.name || '<unnamed>',
      version: component.version || '<unknown>'
    });
    for (const label of labels) licenseCounts.set(label, (licenseCounts.get(label) || 0) + 1);
    if (labels.some(label => /LGPL/i.test(label))) {
      lgplComponents.push({
        name: component.name || '<unnamed>',
        version: component.version || '<unknown>',
        licenses: labels
      });
    }
  }

  return {
    format: bom.bomFormat,
    specVersion: bom.specVersion || 'unspecified',
    rootName: packageManifest && packageManifest.name || bom.metadata && bom.metadata.component && bom.metadata.component.name || 'unspecified',
    rootVersion: packageManifest && packageManifest.version || bom.metadata && bom.metadata.component && bom.metadata.component.version || 'unspecified',
    components: bom.components.length,
    dependencies: bom.dependencies.length,
    licenseCounts: Object.fromEntries([...licenseCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    unidentified,
    lgplComponents
  };
}

function renderGenerationLog(input) {
  const summary = input.summary;
  const npmUserAgent = input.npmUserAgent || '';
  const match = npmUserAgent.match(/(?:^|\s)npm\/([^\s]+)/);
  const npmVersion = match ? match[1] : 'unavailable';
  const licenseSummary = Object.entries(summary.licenseCounts)
    .map(entry => entry[0] + ' (' + entry[1] + ')').join('; ') || 'none';
  const lgplSummary = summary.lgplComponents.map(item =>
    item.name + '@' + item.version + ' [' + item.licenses.join(' AND ') + ']'
  ).join('; ') || 'none';

  const lines = [
    'VirgoScorpio Hub CycloneDX SBOM generation evidence',
    'Generated at: ' + input.generatedAt,
    'Command: npm sbom --sbom-format=cyclonedx --omit=dev',
    'Node.js: ' + input.nodeVersion,
    'npm: ' + npmVersion,
    'npm user-agent: ' + (npmUserAgent || 'unavailable'),
    'Host: ' + input.platform + '/' + input.architecture,
    'Package: ' + summary.rootName + '@' + summary.rootVersion,
    'Format: ' + summary.format + ' ' + summary.specVersion,
    'Components: ' + summary.components,
    'Dependency records: ' + summary.dependencies,
    'package-lock.json SHA-256: ' + input.lockHash,
    'virgoscorpio-hub.sbom.cdx.json SHA-256: ' + input.sbomHash,
    'License identifiers/expressions: ' + licenseSummary,
    'Components without an identified license: ' + summary.unidentified.length,
    'Components with LGPL license terms: ' + lgplSummary
  ];
  if (summary.unidentified.length) {
    lines.push('Unidentified license components:');
    for (const item of summary.unidentified) lines.push('- ' + item.name + '@' + item.version);
  }
  return lines.join('\n') + '\n';
}

function generateSbom() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  if (!fs.existsSync(LOCK_PATH)) throw new Error('package-lock.json is required to generate release dependency evidence.');

  const npmCli = process.env.npm_execpath;
  const command = npmCli
    ? spawnSync(process.execPath, [npmCli, 'sbom', '--sbom-format=cyclonedx', '--omit=dev'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
    })
    : spawnSync('npm', ['sbom', '--sbom-format=cyclonedx', '--omit=dev'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32'
    });

  if (command.error) {
    throw new Error('Unable to launch npm SBOM command (npm_execpath=' + String(npmCli) +
      ', code=' + String(command.error.code) + ', errno=' + String(command.error.errno) +
      ', syscall=' + String(command.error.syscall) + '): ' + command.error.message);
  }
  if (command.status !== 0) {
    throw new Error('npm sbom failed with exit code ' + command.status + ': ' + (command.stderr || command.stdout || 'no diagnostic output'));
  }

  const sbomBytes = Buffer.from(command.stdout || '', 'utf8');
  let bom;
  try { bom = JSON.parse(sbomBytes.toString('utf8')); }
  catch (cause) { throw new Error('npm sbom returned invalid JSON: ' + cause.message); }

  const packageManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const expectedRootPurl = 'pkg:npm/' + packageManifest.name + '@' + packageManifest.version;
  const actualRootPurl = bom.metadata && bom.metadata.component && bom.metadata.component.purl;
  if (actualRootPurl && actualRootPurl !== expectedRootPurl) {
    throw new Error('SBOM package identity does not match package.json: ' + actualRootPurl);
  }
  const summary = summarizeSbom(bom, packageManifest);
  const lockHash = sha256(fs.readFileSync(LOCK_PATH));
  const sbomHash = sha256(sbomBytes);
  const generatedAt = new Date().toISOString();
  const npmUserAgent = process.env.npm_config_user_agent || '';
  const log = renderGenerationLog({
    summary,
    nodeVersion: process.version,
    npmUserAgent,
    platform: process.platform,
    architecture: process.arch,
    lockHash,
    sbomHash,
    generatedAt
  });

  fs.writeFileSync(SBOM_PATH, sbomBytes);
  fs.writeFileSync(LOG_PATH, log, 'utf8');
  process.stdout.write(log);

  if (summary.unidentified.length) {
    throw new Error('SBOM generation completed but one or more components have no identifiable license; dependency review is required.');
  }
  return summary;
}

if (require.main === module) {
  try { generateSbom(); }
  catch (error) {
    console.error('SBOM generation failed: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { generateSbom, summarizeSbom, renderGenerationLog };
