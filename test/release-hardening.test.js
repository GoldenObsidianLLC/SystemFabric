'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

test('library uploads are quarantined when no scanner is configured and do not become public', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sf-library-quarantine-'));
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
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sf-library-clean-'));
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

test('production library uploads fail closed when scanner is missing or reports a detection', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sf-library-failclosed-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const noScanner = createLibraryStore({ pool: poolForInsert(), root, requireMalwareScan: true });
  await assert.rejects(() => noScanner.upload({ siteId: 'site-one', category: 'image', dataBase64: png.toString('base64'), mimeType: 'image/png', fileName: 'bad.png' }), { code: 'ERR_SYSTEMFABRIC_MALWARE_SCANNER_REQUIRED' });
  const infected = createLibraryStore({ pool: poolForInsert(), root, requireMalwareScan: true, malwareScanner: { async scan() { return { clean: false, status: 'infected', signature: 'EICAR' }; } } });
  await assert.rejects(() => infected.upload({ siteId: 'site-one', category: 'image', dataBase64: png.toString('base64'), mimeType: 'image/png', fileName: 'bad.png' }), { code: 'ERR_SYSTEMFABRIC_MALWARE_DETECTED' });
  assert.deepEqual(await fs.promises.readdir(root), []);
});

test('local object reconciler defaults to dry-run, respects references and minimum age, and prevents traversal', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sf-library-reconcile-'));
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
  await assert.rejects(() => probeCloudStorageAdapter({ async probe() { throw new Error('secret account identifier'); } }), error => error.code === 'ERR_SYSTEMFABRIC_CLOUD_PROBE_FAILED' && !error.message.includes('secret account identifier'));
  await assert.rejects(() => probeCloudStorageAdapter({}), { code: 'ERR_SYSTEMFABRIC_CLOUD_PROBE_UNAVAILABLE' });
});


test('ClamAV scanner fails closed when the executable is unavailable and cleans temporary files', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sf-clamav-unavailable-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const scanner = createClamDScanScanner({ executable: path.join(root, 'missing-clamdscan'), tempRoot: root, timeoutMs: 1000, maxBytes: 1024 });
  await assert.rejects(() => scanner.scan({ buffer: Buffer.from('scanner test'), fileName: 'safe.txt' }), { code: 'ERR_SYSTEMFABRIC_MALWARE_UNAVAILABLE' });
  assert.deepEqual(await fs.promises.readdir(root), []);
});


test('cloud credential references fail closed unless the active SDK can resolve the intended identity', () => {
  assert.equal(resolveCloudCredentialReference({ provider: 'aws-s3', reference: 'vault://production/assets', env: {} }).ok, false);
  assert.equal(resolveCloudCredentialReference({ provider: 's3-compatible', reference: 'env://AWS_SECRET_ACCESS_KEY', env: { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret' } }).ok, true);
  assert.equal(resolveCloudCredentialReference({ provider: 's3-compatible', reference: 'env://CUSTOM_AWS_SECRET', env: { CUSTOM_AWS_SECRET: 'secret' } }).ok, false);
  assert.equal(resolveCloudCredentialReference({ provider: 'google-cloud-storage', reference: 'env://GOOGLE_APPLICATION_CREDENTIALS', env: { GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/gcp.json' } }).ok, true);
  assert.equal(resolveCloudCredentialReference({ provider: 'google-cloud-storage', reference: 'workload-identity:/systemfabric', env: {} }).ok, true);
  assert.equal(resolveCloudCredentialReference({ provider: 'azure-blob', reference: 'workload-identity:/systemfabric', env: {} }).ok, false);
});
