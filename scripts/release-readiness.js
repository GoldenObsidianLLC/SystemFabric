'use strict';

/**
 * Generates a fail-closed release readiness report. This script deliberately
 * separates source tests from deployment evidence: a green unit suite is not
 * equivalent to a production certification.
 *
 * Manual/CI evidence files belong under artifacts/evidence/<gate-id>.json and
 * must satisfy docs/RELEASE-EVIDENCE.md. Use --strict in a release pipeline to
 * fail if any required gate is blocked or missing evidence.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const artifactsDir = path.join(root, 'artifacts');
const evidenceDir = path.join(artifactsDir, 'evidence');
const strict = process.argv.includes('--strict');
const skipTests = process.argv.includes('--skip-tests');
fs.mkdirSync(evidenceDir, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE-MANIFEST.json'), 'utf8'));
const report = {
  schemaVersion: 1,
  product: 'SystemFabric',
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  host: { node: process.version, platform: process.platform, arch: process.arch },
  releaseClassification: manifest.releaseState,
  readyForProduction: false,
  checks: [],
  evidenceGates: [],
  summary: { pass: 0, partial: 0, blocked: 0, missingEvidence: 0, notRun: 0 }
};

function addCheck(id, title, status, details, evidencePath = null) {
  report.checks.push({ id, title, status, details, evidencePath });
}
function compareVersions(a, b) {
  const av = String(a).replace(/^v/, '').split('.').map(Number);
  const bv = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(av.length, bv.length); i += 1) {
    const delta = (av[i] || 0) - (bv[i] || 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}
function saveLog(filename, output) {
  const file = path.join(evidenceDir, filename);
  fs.writeFileSync(file, output || '(no output)\n');
  return path.relative(root, file);
}
function runNode(args, { cwd = root, timeout = 180_000 } = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const output = [result.stdout || '', result.stderr || ''].filter(Boolean).join('\n');
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    elapsedMs: Math.round(performance.now() - started),
    output
  };
}
function parseTap(output) {
  const get = (name) => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { tests: get('tests'), pass: get('pass'), fail: get('fail'), cancelled: get('cancelled'), skipped: get('skipped'), todo: get('todo') };
}
function evidenceFileStatus(id, title, evidenceFile) {
  const absolute = path.join(evidenceDir, evidenceFile);
  let status = 'MISSING_EVIDENCE';
  let details = `No evidence file at artifacts/evidence/${evidenceFile}.`;
  if (fs.existsSync(absolute)) {
    try {
      const value = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
      const artifactFilesValid = artifacts.every((artifact) => {
        if (typeof artifact !== 'string' || path.isAbsolute(artifact)) return false;
        const resolved = path.resolve(root, artifact);
        return (resolved === root || resolved.startsWith(`${root}${path.sep}`)) && fs.existsSync(resolved);
      });
      const complete = value.status === 'passed'
        && typeof value.executedAt === 'string'
        && !Number.isNaN(Date.parse(value.executedAt))
        && typeof value.command === 'string' && value.command.trim()
        && typeof value.environment === 'string' && value.environment.trim()
        && artifacts.length > 0 && artifactFilesValid;
      status = complete ? 'PASS' : 'BLOCKED';
      details = complete
        ? `Evidence validated; ${artifacts.length} referenced artifact(s).`
        : 'Evidence exists but does not satisfy the required schema, status, or artifact-path checks.';
    } catch (error) {
      status = 'BLOCKED';
      details = `Evidence JSON is invalid: ${error.message}`;
    }
  }
  report.evidenceGates.push({ id, title, status, evidencePath: `artifacts/evidence/${evidenceFile}`, details });
}

const minimumNode = String(pkg.engines?.node || '>=22.23.4').replace(/^>=?/, '').split(' ')[0];
const runtimeOk = compareVersions(process.versions.node, minimumNode) >= 0;
addCheck('supported-runtime', 'Supported Node.js runtime', runtimeOk ? 'PASS' : 'BLOCKED',
  `Required ${pkg.engines.node}; running ${process.version}.`);

const lockPath = path.join(root, 'package-lock.json');
const lockExists = fs.existsSync(lockPath);
let lockTracked = false;
if (fs.existsSync(path.join(root, '.git'))) {
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'package-lock.json'], { cwd: root, encoding: 'utf8' });
  lockTracked = tracked.status === 0;
}
addCheck('reviewed-lockfile', 'Reviewed and committed npm lockfile', lockExists && lockTracked ? 'PASS' : 'BLOCKED',
  !lockExists ? 'package-lock.json is absent; reproducible npm ci cannot be certified.'
    : !lockTracked ? 'package-lock.json exists but this checkout cannot verify it is tracked/committed in Git.'
      : 'package-lock.json is present and tracked; a human dependency review is still required.');

const requiredMigrations = [
  '0001_initial.sql', '0002_identity_workflows_plugins.sql', '0003_identity_editor_ai.sql',
  '0004_governance_taxonomy_release.sql', '0005_saml_shared_cache.sql',
  '0006_platform_libraries_commerce_social_billing.sql', '0007_release_hardening.sql',
  '0008_checkout_stock_reservation_lifecycle.sql', '0009_fix_content_item_slug_constraint.sql'
];
const missingMigrations = requiredMigrations.filter(file => !fs.existsSync(path.join(root, 'database/migrations', file)));
addCheck('migration-artifacts', 'Versioned migration files', missingMigrations.length ? 'BLOCKED' : 'PASS',
  missingMigrations.length ? `Missing: ${missingMigrations.join(', ')}` : `${requiredMigrations.length} migration files are present; live fresh/upgrade execution is a separate gate.`);

if (!skipTests) {
  const verify = runNode(['scripts/verify.js']);
  const verifyLog = saveLog('artifact-check.log', verify.output);
  addCheck('syntax-artifact-check', 'Required artifacts and JavaScript syntax', verify.exitCode === 0 ? 'PASS' : 'BLOCKED',
    `Exit ${verify.exitCode}; ${verify.elapsedMs} ms. ${verify.output.trim().split('\n').slice(-2).join(' | ')}`, verifyLog);

  const unitFiles = fs.readdirSync(path.join(root, 'test')).filter(file => file.endsWith('.test.js')).sort().map(file => `test/${file}`);
  const unit = runNode(['--test', '--test-reporter=tap', ...unitFiles]);
  const unitLog = saveLog('unit-tests.tap.log', unit.output);
  const unitCounts = parseTap(unit.output);
  addCheck('unit-tests', 'SystemFabric unit/security tests', unit.exitCode === 0 && unitCounts.fail === 0 ? 'PASS' : 'BLOCKED',
    `Exit ${unit.exitCode}; ${JSON.stringify(unitCounts)}; ${unit.elapsedMs} ms. Test execution is on ${process.version}.`, unitLog);

  const vendorFiles = fs.readdirSync(path.join(root, 'vendor/enginex/test')).filter(file => file.endsWith('.test.js')).sort().map(file => `test/${file}`);
  const vendor = runNode(['--test', '--test-reporter=tap', ...vendorFiles], { cwd: path.join(root, 'vendor/enginex') });
  const vendorLog = saveLog('enginex-tests.tap.log', vendor.output);
  const vendorCounts = parseTap(vendor.output);
  addCheck('enginex-tests', 'Vendored EnginEx unit tests', vendor.exitCode === 0 && vendorCounts.fail === 0 ? 'PASS' : 'BLOCKED',
    `Exit ${vendor.exitCode}; ${JSON.stringify(vendorCounts)}; ${vendor.elapsedMs} ms.`, vendorLog);

  const integrationFiles = fs.readdirSync(path.join(root, 'test/integration')).filter(file => file.endsWith('.test.js')).sort().map(file => `test/integration/${file}`);
  const integration = runNode(['--test', '--test-reporter=tap', ...integrationFiles]);
  const integrationLog = saveLog('integration-tests.tap.log', integration.output);
  const integrationCounts = parseTap(integration.output);
  const integrationStatus = integration.exitCode !== 0 || (integrationCounts.fail || 0) > 0 ? 'BLOCKED'
    : (integrationCounts.skipped || 0) > 0 ? 'PARTIAL' : 'PASS';
  addCheck('integration-tests', 'PostgreSQL/Memgraph/product integration tests', integrationStatus,
    `Exit ${integration.exitCode}; ${JSON.stringify(integrationCounts)}; ${integration.elapsedMs} ms. Skipped tests do not count as production validation.`, integrationLog);
} else {
  for (const [id, title] of [['syntax-artifact-check', 'Required artifacts and JavaScript syntax'], ['unit-tests', 'SystemFabric unit/security tests'], ['enginex-tests', 'Vendored EnginEx unit tests'], ['integration-tests', 'PostgreSQL/Memgraph/product integration tests']]) {
    addCheck(id, title, 'NOT_RUN', 'Skipped because --skip-tests was supplied.');
  }
}

const playwrightAvailable = (() => {
  try { require.resolve('@playwright/test', { paths: [root] }); return true; } catch { return false; }
})();
addCheck('playwright-installed', 'Playwright dependency available', playwrightAvailable ? 'PASS' : 'BLOCKED',
  playwrightAvailable ? '@playwright/test resolves in this checkout; browser execution and results are separate gates.' : '@playwright/test is not installed/resolvable in this checkout.');

const currentGates = [
  ['postgres-memgraph-live', 'Fresh/upgrade migrations, PostgreSQL transactions and Memgraph outage/replay', 'postgres-memgraph-live.json'],
  ['tenant-isolation-review', 'Independent tenant-isolation and authorization review', 'tenant-isolation-review.json'],
  ['identity-provider-e2e', 'OIDC/SAML/email delivery/MFA recovery end-to-end evidence', 'identity-provider-e2e.json'],
  ['clamav-corpus', 'Live ClamAV, malicious-file corpus and legacy-asset quarantine', 'clamav-corpus.json'],
  ['cloud-live-providers', 'Live S3/GCS/Azure/S3-compatible credentials and least-privilege operations', 'cloud-live-providers.json'],
  ['stripe-live-lifecycle', 'Stripe webhook replay, ambiguous-outcome recovery and inventory lifecycle', 'stripe-live-lifecycle.json'],
  ['browser-accessibility', 'Playwright editor journeys and WCAG-focused accessibility acceptance', 'browser-accessibility.json'],
  ['commerce-parity-acceptance', 'Tax/shipping/coupons/refunds/fulfilment/downloads/subscription acceptance', 'commerce-parity-acceptance.json'],
  ['community-parity-acceptance', 'Group privacy, spam/abuse, search, export/deletion and forum acceptance', 'community-parity-acceptance.json'],
  ['plugin-container-isolation', 'Signed plugin pipeline and adversarial container isolation', 'plugin-container-isolation.json'],
  ['dependency-sbom-codeql', 'Reviewed dependency audit, SBOM/provenance and CodeQL evidence', 'dependency-sbom-codeql.json'],
  ['load-backup-restore', 'Load/soak, fault injection, backup/restore and recovery drills', 'load-backup-restore.json'],
  ['independent-security-review', 'Independent security assessment and severe-finding remediation', 'independent-security-review.json'],
  ['operations-release-approval', 'Deployment runbooks, secrets/rollback plan, monitoring and release approval', 'operations-release-approval.json']
];
for (const gate of currentGates) evidenceFileStatus(...gate);

const statuses = [...report.checks, ...report.evidenceGates].map(item => item.status);
for (const status of statuses) {
  if (status === 'PASS') report.summary.pass += 1;
  else if (status === 'PARTIAL') report.summary.partial += 1;
  else if (status === 'MISSING_EVIDENCE') report.summary.missingEvidence += 1;
  else if (status === 'NOT_RUN') report.summary.notRun += 1;
  else report.summary.blocked += 1;
}
report.readyForProduction = statuses.length > 0 && statuses.every(status => status === 'PASS');
report.releaseClassification = report.readyForProduction ? 'PRODUCTION_RELEASE_GATES_PASSED' : 'NOT_PRODUCTION_CERTIFIED';

const jsonFile = path.join(artifactsDir, 'release-readiness.json');
const markdownFile = path.join(artifactsDir, 'release-readiness.md');
fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`);
const rows = [...report.checks, ...report.evidenceGates].map(item => `| ${item.title.replace(/\|/g, '\\|')} | **${item.status}** | ${item.details.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n');
const markdown = `# SystemFabric ${pkg.version} — Release Readiness Report\n\n- Generated: ${report.generatedAt}\n- Node.js: ${process.version} (${process.platform}/${process.arch})\n- Production-ready: **${report.readyForProduction ? 'YES' : 'NO'}**\n- Release classification: \`${report.releaseClassification}\`\n- Summary: ${report.summary.pass} pass; ${report.summary.partial} partial; ${report.summary.blocked} blocked; ${report.summary.missingEvidence} missing evidence; ${report.summary.notRun} not run.\n\n> A successful source test suite does not substitute for live integrations, independent review, deployment drills, or parity acceptance. Missing or skipped evidence is not a pass.\n\n| Gate | Status | Details |\n|---|---|---|\n${rows}\n\nJSON source of truth: \`artifacts/release-readiness.json\`. See \`docs/RELEASE-EVIDENCE.md\` for evidence format.\n`;
fs.writeFileSync(markdownFile, markdown);
console.log(markdown);
console.log(`Wrote ${path.relative(root, jsonFile)} and ${path.relative(root, markdownFile)}.`);
if (strict && !report.readyForProduction) process.exitCode = 1;
