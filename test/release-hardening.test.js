'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLibraryStore } = require('../packages/library/src/file-store');
const { reconcileLocalLibraryObjects, keyPath } = require('../packages/library/src/reconcile-local-objects');
const { createS3CompatibleAdapter, createGoogleCloudStorageAdapter, createAzureBlobAdapter, probeCloudStorageAdapter, resolveCloudCredentialReference } = require('../packages/cloud/src/storage-adapters');
const { createClamDScanScanner } = require('../packages/security/src/malware-scanner');

const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]);
function poolForInsert(capture = {}) {
  return {
    async connect() {
      return {
        async query(sql, args) {
          capture.calls ||= []; capture.calls.push({ sql, args });
          if (/INSERT INTO library_assets/.test(sql)) return { rows: [{ id: args[0], site_id: args[1], storage_key: args[6], is_public: args[13], status: args[16], malware_scan_status: args[17], malware_scan_engine: args[18], metadata: JSON.parse(args[14]) }] };
          return { rows: [], rowCount: 1 };
        },
        release() {}
      };
    }
  };
}

function completedScannerProcess(exitCode, output = '') {
  return (_executable, args, options) => {
    assert.deepEqual(args.slice(0, 3), ['--no-summary', '--infected', '--stdout']);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.pid = 123;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => false;
    setImmediate(() => {
      if (output) child.stderr.write(output);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', exitCode, null);
    });
    return child;
  };
}

test('library uploads are quarantined when no scanner is configured and do not become public', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vsh-library-quarantine-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const store = createLibraryStore({ pool: poolForInsert(), root, requireMalwareScan: false });
  const asset = await store.upload({ siteId: 'site-one', category: 'image', dataBase64: png.toString('base64'), mimeType: 'image/png', fileName: 'sample.png', isPublic: true });
  assert.equal(asset.status, 'quarantined');
  assert.equal(asset.malware_scan_status, 'not_scanned');
  assert.equal(asset.is_public, false);
  assert.deepEqual(asset.metadata.securityScan, { status: 'not_scanned', engine: null, scannedAt: null });
  assert.equal(fs.existsSync(path.join(root, asset.storage_key)), true);
});

test('library uploads activate only after scanner confirms clean content', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vsh-library-clean-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  let scannerInput;
  const store = createLibraryStore({ pool: poolForInsert(), root, requireMalwareScan: true, malwareScanner: { engine: 'test-scanner', async scan(input) { scannerInput = input; return { clean: true, status: 'clean', engine: 'test-scanner' }; } } });
  const asset = await store.upload({ siteId: 'site-one', category: 'image', dataBase64: png.toString('base64'), mimeType: 'image/png', fileName: 'sample.png', isPublic: true });
  assert.equal(scannerInput.fileName, 'sample.png');
  assert.deepEqual(scannerInput.buffer, png);
  assert.equal(asset.status, 'active');
  assert.equal(asset.malware_scan_status, 'clean');
  assert.equal(asset.is_public, true);
});

test('library media variants validate file signatures and parent asset categories before storage', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vsh-library-variants-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const webp = Buffer.alloc(12);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  let variantRow = null;
  let insertCount = 0;
  const pool = {
    async query(sql, args) {
      if (/SELECT id,asset_kind,version FROM library_assets/.test(sql)) return { rows: [{ id: 'asset-one', asset_kind: 'image', version: 1 }] };
      if (/INSERT INTO media_variants/.test(sql)) {
        insertCount += 1;
        variantRow = { id: 'variant-one', asset_id: args[0], variant_key: args[1], storage_key: args[2], mime_type: args[3], byte_size: args[4], sha256: args[7], asset_kind: 'image' };
        return { rows: [{ ...variantRow }] };
      }
      if (/FROM media_variants v JOIN library_assets a/.test(sql)) return { rows: variantRow ? [{ ...variantRow }] : [] };
      throw new Error('Unexpected library variant query.');
    }
  };
  const store = createLibraryStore({ pool, root, requireMalwareScan: false });
  await assert.rejects(() => store.createVariant({ siteId: 'site-one', id: 'asset-one', variantKey: 'webp-optimized', data: Buffer.from('not a WebP image'), mimeType: 'image/webp' }), { code: 'ERR_VIRGOSCORPIO_HUB_LIBRARY_TYPE' });
  await assert.rejects(() => store.createVariant({ siteId: 'site-one', id: 'asset-one', variantKey: 'pdf-variant', data: Buffer.from('%PDF-1.7\\n'), mimeType: 'application/pdf' }), { code: 'ERR_VIRGOSCORPIO_HUB_LIBRARY_TYPE' });
  assert.equal(insertCount, 0);
  assert.deepEqual(await fs.promises.readdir(root), [], 'invalid variants must be rejected before writing object bytes');
  const created = await store.createVariant({ siteId: 'site-one', id: 'asset-one', variantKey: 'webp-optimized', data: webp, mimeType: 'image/webp' });
  assert.equal(created.mime_type, 'image/webp');
  assert.equal(insertCount, 1);
  const readable = await store.readPublicVariant({ assetId: 'asset-one', variantKey: 'webp-optimized' });
  assert.deepEqual(readable.data, webp);
  const corrupted = Buffer.from('not a WebP image');
  await fs.promises.writeFile(path.join(root, variantRow.storage_key), corrupted);
  variantRow.byte_size = corrupted.length;
  variantRow.sha256 = require('node:crypto').createHash('sha256').update(corrupted).digest('hex');
  assert.equal(await store.readPublicVariant({ assetId: 'asset-one', variantKey: 'webp-optimized' }), null, 'a matching stored hash must not override a MIME signature mismatch');
});

test('production library uploads fail closed when scanner is missing, detects malware, or times out', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vsh-library-failclosed-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const noScanner = createLibraryStore({ pool: poolForInsert(), root, requireMalwareScan: true });
  await assert.rejects(() => noScanner.upload({ siteId: 'site-one', category: 'image', dataBase64: png.toString('base64'), mimeType: 'image/png', fileName: 'bad.png' }), { code: 'ERR_VIRGOSCORPIO_HUB_MALWARE_SCANNER_REQUIRED' });
  const infected = createLibraryStore({ pool: poolForInsert(), root, requireMalwareScan: true, malwareScanner: { async scan() { return { clean: false, status: 'infected', signature: 'EICAR' }; } } });
  await assert.rejects(() => infected.upload({ siteId: 'site-one', category: 'image', dataBase64: png.toString('base64'), mimeType: 'image/png', fileName: 'bad.png' }), { code: 'ERR_VIRGOSCORPIO_HUB_MALWARE_DETECTED' });

  const timeoutCalls = {};
  const timedOut = createLibraryStore({
    pool: poolForInsert(timeoutCalls),
    root,
    requireMalwareScan: true,
    malwareScanner: { async scan() { const error = new Error('scanner timeout'); error.code = 'ERR_VIRGOSCORPIO_HUB_MALWARE_TIMEOUT'; throw error; } }
  });
  await assert.rejects(() => timedOut.upload({ siteId: 'site-one', category: 'image', dataBase64: png.toString('base64'), mimeType: 'image/png', fileName: 'timeout.png' }), { code: 'ERR_VIRGOSCORPIO_HUB_MALWARE_TIMEOUT' });
  assert.deepEqual(timeoutCalls.calls || [], [], 'a scanner failure must happen before storage metadata is written');
  assert.deepEqual(await fs.promises.readdir(root), []);
});

test('local object reconciler defaults to dry-run, respects references and minimum age, and prevents traversal', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vsh-library-reconcile-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(root, 'site-one'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'site-one', 'referenced.bin'), 'keep');
  await fs.promises.writeFile(path.join(root, 'site-one', 'orphan.bin'), 'orphan');
  await fs.promises.utimes(path.join(root, 'site-one', 'orphan.bin'), new Date(1), new Date(1));
  const pool = { async query(sql) { assert.match(sql, /library_asset_versions/); return { rows: [{ storage_key: 'site-one/referenced.bin' }, { storage_key: '../escape' }] }; } };
  assert.equal(keyPath(root, '../escape'), null);
  const report = await reconcileLocalLibraryObjects({ pool, root, minAgeMs: 1000, now: Date.now() });
  assert.equal(report.candidateCount, 1);
  assert.equal(report.removed.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'site-one', 'orphan.bin')), true);
  const applied = await reconcileLocalLibraryObjects({ pool, root, apply: true, minAgeMs: 1000, now: Date.now() });
  assert.deepEqual(applied.removed, ['site-one/orphan.bin']);
  assert.equal(fs.existsSync(path.join(root, 'site-one', 'referenced.bin')), true);
  assert.equal(fs.existsSync(path.join(root, 'site-one', 'orphan.bin')), false);
});

test('cloud storage adapters perform explicit read-only connectivity probes', async () => {
  const calls = [];
  class HeadBucketCommand { constructor(input) { this.input = input; } }
  const s3 = createS3CompatibleAdapter({ bucket: 'test-bucket', client: { async send(command) { calls.push(command); return {}; } }, commands: { HeadBucketCommand, PutObjectCommand: class {}, GetObjectCommand: class {}, DeleteObjectCommand: class {} } });
  assert.deepEqual(await probeCloudStorageAdapter(s3).then(x => ({ ok: x.ok, operation: x.operation })), { ok: true, operation: 'HeadBucket' });
  assert.equal(calls[0].input.Bucket, 'test-bucket');

  let gcsProbe = 0;
  const gcs = createGoogleCloudStorageAdapter({ bucket: { async getMetadata() { gcsProbe += 1; return [{}]; }, file() { return { save() {}, download() {} }; } } });
  assert.equal((await probeCloudStorageAdapter(gcs)).ok, true);
  assert.equal(gcsProbe, 1);

  let azureProbe = 0;
  const azure = createAzureBlobAdapter({ containerClient: { async getProperties() { azureProbe += 1; return {}; }, getBlockBlobClient() { return {}; } } });
  assert.equal((await probeCloudStorageAdapter(azure)).operation, 'GetContainerProperties');
  assert.equal(azureProbe, 1);
});

test('cloud probe hides upstream errors and requires a supported probe method', async () => {
  await assert.rejects(() => probeCloudStorageAdapter({ async probe() { throw new Error('secret account identifier'); } }), error => error.code === 'ERR_VIRGOSCORPIO_HUB_CLOUD_PROBE_FAILED' && !error.message.includes('secret account identifier'));
  await assert.rejects(() => probeCloudStorageAdapter({}), { code: 'ERR_VIRGOSCORPIO_HUB_CLOUD_PROBE_UNAVAILABLE' });
});


test('ClamAV scanner fails closed when the executable is unavailable and cleans temporary files', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vsh-clamav-unavailable-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const scanner = createClamDScanScanner({ executable: path.join(root, 'missing-clamdscan'), tempRoot: root, timeoutMs: 1000, maxBytes: 1024 });
  await assert.rejects(() => scanner.scan({ buffer: Buffer.from('scanner test'), fileName: 'safe.txt' }), { code: 'ERR_VIRGOSCORPIO_HUB_MALWARE_UNAVAILABLE' });
  assert.deepEqual(await fs.promises.readdir(root), []);
});

test('ClamAV scanner accepts only clean/detection exit codes and rejects scanner faults', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vsh-clamav-exit-codes-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const cleanScanner = createClamDScanScanner({ tempRoot: root, spawnProcess: completedScannerProcess(0), maxBytes: 1024 });
  assert.deepEqual(await cleanScanner.scan({ buffer: Buffer.from('clean content') }), {
    clean: true,
    status: 'clean',
    engine: 'clamdscan'
  });

  const detectionScanner = createClamDScanScanner({ tempRoot: root, spawnProcess: completedScannerProcess(1, 'stream: Eicar-Test-Signature FOUND'), maxBytes: 1024 });
  const detection = await detectionScanner.scan({ buffer: Buffer.from('test signature') });
  assert.equal(detection.clean, false);
  assert.equal(detection.status, 'infected');
  assert.match(detection.signature, /Eicar-Test-Signature/);

  const failedScanner = createClamDScanScanner({ tempRoot: root, spawnProcess: completedScannerProcess(2), maxBytes: 1024 });
  await assert.rejects(() => failedScanner.scan({ buffer: Buffer.from('scanner failure') }), {
    code: 'ERR_VIRGOSCORPIO_HUB_MALWARE_SCAN_FAILED'
  });
  assert.deepEqual(await fs.promises.readdir(root), []);
});

test('ClamAV timeout retains the private scan file until the child process closes', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vsh-clamav-timeout-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  let scanFile;
  let child;
  let releaseChildClose;
  let notifyKilled;
  const killed = new Promise(resolve => { notifyKilled = resolve; });
  const spawnProcess = (_executable, args, options) => {
    assert.equal(options.shell, false);
    scanFile = args[3];
    child = new EventEmitter();
    child.pid = 456;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = signal => {
      notifyKilled(signal);
      return true;
    };
    releaseChildClose = () => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, 'SIGKILL');
    };
    return child;
  };

  const scanner = createClamDScanScanner({ executable: 'clamdscan-test', tempRoot: root, timeoutMs: 100, maxBytes: 1024, spawnProcess });
  const scanPromise = scanner.scan({ buffer: Buffer.from('timeout test'), fileName: 'timeout.txt' });
  const rejection = assert.rejects(scanPromise, { code: 'ERR_VIRGOSCORPIO_HUB_MALWARE_TIMEOUT' });
  const signal = await killed;
  assert.equal(signal, 'SIGKILL');
  assert.ok(scanFile);
  assert.equal((await fs.promises.stat(scanFile)).isFile(), true, 'the scanner input remains available while the killed child is closing');

  let settled = false;
  scanPromise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the timeout result waits for child close before cleanup');
  assert.equal(fs.existsSync(path.dirname(scanFile)), true);

  releaseChildClose();
  await rejection;
  assert.equal(fs.existsSync(path.dirname(scanFile)), false);
  assert.deepEqual(await fs.promises.readdir(root), []);
});

test('cloud credential references fail closed unless the active SDK can resolve the intended identity', () => {
  assert.equal(resolveCloudCredentialReference({ provider: 'aws-s3', reference: 'vault://production/assets', env: {} }).ok, false);
  assert.equal(resolveCloudCredentialReference({ provider: 's3-compatible', reference: 'env://AWS_SECRET_ACCESS_KEY', env: { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret' } }).ok, true);
  assert.equal(resolveCloudCredentialReference({ provider: 's3-compatible', reference: 'env://CUSTOM_AWS_SECRET', env: { CUSTOM_AWS_SECRET: 'secret' } }).ok, false);
  assert.equal(resolveCloudCredentialReference({ provider: 'google-cloud-storage', reference: 'env://GOOGLE_APPLICATION_CREDENTIALS', env: { GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/gcp.json' } }).ok, true);
  assert.equal(resolveCloudCredentialReference({ provider: 'google-cloud-storage', reference: 'workload-identity:/virgoscorpio_hub', env: {} }).ok, true);
  assert.equal(resolveCloudCredentialReference({ provider: 'azure-blob', reference: 'workload-identity:/virgoscorpio_hub', env: {} }).ok, false);
});
