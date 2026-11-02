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

test('development environment update creates exclusively, limits permissions, and is idempotent', async () => {
  await withTempDirectory(async root => {
    const template = path.join(root, '.env.example');
    const target = path.join(root, '.env');
    await fs.promises.writeFile(template, 'APP_MODE=development\n');
    const first = updateEnvFile({ target, template });
    assert.deepEqual(first, { created: true, changed: true });

    const contents = await fs.promises.readFile(target, 'utf8');
    if (process.platform !== 'win32') {
      const stats = await fs.promises.stat(target);
      assert.equal(stats.mode & 0o777, 0o600);
    }
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

test('development environment update keeps writes bound to the opened file after path replacement', async t => {
  if (process.platform === 'win32') return t.skip('Open-file rename semantics differ on Windows.');
  await withTempDirectory(async root => {
    const template = path.join(root, '.env.example');
    const target = path.join(root, '.env');
    const displaced = path.join(root, '.env.original');
    await fs.promises.writeFile(template, 'APP_MODE=development\n');
    await fs.promises.writeFile(target, 'ORIGINAL=1\n');

    const originalOpenSync = fs.openSync;
    let swapped = false;
    fs.openSync = function patchedOpenSync(file, flags, ...args) {
      const descriptor = originalOpenSync.call(fs, file, flags, ...args);
      if (!swapped && file === target) {
        swapped = true;
        fs.renameSync(target, displaced);
        fs.writeFileSync(target, 'REPLACEMENT=1\n');
      }
      return descriptor;
    };

    try {
      updateEnvFile({ target, template });
    } finally {
      fs.openSync = originalOpenSync;
    }

    assert.equal(await fs.promises.readFile(target, 'utf8'), 'REPLACEMENT=1\n');
    const original = await fs.promises.readFile(displaced, 'utf8');
    assert.match(original, /^ORIGINAL=1$/m);
    assert.match(original, /^TEST_DATABASE_URL=/m);
    assert.match(original, /^MEMGRAPH_TEST_URL=/m);
  });
});

test('development environment update refuses symlinked env files where O_NOFOLLOW is supported', async t => {
  if (process.platform === 'win32' || !fs.constants.O_NOFOLLOW) return t.skip('O_NOFOLLOW is not exposed on this platform.');
  await withTempDirectory(async root => {
    const template = path.join(root, '.env.example');
    const target = path.join(root, '.env');
    const destination = path.join(root, 'external.env');
    await fs.promises.writeFile(template, 'APP_MODE=development\n');
    await fs.promises.writeFile(destination, 'DO_NOT_MODIFY=1\n');
    await fs.promises.symlink(destination, target);
    assert.throws(() => updateEnvFile({ target, template }), { code: 'ELOOP' });
    assert.equal(await fs.promises.readFile(destination, 'utf8'), 'DO_NOT_MODIFY=1\n');
  });
});

test('development environment update rejects non-regular env paths', async () => {
  await withTempDirectory(async root => {
    const template = path.join(root, '.env.example');
    const target = path.join(root, '.env');
    await fs.promises.writeFile(template, 'APP_MODE=development\n');
    await fs.promises.mkdir(target);
    assert.throws(() => updateEnvFile({ target, template }));
  });
});
