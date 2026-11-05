'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PRODUCT_VERSION } = require('../packages/domain/src/version');
const {
  EXPECTED_NPM_VERSION,
  JOBS,
  WORKFLOW_FILE,
  compareSbomInventories,
  evaluateCiEvidence,
  renderMarkdown,
  stageEvidence,
  validateManifestDirectory,
} = require('../scripts/ci-evidence');

const expected = {
  repository: 'GoldenObsidianLLC/VirgoScorpio-Hub',
  workflow: 'VirgoScorpio Hub CI',
  eventName: 'pull_request',
  runId: '123456789',
  runAttempt: 2,
  headSha: '1'.repeat(40),
  mergeSha: '2'.repeat(40),
};

function write(root, relativePath, value) {
  const absolute = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}

function createFixtures(t, { npmVersion = EXPECTED_NPM_VERSION } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'virgoscorpio_hub-ci-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts', 'ci-evidence');
  fs.mkdirSync(artifactRoot, { recursive: true });

  const readinessChecks = [
    'clean-source-tree',
    'syntax-artifact-check',
    'unit-tests',
    'enginex-tests',
  ].map(id => ({ id, status: 'PASS' }));
  readinessChecks.push({ id: 'integration-tests', status: 'PARTIAL' });
  const readiness = {
    schemaVersion: 1,
    product: 'VirgoScorpio Hub',
    version: PRODUCT_VERSION,
    sourceRevision: expected.mergeSha,
    sourceTree: { clean: true, changedPaths: [], approvedGeneratedPaths: [], blockingPaths: [] },
    host: { node: 'v22.23.4' },
    readyForProduction: false,
    releaseClassification: 'NOT_PRODUCTION_CERTIFIED',
    checks: readinessChecks,
  };
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: {
      component: {
        'bom-ref': `virgoscorpio-hub@${PRODUCT_VERSION}`,
        purl: `pkg:npm/virgoscorpio-hub@${PRODUCT_VERSION}`,
      },
      tools: [{ vendor: 'npm', name: 'cli', version: npmVersion }],
    },
    components: [{ name: 'fixture', version: '1.0.0' }],
    dependencies: [],
  };
  for (const file of JOBS[0].requiredFiles) {
    if (file.endsWith('release-readiness.json')) write(root, file, readiness);
    else if (file.endsWith('.cdx.json')) write(root, file, sbom);
    else if (file.endsWith('.md')) write(root, file, '# Candidate readiness\n');
    else if (file.endsWith('package-lock.json')) write(root, file, { name: 'virgoscorpio-hub', version: PRODUCT_VERSION, lockfileVersion: 3 });
    else if (file.endsWith('artifact-check.log')) write(root, file, 'VirgoScorpio Hub artifact check passed (157 required paths).\n');
    else if (file.endsWith('unit-tests.tap.log') || file.endsWith('enginex-tests.tap.log')) {
      write(root, file, ['TAP version 13', '# tests 8', '# pass 8', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n'));
    } else if (file.endsWith('integration-tests.tap.log')) {
      write(root, file, ['TAP version 13', '# tests 5', '# pass 3', '# fail 0', '# cancelled 0', '# skipped 2', '# todo 0'].join('\n'));
    } else write(root, file, 'found 0 vulnerabilities\n');
  }

  const live = {
    status: 'PASS',
    node: 'v22.23.4',
    tests: 22,
    passed: 22,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  const migrations = {
    schemaVersion: 1,
    product: 'VirgoScorpio Hub',
    version: PRODUCT_VERSION,
    sourceRevision: expected.mergeSha,
    gate: 'fresh-migrations',
    status: 'PASS',
    environment: { node: 'v22.23.4' },
    migrationCount: 18,
    firstPass: '18/18 migrations applied',
    secondPass: '18/18 migrations skipped as already applied',
    cleanup: 'disposable database dropped',
  };
  for (const file of JOBS[2].requiredFiles) {
    if (file.endsWith('integration-live.json')) write(root, file, live);
    else if (file.endsWith('fresh-migrations.json')) write(root, file, migrations);
    else if (file.endsWith('integration-tests.tap.log')) {
      write(root, file, ['TAP version 13', '# tests 22', '# pass 22', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n'));
    } else if (file.endsWith('memgraph-outage-live.log')) write(root, file, 'REAL MEMGRAPH OUTAGE RESULT: PASS\n');
    else if (file.endsWith('graph-rebuild-live.log')) write(root, file, 'GRAPH REBUILD LIVE RESULT: PASS\n');
    else write(root, file, 'PASS\n');
  }
  write(root, JOBS[3].requiredFiles[0], 'Running 5 tests\n5 passed (2.1s)\n');

  const jobApi = [];
  const producerOrder = [JOBS[2], JOBS[0], JOBS[1], JOBS[3], JOBS[4]];
  for (const config of producerOrder) {
    const stageDirectory = 'artifacts/ci-stage';
    if (config.key.startsWith('node-')) {
      readiness.host.node = config.runtime;
      write(root, 'artifacts/release-readiness.json', readiness);
      write(root, 'artifacts/evidence/integration-tests.tap.log', [
        'TAP version 13', '# tests 5', '# pass 3', '# fail 0',
        '# cancelled 0', '# skipped 2', '# todo 0',
      ].join(String.fromCharCode(10)));
    }
    const manifest = stageEvidence({
      root,
      stageDirectory,
      files: config.key === 'browser-and-accessibility'
        ? [...config.requiredFiles] : config.requiredFiles,
      metadata: {
        ...expected,
        jobKey: config.key,
        jobName: config.jobName,
        runtime: config.runtime,
      },
    });
    assert.equal(manifest.workflowFile, WORKFLOW_FILE);
    fs.renameSync(path.join(root, stageDirectory), path.join(artifactRoot, config.artifactName));
    jobApi.push({
      id: 1000 + jobApi.length,
      run_id: Number(expected.runId),
      run_attempt: expected.runAttempt,
      head_sha: expected.headSha,
      workflow_name: expected.workflow,
      name: config.jobName,
      status: 'completed',
      conclusion: 'success',
    });
  }

  const runApi = {
    id: Number(expected.runId),
    name: expected.workflow,
    run_attempt: expected.runAttempt,
    head_sha: expected.headSha,
    event: expected.eventName,
    status: 'in_progress',
    conclusion: null,
    path: WORKFLOW_FILE,
    repository: { full_name: expected.repository },
    pull_requests: [],
    html_url: 'https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/123456789',
  };
  return { root, artifactRoot, jobApi, runApi };
}

test('CI SBOM generation uses the exact npm CLI version declared in package.json', () => {
  assert.equal(require('../package.json').packageManager, 'npm@11.19.1');
  assert.equal(EXPECTED_NPM_VERSION, '11.19.1');
});

test('SBOM inventory comparison ignores generation metadata but detects component and dependency drift', () => {
  const left = {
    bomFormat: 'CycloneDX',
    metadata: { component: { 'bom-ref': 'root@1.0.0', purl: 'pkg:npm/root@1.0.0' }, timestamp: '2026-01-01T00:00:00.000Z' },
    components: [{ 'bom-ref': 'alpha@1.0.0', name: 'alpha', version: '1.0.0', purl: 'pkg:npm/alpha@1.0.0' }],
    dependencies: [
      { ref: 'root@1.0.0', dependsOn: ['alpha@1.0.0'] },
      { ref: 'alpha@1.0.0', dependsOn: [] },
    ],
  };
  const identicalInventory = {
    ...left,
    metadata: { ...left.metadata, timestamp: '2026-02-01T00:00:00.000Z' },
  };
  assert.deepEqual(compareSbomInventories(left, identicalInventory), {
    same: true,
    leftOnlyComponents: [],
    rightOnlyComponents: [],
    leftOnlyEdges: [],
    rightOnlyEdges: [],
  });

  const changed = {
    ...identicalInventory,
    components: [...identicalInventory.components, {
      'bom-ref': 'tslib@2.8.1', name: 'tslib', version: '2.8.1', purl: 'pkg:npm/tslib@2.8.1',
    }],
    dependencies: [
      { ref: 'root@1.0.0', dependsOn: ['alpha@1.0.0'] },
      { ref: 'alpha@1.0.0', dependsOn: ['tslib@2.8.1'] },
      { ref: 'tslib@2.8.1', dependsOn: [] },
    ],
  };
  const delta = compareSbomInventories(left, changed);
  assert.equal(delta.same, false);
  assert.deepEqual(delta.rightOnlyComponents, ['pkg:npm/tslib@2.8.1']);
  assert.deepEqual(delta.rightOnlyEdges, ['pkg:npm/alpha@1.0.0 -> pkg:npm/tslib@2.8.1']);
});

test('stages files with SHA-256 and exact run, attempt, source and job identity', t => {
  const { root, artifactRoot } = createFixtures(t);
  const directory = path.join(artifactRoot, JOBS[0].artifactName);
  const result = validateManifestDirectory(directory, {
    ...expected,
    workflowFile: WORKFLOW_FILE,
    jobKey: JOBS[0].key,
    jobName: JOBS[0].jobName,
    runtime: JOBS[0].runtime,
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.ok(result.artifacts.length >= JOBS[0].requiredFiles.length);
});

test('reads the manifest through its opened descriptor when the path is replaced', t => {
  if (process.platform === 'win32') return t.skip('Open-file rename semantics differ on Windows.');
  const { artifactRoot } = createFixtures(t);
  const config = JOBS[0];
  const directory = path.join(artifactRoot, config.artifactName);
  const manifestFile = path.join(directory, 'manifest.json');
  const backupFile = manifestFile + '.original';
  const originalOpenSync = fs.openSync;
  const originalReaddirSync = fs.readdirSync;
  let replaced = false;

  fs.openSync = function patchedOpenSync(filePath, ...args) {
    const descriptor = originalOpenSync.call(fs, filePath, ...args);
    if (!replaced && typeof filePath === 'string' && path.resolve(filePath) === path.resolve(manifestFile)) {
      fs.renameSync(manifestFile, backupFile);
      fs.writeFileSync(manifestFile, 'not valid JSON');
      replaced = true;
    }
    return descriptor;
  };
  fs.readdirSync = function patchedReaddirSync(directoryPath, ...args) {
    if (replaced && path.resolve(directoryPath) === path.resolve(directory)) {
      fs.rmSync(manifestFile, { force: true });
      fs.renameSync(backupFile, manifestFile);
      replaced = false;
    }
    return originalReaddirSync.call(fs, directoryPath, ...args);
  };

  try {
    const result = validateManifestDirectory(directory, {
      ...expected,
      workflowFile: WORKFLOW_FILE,
      jobKey: config.key,
      jobName: config.jobName,
      runtime: config.runtime,
    });
    assert.equal(result.valid, true, result.errors.join('; '));
  } finally {
    fs.openSync = originalOpenSync;
    fs.readdirSync = originalReaddirSync;
    if (fs.existsSync(backupFile)) {
      fs.rmSync(manifestFile, { force: true });
      fs.renameSync(backupFile, manifestFile);
    }
  }
});

test('does not persist raw fields returned by the GitHub Actions API', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  runApi.html_url = 'https://attacker.invalid/untrusted-network-value';
  jobApi[0].id = 'untrusted-job-id';

  const report = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: jobApi });
  const serialized = JSON.stringify(report);
  assert.equal(report.workflowRun.status, 'in_progress');
  assert.equal(report.workflowRun.conclusion, null);
  assert.equal(Object.hasOwn(report.workflowRun, 'url'), false);
  assert.ok(report.jobs.every(job => !Object.hasOwn(job, 'jobId')));
  assert.ok(!serialized.includes('attacker.invalid'));
  assert.ok(!serialized.includes('untrusted-job-id'));
});

test('consolidates all successful producers but never marks production certified', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  const report = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: jobApi });
  assert.equal(report.ciStatus, 'PASS', JSON.stringify({ checks: report.checks, jobs: report.jobs }, null, 2));
  assert.equal(report.readyForProduction, false);
  assert.equal(report.releaseClassification, 'NOT_PRODUCTION_CERTIFIED');
  assert.equal(report.workflowRun.status, 'in_progress');
  assert.equal(report.workflowRun.conclusion, null);
  assert.equal(report.workflowRun.headSha, expected.headSha);
  assert.equal(report.workflowRun.mergeSha, expected.mergeSha);
  assert.equal(report.jobs.length, 5);
  assert.ok(report.artifacts.length >= 20);
  assert.equal(
    report.checks.find(check => check.id === 'service-less-integration-node-22.23.4')?.status,
    'PARTIAL',
  );
  assert.equal(
    report.checks.find(check => check.id === 'service-less-integration-node-24.22.1')?.status,
    'PARTIAL',
  );
});

test('rejects Node.js producer SBOMs generated with an unpinned npm CLI', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t, { npmVersion: '10.9.9' });
  const report = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: jobApi });
  assert.equal(report.ciStatus, 'BLOCKED');
  for (const key of ['node-22.23.4', 'node-24.22.1']) {
    const job = report.jobs.find(item => item.key === key);
    assert.equal(job.status, 'BLOCKED');
    assert.ok(job.errors.some(error => /pinned npm CLI 11\.19\.1/.test(error)));
  }
  assert.equal(report.checks.find(check => check.id === 'sbom-runtime-parity')?.status, 'BLOCKED');
});

test('accepts an empty CodeQL evidence inventory when artifact download omits empty directories', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  const codeql = JOBS.find(job => job.key === 'security-static-analysis');
  const directory = path.join(artifactRoot, codeql.artifactName);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.artifacts, []);
  fs.rmSync(path.join(directory, 'files'), { recursive: true, force: true });

  const report = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: jobApi });
  assert.equal(report.ciStatus, 'PASS', JSON.stringify(report.checks, null, 2));
  assert.equal(report.jobs.find(job => job.key === codeql.key).status, 'PASS');
  assert.equal(report.jobs.find(job => job.key === codeql.key).artifactCount, 0);
});

test('rejects unknown manifest fields and non-object manifest roots', t => {
  const { artifactRoot } = createFixtures(t);
  const directory = path.join(artifactRoot, JOBS[0].artifactName);
  const manifestFile = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.unreviewedField = 'not allowed';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + String.fromCharCode(10));
  const unknownField = validateManifestDirectory(directory, {
    ...expected,
    workflowFile: WORKFLOW_FILE,
    jobKey: JOBS[0].key,
    jobName: JOBS[0].jobName,
    runtime: JOBS[0].runtime,
  });
  assert.equal(unknownField.valid, false);
  assert.ok(unknownField.errors.some(error => /Unknown manifest field/.test(error)));

  fs.writeFileSync(manifestFile, 'null');
  const invalidRoot = validateManifestDirectory(directory, {
    ...expected,
    workflowFile: WORKFLOW_FILE,
    jobKey: JOBS[0].key,
    jobName: JOBS[0].jobName,
    runtime: JOBS[0].runtime,
  });
  assert.equal(invalidRoot.valid, false);
  assert.ok(invalidRoot.errors.some(error => /root must be a JSON object/.test(error)));
});

test('rejects stale attempt, wrong source revision and a mismatched job identity', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  const wrongAttempt = evaluateCiEvidence({
    artifactRoot,
    expected: { ...expected, runAttempt: 1 },
    run: runApi,
    jobs: jobApi,
  });
  assert.equal(wrongAttempt.ciStatus, 'BLOCKED');

  const wrongSha = evaluateCiEvidence({
    artifactRoot,
    expected: { ...expected, mergeSha: '3'.repeat(40) },
    run: runApi,
    jobs: jobApi,
  });
  assert.equal(wrongSha.ciStatus, 'BLOCKED');

  const failedJobs = jobApi.map(job => job.name === JOBS[4].jobName ? { ...job, conclusion: 'failure' } : job);
  const failed = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: failedJobs });
  assert.equal(failed.ciStatus, 'BLOCKED');
});

test('rejects modified evidence content after the manifest checksum was created', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  const directory = path.join(artifactRoot, JOBS[2].artifactName, 'files', 'artifacts', 'evidence');
  fs.appendFileSync(path.join(directory, 'memgraph-outage-live.log'), 'tampered\n');
  const report = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: jobApi });
  const integrationJob = report.jobs.find(job => job.key === 'postgres-memgraph-integration');
  assert.equal(integrationJob.status, 'BLOCKED');
  assert.ok(integrationJob.errors.some(error => /size does not match manifest|SHA-256/.test(error)), integrationJob.errors.join('; '));
  assert.equal(report.ciStatus, 'BLOCKED');
});

test('rejects missing job artifacts and incomplete live evidence', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  fs.rmSync(path.join(artifactRoot, JOBS[2].artifactName, 'files', 'artifacts', 'evidence', 'fresh-migrations.json'));
  const report = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: jobApi });
  const integrationJob = report.jobs.find(job => job.key === 'postgres-memgraph-integration');
  assert.equal(integrationJob.status, 'BLOCKED');
  assert.ok(integrationJob.errors.some(error => /Required artifact is missing/.test(error)));
});

test('requires zero skipped/failing live integration tests even when status claims PASS', t => {
  const { root, artifactRoot, jobApi, runApi } = createFixtures(t);
  const liveFile = path.join(artifactRoot, JOBS[2].artifactName, 'files', 'artifacts', 'evidence', 'integration-live.json');
  const live = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
  live.skipped = 1;
  fs.writeFileSync(liveFile, JSON.stringify(live, null, 2) + '\n');
  const manifestFile = path.join(artifactRoot, JOBS[2].artifactName, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const artifact = manifest.artifacts.find(item => item.path === 'files/artifacts/evidence/integration-live.json');
  const tamperedBytes = fs.readFileSync(liveFile);
  artifact.sizeBytes = tamperedBytes.length;
  artifact.sha256 = crypto.createHash('sha256').update(tamperedBytes).digest('hex');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  const report = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: jobApi });
  const integrationJob = report.jobs.find(job => job.key === 'postgres-memgraph-integration');
  assert.equal(integrationJob.status, 'BLOCKED');
  assert.ok(integrationJob.errors.some(error => /zero-skip/.test(error) || /SHA-256/.test(error)));
});

test('rejects missing workflow metadata and failed workflow-run conclusion', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  const missingRun = evaluateCiEvidence({ artifactRoot, expected, run: null, jobs: jobApi });
  assert.equal(missingRun.ciStatus, 'BLOCKED');

  const failedRun = evaluateCiEvidence({
    artifactRoot,
    expected,
    run: { ...runApi, status: 'completed', conclusion: 'failure' },
    jobs: jobApi,
  });
  assert.equal(failedRun.ciStatus, 'BLOCKED');
});

test('rejects workflow and producer-job identity drift or duplicate jobs', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  const wrongRepository = evaluateCiEvidence({
    artifactRoot, expected, run: { ...runApi, repository: { full_name: 'attacker/other-repo' } }, jobs: jobApi,
  });
  assert.equal(wrongRepository.ciStatus, 'BLOCKED');

  const wrongRunId = evaluateCiEvidence({
    artifactRoot, expected, run: { ...runApi, id: Number(expected.runId) + 1 }, jobs: jobApi,
  });
  assert.equal(wrongRunId.ciStatus, 'BLOCKED');

  const wrongRunHead = evaluateCiEvidence({
    artifactRoot, expected, run: { ...runApi, head_sha: '9'.repeat(40) }, jobs: jobApi,
  });
  assert.equal(wrongRunHead.ciStatus, 'BLOCKED');

  const wrongJobAttempt = jobApi.map(job => job.name === JOBS[0].jobName
    ? { ...job, run_attempt: expected.runAttempt - 1 } : job);
  const attemptReport = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: wrongJobAttempt });
  assert.equal(attemptReport.jobs.find(job => job.key === JOBS[0].key).status, 'BLOCKED');

  const wrongJobRevision = jobApi.map(job => job.name === JOBS[1].jobName
    ? { ...job, head_sha: '9'.repeat(40) } : job);
  const revisionReport = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: wrongJobRevision });
  assert.equal(revisionReport.jobs.find(job => job.key === JOBS[1].key).status, 'BLOCKED');

  const duplicateTarget = jobApi.find(job => job.name === JOBS[0].jobName);
  const duplicateJobs = [...jobApi, { ...duplicateTarget }];
  const duplicateReport = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: duplicateJobs });
  assert.equal(duplicateReport.jobs.find(job => job.key === JOBS[0].key).status, 'BLOCKED');

  const completed = evaluateCiEvidence({
    artifactRoot,
    expected,
    run: { ...runApi, status: 'completed', conclusion: 'success' },
    jobs: jobApi,
  });
  assert.equal(completed.ciStatus, 'PASS');
});

test('Markdown output escapes evidence text and labels revisions by event type', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  const report = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: jobApi });
  report.checks[0].details = ['unsafe', '| forged | <script>alert(1)</script> `'].join(String.fromCharCode(10));
  const markdown = renderMarkdown(report);
  assert.ok(markdown.includes('PR head SHA: ' + expected.headSha));
  assert.ok(markdown.includes('PR merge-ref SHA: ' + expected.mergeSha));
  assert.ok(markdown.includes('in_progress'));
  assert.ok(markdown.includes('&#124; forged &#124; &lt;script&gt;'));
  assert.ok(!markdown.includes(String.fromCharCode(10) + '| forged |'));
});

test('rejects symlink artifacts when the platform permits creating them', t => {
  const { artifactRoot, jobApi, runApi } = createFixtures(t);
  const directory = path.join(artifactRoot, JOBS[0].artifactName, 'files');
  const actual = path.join(directory, 'symlink-target.txt');
  const link = path.join(directory, 'symlink.txt');
  fs.writeFileSync(actual, 'not evidence\n');
  try {
    fs.symlinkSync(actual, link, 'file');
  } catch {
    t.skip('Symlink creation is not permitted by this operating system account.');
    return;
  }

  const report = evaluateCiEvidence({ artifactRoot, expected, run: runApi, jobs: jobApi });
  const nodeJob = report.jobs.find(job => job.key === JOBS[0].key);
  assert.equal(nodeJob.status, 'BLOCKED');
  assert.ok(nodeJob.errors.some(error => /symbolic link/i.test(error)));
});
