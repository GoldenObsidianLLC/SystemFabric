'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const engine = require('../index');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enginex-manifest-'));
  await fs.mkdir(path.join(root, 'layouts'), { recursive: true });
  await fs.mkdir(path.join(root, 'partials'), { recursive: true });
  await fs.writeFile(path.join(root, 'layouts/base.html'), '<!doctype html><title>{{#block "title"}}Default{{/block}}</title><main>{{#block "body"}}Empty{{/block}}</main>');
  await fs.writeFile(path.join(root, 'partials/card.html'), '<b>{{ name }}</b>');
  await fs.writeFile(path.join(root, 'page.html'), '{{#extends "layouts/base.html"}}{{#block "title"}}Hello{{/block}}{{#block "body"}}{{#each users as user}}<p>{{> "partials/card.html" user}}</p>{{/each}}{{/block}}{{/extends}}');
  return root;
}

test('build/load manifest skips template source parsing at render and preserves includes/layouts', async t => {
  const root = await fixture();
  const output = path.join(root, 'manifest.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await engine.writeManifest(root, output, { entry: 'page.html' });
  const sourceLoaded = await engine.load('page.html', { views: root });
  const artifactLoaded = await engine.loadPrecompiled(output);
  const data = { users: [{ name: 'Ada & Lee' }, { name: 'Sam' }] };
  assert.equal(artifactLoaded.rendererKind, 'compiled-manifest');
  assert.equal(artifactLoaded.render(data), sourceLoaded.render(data));
  await fs.rm(path.join(root, 'page.html'));
  // The manifest is self-contained for templates, partials, and layouts.
  assert.equal(artifactLoaded.render(data), sourceLoaded.render(data));
});

test('precompiled manifest rejects unknown versions and unsafe paths', async t => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const badPath = path.join(root, 'bad.json');
  await fs.writeFile(badPath, JSON.stringify({ format: 'nope', engineVersion: engine.version, entry: 'page.html', templates: [], dependencies: [] }));
  await assert.rejects(engine.loadPrecompiled(badPath), { code: 'ERR_ENGINEX_MANIFEST_VERSION' });
  const pathPayload = path.join(root, 'path.json');
  await fs.writeFile(pathPayload, JSON.stringify({ format: 'enginex-precompiled-ast-v1', engineVersion: engine.version, entry: '../evil.html', templates: [], dependencies: [] }));
  await assert.rejects(engine.loadPrecompiled(pathPayload), { code: 'ERR_ENGINEX_MANIFEST_ENTRY' });
});
