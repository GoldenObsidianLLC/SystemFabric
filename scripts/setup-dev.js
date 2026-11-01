'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile } = require('./load-env');

const root = path.resolve(__dirname, '..');
const envExample = path.join(root, '.env.example');
const envFile = path.join(root, '.env');

function updateEnvFile({ target = envFile, template = envExample } = {}) {
  // COPYFILE_EXCL is the atomic create guard; avoid an existsSync/copy TOCTOU.
  let created = false;
  try {
    fs.copyFileSync(template, target, fs.constants.COPYFILE_EXCL);
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  // Open once and operate exclusively through the resulting descriptor.
  // O_NOFOLLOW prevents symlink traversal on POSIX; Windows does not expose that
  // flag through Node's fs API, but descriptor-bound I/O still prevents path
  // replacement between the open and subsequent reads/writes from redirecting I/O.
  const descriptorFlags = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(target, descriptorFlags);
  try {
    const descriptorStats = fs.fstatSync(descriptor);
    if (!descriptorStats.isFile() || descriptorStats.nlink > 1) {
      throw new Error('.env must be a regular, single-link file; symbolic links are not accepted where O_NOFOLLOW is supported.');
    }

    // Environment files may contain credentials. On POSIX, constrain access
    // to the owning account before reading or updating them.
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);

    // Add test-only endpoints without replacing existing credentials/endpoints.
    let envText = fs.readFileSync(descriptor, 'utf8');
    const defaults = {
      TEST_DATABASE_URL: 'postgres://systemfabric:systemfabric_dev@127.0.0.1:5432/systemfabric_test',
      MEMGRAPH_TEST_URL: 'bolt://127.0.0.1:7687'
    };
    let changed = false;
    for (const [key, value] of Object.entries(defaults)) {
      const existing = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'm');
      if (!existing.test(envText)) { envText += `\n${key}=${value}`; changed = true; }
    }
    if (changed) {
      const nextText = Buffer.from(envText.replace(/\s*$/, '') + '\n', 'utf8');
      let written = 0;
      while (written < nextText.length) {
        const count = fs.writeSync(descriptor, nextText, written, nextText.length - written, written);
        if (count === 0) throw new Error('Unable to finish updating .env.');
        written += count;
      }
      fs.ftruncateSync(descriptor, nextText.length);
      fs.fsyncSync(descriptor);
    }
    return { created, changed };
  } finally {
    fs.closeSync(descriptor);
  }
}

function main() {
  const envUpdate = updateEnvFile({ target: envFile, template: envExample });
  if (envUpdate.created) console.log('Created .env from .env.example. Review the development-only values before use.');
  else console.log('.env already exists; preserving configured values.');

  fs.mkdirSync(path.join(root, 'artifacts', 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var', 'media'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var', 'library'), { recursive: true });
  loadEnvFile(envFile);

  console.log('Development folders are ready.');
  console.log('App DB:    configured=' + Boolean(process.env.DATABASE_URL));
  console.log('Test DB:   configured=' + Boolean(process.env.TEST_DATABASE_URL));
  console.log('Memgraph:  configured=' + Boolean(process.env.MEMGRAPH_URL));
  console.log('AI mode:   ' + (process.env.AI_PROVIDER || 'mock'));
  console.log('Safety:    external AI content remains opt-in; production secrets must never be copied here.');
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`Development setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { updateEnvFile };
