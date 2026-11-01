'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updateEnvFile } = require('../scripts/setup-dev');

async function withTempDirectory(run) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'systemfabric-dev-setup-'));
  try { await run(root); }
  finally { await fs.promises.rm(root, { recursive: true, force: true }); }
}

test('development environment update creates exclusively and is idempotent', async () => {
  await withTempDirectory(async root => {
    const template = path.join(root, '.env.example');
    const target = path.join(root, '.env');
    await fs.promises.writeFile(template, 'APP_MODE=development\n');
    const first = updateEnvFile({ target, template });
    assert.deepEqual(first, { created: true, changed: true });

    const contents = await fs.promises.readFile(target, 'utf8');
    assert.match(contents, /^APP_MODE=development$/m);
    assert.match(contents, /^TEST_DATABASE_URL=postgres:\/\/systemfabric:systemfabric_dev@127\.0\.0\.1:5432\/systemfabric_test$/m);
    assert.match(contents, /^MEMGRAPH_TEST_URL=bolt:\/\/127\.0\.0\.1:7687$/m);

    const second = updateEnvFile({ target, template });
    assert.deepEqual(second, { created: false, changed: false });
    assert.equal(await fs.promises.readFile(target, 'utf8'), contents);
  });
});

test('development environment update preserves existing credentials and configured test endpoints', async () => {
  await withTempDirectory(async root => {
    const template = path.join(root, '.env.example');
    const target = path.join(root, '.env');
    const existing = 'DATABASE_URL=postgres://private.example/production\nTEST_DATABASE_URL=postgres://custom-test\n';
    await fs.promises.writeFile(template, 'APP_MODE=development\n');
    await fs.promises.writeFile(target, existing);

    const result = updateEnvFile({ target, template });
    const contents = await fs.promises.readFile(target, 'utf8');
    assert.deepEqual(result, { created: false, changed: true });
    assert.ok(contents.startsWith(existing));
    assert.equal(contents.match(/^TEST_DATABASE_URL=/gm).length, 1);
    assert.match(contents, /^MEMGRAPH_TEST_URL=bolt:\/\/127\.0\.0\.1:7687$/m);
  });
});

test('development environment update refuses a path swapped after lstat', async () => {
  await withTempDirectory(async root => {
    const template = path.join(root, '.env.example');
    const target = path.join(root, '.env');
    const displaced = path.join(root, '.env.original');
    await fs.promises.writeFile(template, 'APP_MODE=development\n');
    await fs.promises.writeFile(target, 'ORIGINAL=1\n');

    const originalOpenSync = fs.openSync;
    fs.openSync = function patchedOpenSync(file, flags, ...args) {
      if (file === target && flags === 'r+') {
        fs.renameSync(target, displaced);
        fs.writeFileSync(target, 'REPLACEMENT=1\n');
      }
      return originalOpenSync.call(fs, file, flags, ...args);
    };

    try {
      assert.throws(
        () => updateEnvFile({ target, template }),
        /changed during secure open/
      );
    } finally {
      fs.openSync = originalOpenSync;
    }

    assert.equal(await fs.promises.readFile(target, 'utf8'), 'REPLACEMENT=1\n');
    assert.equal(await fs.promises.readFile(displaced, 'utf8'), 'ORIGINAL=1\n');
  });
});

test('development environment update rejects non-regular env paths', async () => {
  await withTempDirectory(async root => {
    const template = path.join(root, '.env.example');
    const target = path.join(root, '.env');
    await fs.promises.writeFile(template, 'APP_MODE=development\n');
    await fs.promises.mkdir(target);
    assert.throws(() => updateEnvFile({ target, template }), /regular, single-link file/);
  });
});
