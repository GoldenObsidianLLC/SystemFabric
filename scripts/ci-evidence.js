'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PRODUCT_VERSION } = require('../packages/domain/src/version');
const {
  hasNoHighAuditFindings,
  hasSuccessfulPlaywrightSummary,
  isFreshMigrationEvidence,
  parseTapSummary,
} = require('./release-readiness-validation');

const WORKFLOW_FILE = '.github/workflows/ci.yml';
const packageManager = require('../package.json').packageManager;
const EXPECTED_NPM_VERSION = /^npm@(\d+\.\d+\.\d+)$/.exec(packageManager || '')?.[1] || null;
if (!EXPECTED_NPM_VERSION) throw new Error('package.json must pin an exact npm packageManager version.');

function normalizeSbomInventory(sbom) {
  if (sbom?.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
    throw new Error('SBOM must contain CycloneDX components and dependency records.');
  }
  const aliases = new Map();
  const componentIds = new Set();
  const addComponent = component => {
    if (!component || typeof component !== 'object') throw new Error('SBOM component record is invalid.');
    const id = component.purl || component['bom-ref'] || (component.name && component.version ? component.name + '@' + component.version : null);
    if (typeof id !== 'string' || !id) throw new Error('SBOM component lacks a stable package identity.');
    componentIds.add(id);
    if (typeof component['bom-ref'] === 'string') aliases.set(component['bom-ref'], id);
    if (typeof component.purl === 'string') aliases.set(component.purl, id);
  };
  if (sbom.metadata?.component) addComponent(sbom.metadata.component);
  for (const component of sbom.components) addComponent(component);
  const normalizeRef = reference => aliases.get(reference) || reference;
  const dependencies = sbom.dependencies.map(entry => {
    if (!entry || typeof entry.ref !== 'string' || !entry.ref || !Array.isArray(entry.dependsOn || [])) {
      throw new Error('SBOM dependency record is invalid.');
    }
    return [
      normalizeRef(entry.ref),
      [...new Set((entry.dependsOn || []).map(normalizeRef))].sort(),
    ];
  }).sort((left, right) => left[0].localeCompare(right[0]));
  return {
    components: [...componentIds].sort(),
    dependencies,
  };
}

function compareSbomInventories(leftSbom, rightSbom) {
  const left = normalizeSbomInventory(leftSbom);
  const right = normalizeSbomInventory(rightSbom);
  const leftComponents = new Set(left.components);
  const rightComponents = new Set(right.components);
  const leftEdges = new Set(left.dependencies.flatMap(([ref, targets]) => targets.map(target => ref + ' -> ' + target)));
  const rightEdges = new Set(right.dependencies.flatMap(([ref, targets]) => targets.map(target => ref + ' -> ' + target)));
  const leftOnlyComponents = [...leftComponents].filter(id => !rightComponents.has(id)).sort();
  const rightOnlyComponents = [...rightComponents].filter(id => !leftComponents.has(id)).sort();
  const leftOnlyEdges = [...leftEdges].filter(edge => !rightEdges.has(edge)).sort();
  const rightOnlyEdges = [...rightEdges].filter(edge => !leftEdges.has(edge)).sort();
  return {
    same: leftOnlyComponents.length === 0 && rightOnlyComponents.length === 0 &&
      leftOnlyEdges.length === 0 && rightOnlyEdges.length === 0,
    leftOnlyComponents,
    rightOnlyComponents,
    leftOnlyEdges,
    rightOnlyEdges,
  };
}

const JOBS = [
  {
    key: 'node-22.23.4',
    artifactName: 'virgoscorpio_hub-ci-evidence-node-22.23.4',
    jobName: 'Unit, security, and dependency checks (Node 22.23.4)',
    runtime: 'v22.23.4',
    requiredFiles: [
      'artifacts/release-readiness.json',
      'artifacts/release-readiness.md',
      'artifacts/virgoscorpio-hub.sbom.cdx.json',
      'artifacts/evidence/npm-audit-all.log',
      'artifacts/evidence/npm-audit.log',
      'artifacts/evidence/sbom-generation.log',
      'artifacts/evidence/artifact-check.log',
      'artifacts/evidence/unit-tests.tap.log',
      'artifacts/evidence/enginex-tests.tap.log',
      'artifacts/evidence/integration-tests.tap.log',
      'package-lock.json',
    ],
  },
  {
    key: 'node-24.22.1',
    artifactName: 'virgoscorpio_hub-ci-evidence-node-24.22.1',
    jobName: 'Unit, security, and dependency checks (Node 24.22.1)',
    runtime: 'v24.22.1',
    requiredFiles: [
      'artifacts/release-readiness.json',
      'artifacts/release-readiness.md',
      'artifacts/virgoscorpio-hub.sbom.cdx.json',
      'artifacts/evidence/npm-audit-all.log',
      'artifacts/evidence/npm-audit.log',
      'artifacts/evidence/sbom-generation.log',
      'artifacts/evidence/artifact-check.log',
      'artifacts/evidence/unit-tests.tap.log',
      'artifacts/evidence/enginex-tests.tap.log',
      'artifacts/evidence/integration-tests.tap.log',
      'package-lock.json',
    ],
  },
  {
    key: 'postgres-memgraph-integration',
    artifactName: 'virgoscorpio_hub-ci-evidence-postgres-memgraph-integration',
    jobName: 'PostgreSQL and Memgraph integration',
    runtime: 'v22.23.4',
    requiredFiles: [
      'artifacts/evidence/integration-live.json',
      'artifacts/evidence/integration-tests.tap.log',
      'artifacts/evidence/integration-migrations.log',
      'artifacts/evidence/fresh-migrations.json',
      'artifacts/evidence/fresh-migrations.log',
      'artifacts/evidence/memgraph-outage-live.log',
      'artifacts/evidence/graph-rebuild-live.log',
    ],
  },
  {
    key: 'browser-and-accessibility',
    artifactName: 'virgoscorpio_hub-ci-evidence-browser-and-accessibility',
    jobName: 'Browser editor and accessibility smoke tests',
    runtime: 'v22.23.4',
    requiredFiles: ['artifacts/evidence/browser-smoke.log'],
  },
  {
    key: 'security-static-analysis',
    artifactName: 'virgoscorpio_hub-ci-evidence-security-static-analysis',
    jobName: 'CodeQL security analysis',
    runtime: 'not-applicable',
    requiredFiles: [],
  },
];

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error('Artifact path must be a non-empty repository-relative POSIX path.');
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error('Absolute artifact paths are not allowed.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Artifact path contains an unsafe path segment.');
  return parts;
}

function resolveRegularPath(root, relativePath, { allowDirectory = false } = {}) {
  const parts = validateRelativePath(relativePath);
  const absoluteRoot = path.resolve(root);
  let current = absoluteRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not accepted in CI evidence.');
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) throw new Error('Artifact path contains a non-directory parent.');
    if (last && !(stat.isFile() || (allowDirectory && stat.isDirectory()))) {
      throw new Error('Artifact path must identify a regular file or an explicitly allowed directory.');
    }
  }
  if (!isWithin(absoluteRoot, current)) throw new Error('Artifact path resolves outside its root.');
  return current;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkRegularFiles(root, relativeDirectory) {
  const absolute = resolveRegularPath(root, relativeDirectory, { allowDirectory: true });
  if (!fs.statSync(absolute).isDirectory()) return [relativeDirectory];
  const results = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relativeDirectory + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not accepted in CI evidence.');
    if (entry.isDirectory()) results.push(...walkRegularFiles(root, child));
    else if (entry.isFile()) results.push(child);
    else throw new Error('Special files are not accepted in CI evidence.');
  }
  return results;
}

function copyEvidenceFiles({ root, stageDirectory, files }) {
  const absoluteRoot = path.resolve(root);
  const absoluteStage = path.resolve(absoluteRoot, stageDirectory);
  if (!isWithin(absoluteRoot, absoluteStage) || absoluteStage === absoluteRoot) {
    throw new Error('The evidence staging directory must be inside the repository root.');
  }
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Repository root must be a real directory.');
  let cursor = absoluteRoot;
  for (const segment of path.relative(absoluteRoot, absoluteStage).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Evidence staging path contains a symlink or non-directory.');
    } else fs.mkdirSync(cursor);
  }
  fs.rmSync(absoluteStage, { recursive: true, force: true });
  fs.mkdirSync(path.join(absoluteStage, 'files'), { recursive: true });
  const copied = [];
  for (const source of files) {
    const parts = validateRelativePath(source);
    const absoluteSource = path.join(absoluteRoot, ...parts);
    if (!fs.existsSync(absoluteSource)) continue;
    const stat = fs.lstatSync(absoluteSource);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not accepted in CI evidence.');
    const toCopy = stat.isDirectory() ? walkRegularFiles(absoluteRoot, source) : [source];
    for (const relativeFile of toCopy) {
      const sourcePath = resolveRegularPath(absoluteRoot, relativeFile);
      const targetRelative = 'files/' + relativeFile;
      const targetPath = path.join(absoluteStage, ...validateRelativePath(targetRelative));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      const fileStat = fs.statSync(targetPath);
      copied.push({
        path: targetRelative,
        sizeBytes: fileStat.size,
        sha256: sha256File(targetPath),
      });
    }
  }
  return copied.sort((a, b) => a.path.localeCompare(b.path));
}

function buildManifest(metadata, artifacts) {
  const requiredStrings = ['repository', 'workflow', 'eventName', 'runId', 'headSha', 'mergeSha', 'jobKey', 'jobName', 'runtime'];
  for (const field of requiredStrings) {
    if (typeof metadata[field] !== 'string' || !metadata[field].trim()) throw new Error('Missing CI evidence metadata: ' + field);
  }
  if (!/^[0-9a-f]{40}$/i.test(metadata.headSha) || !/^[0-9a-f]{40}$/i.test(metadata.mergeSha)) {
    throw new Error('CI evidence source revisions must be full 40-character Git SHAs.');
  }
  if (!/^\d+$/.test(metadata.runId)) throw new Error('CI run ID must be numeric.');
  if (!Number.isInteger(metadata.runAttempt) || metadata.runAttempt < 1) throw new Error('CI run attempt must be a positive integer.');
  return {
    schemaVersion: 1,
    repository: metadata.repository,
    workflow: metadata.workflow,
    workflowFile: WORKFLOW_FILE,
    eventName: metadata.eventName,
    runId: String(metadata.runId),
    runAttempt: metadata.runAttempt,
    headSha: metadata.headSha.toLowerCase(),
    mergeSha: metadata.mergeSha.toLowerCase(),
    jobKey: metadata.jobKey,
    jobName: metadata.jobName,
    runtime: metadata.runtime,
    generatedAt: new Date().toISOString(),
    artifacts,
  };
}

function stageEvidence({ root, stageDirectory, files, metadata }) {
  const artifacts = copyEvidenceFiles({ root, stageDirectory, files });
  const manifest = buildManifest(metadata, artifacts);
  const target = path.join(path.resolve(root), ...validateRelativePath(stageDirectory), 'manifest.json');
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

function validateManifestDirectory(directory, expected) {
  const errors = [];
  let manifest;
  try {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Artifact root must be a real directory, not a symbolic link.');
    }
    const manifestFile = path.join(directory, 'manifest.json');
    // O_NOFOLLOW rejects symlinks atomically where the platform supports it.
    // On platforms without it, bind a pre-open lstat identity to the descriptor.
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    let pathStat = null;
    if (!noFollow) {
      pathStat = fs.lstatSync(manifestFile);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error('Manifest must be a regular file.');
    }
    const descriptor = fs.openSync(manifestFile, fs.constants.O_RDONLY | noFollow);
    let manifestSource;
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || (pathStat && (before.dev !== pathStat.dev || before.ino !== pathStat.ino))) {
        throw new Error('Manifest changed before it could be opened safely.');
      }
      const beforeSignature = before.size + ':' + before.mtimeMs + ':' + before.ctimeMs;
      manifestSource = fs.readFileSync(descriptor, 'utf8');
      const after = fs.fstatSync(descriptor);
      const afterSignature = after.size + ':' + after.mtimeMs + ':' + after.ctimeMs;
      if (!after.isFile() || beforeSignature !== afterSignature) {
        throw new Error('Manifest changed while it was being read.');
      }
    } finally {
      fs.closeSync(descriptor);
    }
    manifest = JSON.parse(manifestSource);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('Manifest root must be a JSON object.');
    }
  } catch (error) {
    return { valid: false, errors: ['Manifest is missing or unreadable: ' + error.message], manifest: null, artifacts: [] };
  }

  if (manifest.schemaVersion !== 1) errors.push('Unsupported manifest schema version.');
  const allowedFields = new Set(['schemaVersion', 'repository', 'workflow', 'workflowFile', 'eventName', 'runId', 'runAttempt', 'headSha', 'mergeSha', 'jobKey', 'jobName', 'runtime', 'generatedAt', 'artifacts']);
  for (const field of Object.keys(manifest)) {
    if (!allowedFields.has(field)) errors.push('Unknown manifest field: ' + field + '.');
  }
  const fields = ['repository', 'workflow', 'workflowFile', 'eventName', 'runId', 'runAttempt', 'headSha', 'mergeSha', 'jobKey', 'jobName', 'runtime'];
  for (const field of fields) {
    if (manifest[field] !== expected[field]) errors.push('Manifest metadata mismatch: ' + field + '.');
  }
  const generatedAt = typeof manifest.generatedAt === 'string' ? new Date(manifest.generatedAt) : null;
  if (!generatedAt || !Number.isFinite(generatedAt.valueOf()) || generatedAt.toISOString() !== manifest.generatedAt) {
    errors.push('Manifest generation timestamp is not a normalized UTC ISO timestamp.');
  }
  if (!Array.isArray(manifest.artifacts)) errors.push('Manifest artifacts must be an array.');

  const observed = [];
  const seen = new Set();
  for (const entry of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
    try {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Artifact record must be an object.');
      if (Object.keys(entry).some(field => !['path', 'sizeBytes', 'sha256'].includes(field))) {
        throw new Error('Artifact record contains an unknown field.');
      }
      const parts = validateRelativePath(entry.path);
      if (parts[0] !== 'files' || parts.length < 2) throw new Error('Artifact path must be rooted under files/.');
      if (seen.has(entry.path)) throw new Error('Duplicate artifact path.');
      seen.add(entry.path);
      const absolute = resolveRegularPath(directory, entry.path);
      const stat = fs.statSync(absolute);
      if (!Number.isSafeInteger(entry.sizeBytes) || stat.size !== entry.sizeBytes) throw new Error('Artifact size does not match manifest.');
      if (!/^[0-9a-f]{64}$/i.test(entry.sha256) || sha256File(absolute) !== entry.sha256.toLowerCase()) {
        throw new Error('Artifact SHA-256 does not match manifest.');
      }
      observed.push({ path: entry.path, sizeBytes: stat.size, sha256: entry.sha256.toLowerCase() });
    } catch (error) {
      errors.push(String(error.message || error));
    }
  }
  try {
    const topLevel = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of topLevel) {
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are not accepted in CI evidence.');
      if (!['manifest.json', 'files'].includes(entry.name)) throw new Error('Unexpected top-level content in CI evidence artifact.');
    }
    const filesEntry = topLevel.find(entry => entry.name === 'files');
    if (filesEntry && (!filesEntry.isDirectory() || filesEntry.isSymbolicLink())) {
      throw new Error('CI evidence files directory is invalid.');
    }
    if (!filesEntry && seen.size > 0) {
      throw new Error('CI evidence files directory is missing for a non-empty manifest.');
    }
    // Artifact uploaders omit empty directories. A zero-file manifest (such as
    // CodeQL, whose authoritative evidence is the GitHub job record) is valid
    // without a materialized files/ directory.
    const onDiskPaths = filesEntry ? walkRegularFiles(directory, 'files').sort() : [];
    const listedPaths = [...seen].sort();
    if (JSON.stringify(onDiskPaths) !== JSON.stringify(listedPaths)) {
      errors.push('Artifact directory contents do not exactly match the manifest file list.');
    }
  } catch (error) {
    errors.push('Artifact directory contains unsafe or unexpected content: ' + String(error.message || error));
  }
  return { valid: errors.length === 0, errors, manifest, artifacts: observed };
}

function readEvidenceFile(directory, relativePath) {
  const manifestPath = 'files/' + relativePath;
  const safe = validateRelativePath(manifestPath);
  if (safe[0] !== 'files') throw new Error('Invalid evidence path.');
  const filePath = resolveRegularPath(directory, manifestPath);
  return fs.readFileSync(filePath);
}

function validateJobEvidence(jobConfig, directory, expected, apiJob) {
  const expectedManifest = {
    ...expected,
    workflowFile: WORKFLOW_FILE,
    jobKey: jobConfig.key,
    jobName: jobConfig.jobName,
    runtime: jobConfig.runtime,
  };
  const validation = validateManifestDirectory(directory, expectedManifest);
  const errors = [...validation.errors];
  const artifactSet = new Set(validation.artifacts.map(entry => entry.path.slice('files/'.length)));
  for (const relativePath of jobConfig.requiredFiles) {
    if (!artifactSet.has(relativePath)) errors.push('Required artifact is missing: ' + relativePath + '.');
  }
  if (!apiJob) errors.push('The corresponding GitHub Actions job is missing.');
  else {
    const expectedApiHead = expected.eventName === 'pull_request' ? expected.headSha : expected.mergeSha;
    if (!Number.isSafeInteger(apiJob.id) || apiJob.id < 1) errors.push('GitHub Actions job ID is missing or invalid.');
    if (apiJob.name !== jobConfig.jobName) errors.push('GitHub Actions job name does not match the expected job.');
    if (apiJob.workflow_name !== expected.workflow) errors.push('GitHub Actions job workflow name mismatch.');
    if (String(apiJob.run_id ?? '') !== String(expected.runId)) errors.push('GitHub Actions job run ID mismatch.');
    if (apiJob.run_attempt !== expected.runAttempt) errors.push('GitHub Actions job run attempt mismatch.');
    if (String(apiJob.head_sha || '').toLowerCase() !== expectedApiHead.toLowerCase()) {
      errors.push('GitHub Actions job source revision mismatch.');
    }
    if (apiJob.status !== 'completed' || apiJob.conclusion !== 'success') {
      errors.push('GitHub Actions job did not complete successfully.');
    }
  }

  let serviceLessIntegration = null;
  if (errors.length === 0) {
    try {
      if (jobConfig.key.startsWith('node-')) {
        const readiness = JSON.parse(readEvidenceFile(directory, 'artifacts/release-readiness.json').toString('utf8'));
        const sbom = JSON.parse(readEvidenceFile(directory, 'artifacts/virgoscorpio-hub.sbom.cdx.json').toString('utf8'));
        const packageLock = JSON.parse(readEvidenceFile(directory, 'package-lock.json').toString('utf8'));
        const check = id => readiness.checks?.find(item => item.id === id);
        if (readiness.product !== 'VirgoScorpio Hub' || readiness.version !== PRODUCT_VERSION) errors.push('Release-readiness report product/version mismatch.');
        if (readiness.sourceRevision !== expected.mergeSha) errors.push('Release-readiness report is not bound to the exact merge/source revision.');
        if (readiness.host?.node !== jobConfig.runtime) errors.push('Release-readiness report runtime does not match this matrix job.');
        for (const id of ['clean-source-tree', 'syntax-artifact-check', 'unit-tests', 'enginex-tests']) {
          if (check(id)?.status !== 'PASS') errors.push('Release-readiness source check is not PASS: ' + id + '.');
        }
        if (readiness.sourceTree?.clean !== true ||
            !Array.isArray(readiness.sourceTree.blockingPaths) ||
            readiness.sourceTree.blockingPaths.length !== 0) {
          errors.push('Release-readiness report does not prove a clean source tree with no blocking paths.');
        }
        if (!/^[0-9a-f]{40}$/i.test(String(readiness.sourceRevision || ''))) {
          errors.push('Release-readiness report source revision is missing or invalid.');
        }
        const artifactCheckLog = readEvidenceFile(directory, 'artifacts/evidence/artifact-check.log').toString('utf8');
        if (!artifactCheckLog.includes('VirgoScorpio Hub artifact check passed')) errors.push('Artifact/syntax log does not contain the verification success marker.');
        for (const file of ['unit-tests.tap.log', 'enginex-tests.tap.log']) {
          const summary = parseTapSummary(readEvidenceFile(directory, 'artifacts/evidence/' + file).toString('utf8'));
          if (!Number.isInteger(summary.tests) || summary.tests < 1 || summary.pass !== summary.tests ||
              summary.fail !== 0 || summary.cancelled !== 0 || summary.skipped !== 0 || summary.todo !== 0) {
            errors.push('Required source test log is not a positive zero-failure, zero-skip TAP run: ' + file + '.');
          }
        }
        const serviceSummary = parseTapSummary(readEvidenceFile(directory, 'artifacts/evidence/integration-tests.tap.log').toString('utf8'));
        if (!Number.isInteger(serviceSummary.tests) || serviceSummary.tests < 1 ||
            serviceSummary.pass + serviceSummary.skipped !== serviceSummary.tests ||
            serviceSummary.fail !== 0 || serviceSummary.cancelled !== 0 || serviceSummary.todo !== 0) {
          errors.push('Service-less integration TAP summary is malformed or contains a failed/cancelled/TODO test.');
        }
        const expectedServiceStatus = serviceSummary.skipped > 0 ? 'PARTIAL' : 'PASS';
        if (check('integration-tests')?.status !== expectedServiceStatus) {
          errors.push('Service-less integration report status does not match its TAP counters.');
        }
        serviceLessIntegration = {
          status: expectedServiceStatus,
          tests: serviceSummary.tests,
          passed: serviceSummary.pass,
          skipped: serviceSummary.skipped,
          details: serviceSummary.skipped > 0
            ? 'Service-less integration tests contain skips and are retained as PARTIAL, never counted as live integration PASS.'
            : 'Service-less integration run completed without skips; dedicated live integration evidence remains a separate gate.',
        };
        if (readiness.readyForProduction !== false || readiness.releaseClassification !== 'NOT_PRODUCTION_CERTIFIED') {
          errors.push('CI evidence must not represent this run as production certification.');
        }
        if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
          errors.push('CycloneDX SBOM structure is invalid.');
        }
        if (packageLock.name !== 'virgoscorpio-hub' || packageLock.version !== PRODUCT_VERSION || packageLock.lockfileVersion !== 3) {
          errors.push('Dependency lockfile identity/version/format does not match this release.');
        }
        for (const file of ['npm-audit-all.log', 'npm-audit.log']) {
          const auditOutput = readEvidenceFile(directory, 'artifacts/evidence/' + file).toString('utf8');
          if (!hasNoHighAuditFindings(auditOutput)) errors.push('Dependency audit output is missing a valid summary or contains high/critical findings: ' + file + '.');
        }
        const purl = sbom.metadata?.component?.purl;
        if (purl !== `pkg:npm/virgoscorpio-hub@${PRODUCT_VERSION}`) errors.push('SBOM package identity is missing or does not match VirgoScorpio Hub.');
        const npmTool = sbom.metadata?.tools?.find(tool => tool.vendor === 'npm' && tool.name === 'cli');
        if (npmTool?.version !== EXPECTED_NPM_VERSION) {
          errors.push('SBOM must be generated by the pinned npm CLI ' + EXPECTED_NPM_VERSION + '.');
        }
      } else if (jobConfig.key === 'postgres-memgraph-integration') {
        const live = JSON.parse(readEvidenceFile(directory, 'artifacts/evidence/integration-live.json').toString('utf8'));
        const migrations = JSON.parse(readEvidenceFile(directory, 'artifacts/evidence/fresh-migrations.json').toString('utf8'));
        if (live.node !== jobConfig.runtime || migrations.environment?.node !== jobConfig.runtime) {
          errors.push('Dedicated live integration and migration evidence runtime mismatch.');
        }
        if (live.status !== 'PASS' || !Number.isInteger(live.tests) || live.tests < 1 ||
            live.passed !== live.tests || live.failed !== 0 || live.cancelled !== 0 || live.skipped !== 0 || live.todo !== 0) {
          errors.push('Dedicated live integration JSON does not prove a positive, zero-skip successful test run.');
        }
        const tap = parseTapSummary(readEvidenceFile(directory, 'artifacts/evidence/integration-tests.tap.log').toString('utf8'));
        if (tap.tests !== live.tests || tap.pass !== live.passed || tap.fail !== 0 ||
            tap.cancelled !== 0 || tap.skipped !== 0 || tap.todo !== 0) {
          errors.push('Dedicated live integration TAP summary is missing, inconsistent, or contains skips/failures.');
        }
        if (!isFreshMigrationEvidence(migrations, 18, PRODUCT_VERSION, expected.mergeSha)) errors.push('Fresh migration evidence does not match this product version/source revision or prove all 18 migrations and the idempotent rerun.');
        const outage = readEvidenceFile(directory, 'artifacts/evidence/memgraph-outage-live.log').toString('utf8');
        const rebuild = readEvidenceFile(directory, 'artifacts/evidence/graph-rebuild-live.log').toString('utf8');
        if (!outage.includes('REAL MEMGRAPH OUTAGE RESULT: PASS')) errors.push('Memgraph outage/recovery evidence lacks its success marker.');
        if (!rebuild.includes('GRAPH REBUILD LIVE RESULT: PASS')) errors.push('Canonical graph rebuild evidence lacks its success marker.');
      } else if (jobConfig.key === 'browser-and-accessibility') {
        const browserLog = readEvidenceFile(directory, 'artifacts/evidence/browser-smoke.log').toString('utf8');
        if (!hasSuccessfulPlaywrightSummary(browserLog)) errors.push('Browser smoke log is missing a successful zero-failure, zero-skip Playwright summary.');
      }
    } catch (error) {
      errors.push('Evidence content validation failed: ' + String(error.message || error));
    }
  }
  return {
    key: jobConfig.key,
    artifactName: jobConfig.artifactName,
    jobName: jobConfig.jobName,
    runtime: jobConfig.runtime,
    status: errors.length === 0 ? 'PASS' : 'BLOCKED',
    // The exact API job ID is verified above; reports retain only the local job key/name.
    artifactCount: validation.artifacts.length,
    artifacts: validation.artifacts,
    serviceLessIntegration,
    errors,
  };
}

function evaluateCiEvidence({ artifactRoot, expected, run, jobs }) {
  const checks = [];
  const add = (id, passed, details) => checks.push({ id, status: passed ? 'PASS' : 'BLOCKED', details });
  const expectedApiHead = expected.eventName === 'pull_request' ? expected.headSha : expected.mergeSha;
  const runInProgress = run?.status === 'in_progress' && run.conclusion == null;
  const runCompletedSuccessfully = run?.status === 'completed' && run.conclusion === 'success';
  const runCompletionValid = runInProgress || runCompletedSuccessfully;
  const runValid = Boolean(run)
    && String(run.id ?? '') === String(expected.runId)
    && run.name === expected.workflow
    && run.run_attempt === expected.runAttempt
    && run.repository?.full_name === expected.repository
    && String(run.head_sha || '').toLowerCase() === expectedApiHead.toLowerCase()
    && run.event === expected.eventName
    && run.path === WORKFLOW_FILE
    && runCompletionValid;
  add('workflow-run', runValid,
    runValid
      ? runInProgress
        ? 'Workflow identity, event, attempt, repository, and source revisions verified; the workflow remains in progress while its aggregate job executes.'
        : 'Completed workflow identity, event, attempt, repository, source revisions, and successful conclusion verified.'
      : 'Workflow run metadata is missing, mismatched, incomplete or unsuccessful.');

  const byName = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job.name !== 'string') continue;
    const matches = byName.get(job.name) || [];
    matches.push(job);
    byName.set(job.name, matches);
  }
  const validatedJobs = [];
  for (const config of JOBS) {
    const directory = path.join(artifactRoot, config.artifactName);
    const matches = byName.get(config.jobName) || [];
    let validation;
    if (!fs.existsSync(directory)) {
      validation = {
        key: config.key, artifactName: config.artifactName, jobName: config.jobName,
        runtime: config.runtime, status: 'BLOCKED', jobId: null, artifactCount: 0, artifacts: [],
        errors: ['The expected uploaded artifact directory is missing.'],
      };
    } else {
      validation = validateJobEvidence(config, directory, expected, matches.length === 1 ? matches[0] : null);
    }
    if (matches.length > 1) {
      validation.status = 'BLOCKED';
      validation.errors.push('Multiple GitHub Actions jobs matched the expected job name.');
    }
    validatedJobs.push(validation);
    add('job-' + config.key, validation.status === 'PASS',
      validation.status === 'PASS' ? 'Job succeeded and its run-bound evidence manifest/checksums were verified.'
        : validation.errors.join(' '));
    if (validation.serviceLessIntegration) {
      checks.push({
        id: 'service-less-integration-' + config.key,
        status: validation.serviceLessIntegration.status,
        details: validation.serviceLessIntegration.details,
      });
    }
  }

  const node22Job = validatedJobs.find(job => job.key === 'node-22.23.4');
  const node24Job = validatedJobs.find(job => job.key === 'node-24.22.1');
  if (node22Job?.status === 'PASS' && node24Job?.status === 'PASS') {
    try {
      const node22Directory = path.join(artifactRoot, node22Job.artifactName);
      const node24Directory = path.join(artifactRoot, node24Job.artifactName);
      const node22Sbom = JSON.parse(readEvidenceFile(node22Directory, 'artifacts/virgoscorpio-hub.sbom.cdx.json').toString('utf8'));
      const node24Sbom = JSON.parse(readEvidenceFile(node24Directory, 'artifacts/virgoscorpio-hub.sbom.cdx.json').toString('utf8'));
      const comparison = compareSbomInventories(node22Sbom, node24Sbom);
      const delta = [
        ...comparison.leftOnlyComponents.map(value => 'Node 22 only: ' + value),
        ...comparison.rightOnlyComponents.map(value => 'Node 24 only: ' + value),
        ...comparison.leftOnlyEdges.map(value => 'Node 22 only dependency: ' + value),
        ...comparison.rightOnlyEdges.map(value => 'Node 24 only dependency: ' + value),
      ];
      add('sbom-runtime-parity', comparison.same,
        comparison.same
          ? 'Node.js 22.23.4 and 24.22.1 produced identical CycloneDX component inventories and dependency graphs with npm ' + EXPECTED_NPM_VERSION + '.'
          : 'CycloneDX component/dependency inventory differs across supported runtimes: ' + delta.slice(0, 12).join('; ') + (delta.length > 12 ? '; additional differences omitted.' : ''));
    } catch (error) {
      add('sbom-runtime-parity', false, 'Could not compare supported-runtime SBOM inventories: ' + String(error.message || error));
    }
  } else {
    add('sbom-runtime-parity', false, 'Both Node.js matrix jobs must pass and publish validated CycloneDX inventories before parity can pass.');
  }

  const releaseReady = false;
  add('production-certification', false,
    'A successful CI workflow is not production certification; independent security, tenant, provider, operational and release-owner evidence remains separate.');
  const requiredCiChecks = checks.filter(check => check.id !== 'production-certification' && !check.id.startsWith('service-less-integration-'));
  const ciStatus = requiredCiChecks.every(check => check.status === 'PASS') &&
    validatedJobs.every(job => job.status === 'PASS') ? 'PASS' : 'BLOCKED';
  const artifacts = validatedJobs.flatMap(job => job.artifacts.map(item => ({
    jobKey: job.key, jobId: job.jobId, path: item.path, sizeBytes: item.sizeBytes, sha256: item.sha256,
  })));
  return {
    schemaVersion: 1,
    product: 'VirgoScorpio Hub',
    version: PRODUCT_VERSION,
    generatedAt: new Date().toISOString(),
    workflowRun: {
      repository: expected.repository,
      workflow: expected.workflow,
      workflowFile: WORKFLOW_FILE,
      eventName: expected.eventName,
      runId: String(expected.runId),
      runAttempt: expected.runAttempt,
      headSha: expected.headSha,
      mergeSha: expected.mergeSha,
      // Persist only the allow-listed state, never raw strings from the Actions API.
      status: runInProgress ? 'in_progress' : runCompletedSuccessfully ? 'completed' : 'unknown',
      conclusion: runCompletedSuccessfully ? 'success' : null,
    },
    ciStatus,
    checks,
    jobs: validatedJobs,
    artifacts,
    readyForProduction: releaseReady,
    releaseClassification: 'NOT_PRODUCTION_CERTIFIED',
    productionBoundary: 'CI evidence is limited to source, dependency, database, browser smoke and CodeQL jobs. It does not close independent review, provider acceptance, deployment, legal/licensing or release-owner gates.',
  };
}

function renderMarkdown(report) {
  const cell = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/\|/g, '&#124;')
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\`/g, '&#96;');
  const rows = report.checks.map(check =>
    '| ' + cell(check.id) + ' | **' + cell(check.status) + '** | ' + cell(check.details) + ' |'
  ).join('\n');
  const jobRows = report.jobs.map(job =>
    '| ' + cell(job.jobName) + ' | **' + cell(job.status) + '** | ' + cell(job.artifactCount) + ' | ' +
    cell([job.serviceLessIntegration?.details, job.errors.join(' '), job.errors.length ? '' : 'Evidence verified.'].filter(Boolean).join(' ')) + ' |'
  ).join('\n');
  return [
    '# VirgoScorpio Hub CI Evidence Summary',
    '',
    '- Generated: ' + cell(report.generatedAt),
    '- Workflow: ' + cell(report.workflowRun.workflow),
    '- Run: ' + cell(report.workflowRun.runId) + ' (attempt ' + cell(report.workflowRun.runAttempt) + ')',
    '- Event: ' + cell(report.workflowRun.eventName),
    '- ' + (report.workflowRun.eventName === 'pull_request' ? 'PR head SHA: ' : 'Triggered commit SHA: ') + cell(report.workflowRun.headSha),
    '- ' + (report.workflowRun.eventName === 'pull_request' ? 'PR merge-ref SHA: ' : 'Checked-out source SHA: ') + cell(report.workflowRun.mergeSha),
    '- Actions run status at aggregation: ' + cell(report.workflowRun.status),
    '- Producer CI status: **' + cell(report.ciStatus) + '**',
    '- Production-ready: **NO**',
    '',
    '> This report consolidates producer-job evidence while the aggregate job is running. It is not production certification or the final workflow conclusion.',
    '',
    '## Workflow checks',
    '',
    '| Check | Status | Details |',
    '|---|---|---|',
    rows,
    '',
    '## Producer jobs',
    '',
    '| Job | Status | Verified files | Details |',
    '|---|---|---:|---|',
    jobRows,
    '',
    '## Checksum-verified artifacts',
    '',
    '| Producer | Path | Bytes | SHA-256 |',
    '|---|---|---:|---|',
    ...report.artifacts.map(item => '| ' + cell(item.jobKey) + ' | ' + cell(item.path) + ' | ' + cell(item.sizeBytes) + ' | ' + cell(item.sha256) + ' |'),
    '',
    '## Production boundary',
    '',
    cell(report.productionBoundary),
    '',
  ].join('\n');
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('GitHub API request failed with HTTP ' + response.status + '.');
  return response.json();
}

async function loadGithubRun({ repository, runId, runAttempt, token, apiUrl }) {
  const base = apiUrl.replace(/\/$/, '');
  const run = await githubJson(base + '/repos/' + repository + '/actions/runs/' + runId, token);
  const jobPage = await githubJson(base + '/repos/' + repository + '/actions/runs/' + runId +
    '/attempts/' + runAttempt + '/jobs?per_page=100', token);
  if (!Array.isArray(jobPage.jobs)) throw new Error('GitHub Actions jobs response is malformed.');
  return { run, jobs: jobPage.jobs };
}

function expectedMetadataFromEnvironment(env, root) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const checkoutSha = head.status === 0 ? head.stdout.trim().toLowerCase() : '';
  const eventSha = String(env.GITHUB_SHA || '').toLowerCase();
  return {
    repository: env.GITHUB_REPOSITORY,
    workflow: env.GITHUB_WORKFLOW,
    eventName: env.GITHUB_EVENT_NAME,
    runId: String(env.GITHUB_RUN_ID || ''),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    headSha: String(env.VIRGOSCORPIO_HUB_CI_HEAD_SHA || env.GITHUB_SHA || '').toLowerCase(),
    // Fail closed unless the checkout is exactly the commit GitHub selected for
    // this event (the synthetic merge ref for pull_request events).
    mergeSha: checkoutSha && eventSha && checkoutSha === eventSha ? checkoutSha : '',
  };
}

async function main() {
  const command = process.argv[2];
  const root = path.resolve(__dirname, '..');
  if (command === 'stage') {
    const key = process.env.VIRGOSCORPIO_HUB_CI_JOB_KEY;
    const config = JOBS.find(job => job.key === key);
    if (!config) throw new Error('Unknown or missing VIRGOSCORPIO_HUB_CI_JOB_KEY.');
    if (process.env.VIRGOSCORPIO_HUB_CI_JOB_NAME !== config.jobName) throw new Error('VIRGOSCORPIO_HUB_CI_JOB_NAME does not match the job key.');
    const runtime = process.env.VIRGOSCORPIO_HUB_CI_RUNTIME || 'not-applicable';
    if (runtime !== config.runtime) throw new Error('VIRGOSCORPIO_HUB_CI_RUNTIME does not match the job key.');
    const metadata = {
      ...expectedMetadataFromEnvironment(process.env, root),
      jobKey: config.key,
      jobName: config.jobName,
      runtime,
    };
    const manifest = stageEvidence({
      root,
      stageDirectory: 'artifacts/ci-evidence-stage',
      files: config.key.startsWith('node-') ? config.requiredFiles
        : config.key === 'postgres-memgraph-integration' ? config.requiredFiles
          : config.key === 'browser-and-accessibility'
            ? ['artifacts/evidence/browser-smoke.log'] : [],
      metadata,
    });
    console.log('Staged ' + manifest.artifacts.length + ' checksum-bound CI evidence file(s) for ' + config.key + '.');
    return;
  }
  if (command !== 'aggregate') throw new Error('Expected command: stage or aggregate.');

  const expected = expectedMetadataFromEnvironment(process.env, root);
  const token = process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  const artifactRoot = path.join(root, 'artifacts', 'ci-evidence');
  let run = null;
  let jobs = [];
  let apiError = null;
  try {
    if (!token) throw new Error('GITHUB_TOKEN is required for read-only Actions run/job verification.');
    ({ run, jobs } = await loadGithubRun({
      repository: expected.repository,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
      token,
      apiUrl,
    }));
  } catch (error) {
    // Do not write arbitrary network/API error text into the local evidence artifact.
    apiError = 'GitHub Actions run/job verification was unavailable.';
  }

  let report = evaluateCiEvidence({ artifactRoot, expected, run, jobs });
  if (apiError) {
    report.ciStatus = 'BLOCKED';
    report.checks.unshift({ id: 'github-actions-api', status: 'BLOCKED', details: apiError });
  }
  const outputDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'release-readiness-ci.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outputDirectory, 'release-readiness-ci.md'), renderMarkdown(report));
  console.log('CI EVIDENCE: ' + report.ciStatus);
  console.log('PRODUCTION CERTIFICATION: NO');
  if (report.ciStatus !== 'PASS') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error('CI evidence operation failed: ' + String(error.message || error));
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_NPM_VERSION,
  JOBS,
  WORKFLOW_FILE,
  buildManifest,
  compareSbomInventories,
  copyEvidenceFiles,
  evaluateCiEvidence,
  renderMarkdown,
  sha256File,
  stageEvidence,
  validateJobEvidence,
  validateManifestDirectory,
};
